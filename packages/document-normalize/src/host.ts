// The normalizer host program (I02B-R22, R23): the entry file of the separate process the backend
// reuses between jobs. It starts when loaded, as a process entry, so only a spawn adapter runs it.
// Inside it one worker thread runs the normalizer under a V8 heap limit (`resourceLimits`). This main
// thread stays idle while the worker is busy, so it keeps the clock and reads the worker's external
// memory (`worker.getHeapStatistics()`), and every limit it enforces ends the whole process.
// The parent is either Node (`child_process.fork`, an IPC channel) or Electron's main process
// (`utilityProcess.fork`, which hands over a message port as the first message). The host leaves when
// that channel closes, so a dead backend leaves no host behind.
// Arguments come from the parent only: `--worker <file>` names another worker file (the tests'
// time-bomb workers); none runs the product's worker next to this file.
import { fileURLToPath, pathToFileURL } from "node:url";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import {
  parseToHost,
  type FromHost,
  type HostConfig,
  type HostJob,
  type HostLimitCode,
  type ParentKind,
  type WorkerJob,
  type WorkerReply,
  type WorkerUp,
} from "./host-protocol.ts";

interface Channel {
  post(message: FromHost): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
}

interface Port {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  on(event: "close", listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
}
interface ParentPort {
  once(event: "message", listener: (event: { ports: Port[] }) => void): void;
}

const electronParent = (process as { parentPort?: ParentPort }).parentPort;
const parentKind: ParentKind = electronParent
  ? "electron-main"
  : process.send
    ? "node-ipc"
    : "none";

function openChannel(): Promise<Channel> {
  if (electronParent) {
    // the first message from Electron's main process carries the port to the backend
    return new Promise((resolve) => {
      electronParent.once("message", ({ ports }) => {
        const port = ports[0];
        if (port === undefined) return process.exit(1);
        port.start();
        resolve({
          post: (m) => port.postMessage(m),
          onMessage: (l) => port.on("message", (e) => l(e.data)),
          onClose: (l) => port.on("close", l),
        });
      });
    });
  }
  if (process.send) {
    return Promise.resolve({
      post: (m) => void process.send?.(m),
      onMessage: (l) => void process.on("message", l),
      onClose: (l) => void process.on("disconnect", l),
    });
  }
  throw new Error("the normalizer host needs a parent channel");
}

function workerFile(): URL {
  const at = process.argv.indexOf("--worker");
  const named = at < 0 ? undefined : process.argv[at + 1];
  if (named !== undefined) return pathToFileURL(named);
  // the source runs as .ts; the bundle writes .js next to this file
  return new URL(`./isolated-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);
}

interface Active {
  id: number;
  timer: NodeJS.Timeout;
  done: boolean;
}

const channel = await openChannel();
channel.onClose(() => process.exit(0));

let config: HostConfig | undefined;
let worker: Worker | undefined;
let active: Active | undefined;
/** [bytes taken so far, when the test worker crossed the memory limit]: a test worker's record only. */
const progress = new BigInt64Array(new SharedArrayBuffer(16));

/** Ends the job and then the process: every limit event ends the host (I02B-R23). */
function end(code: HostLimitCode) {
  const job = active;
  if (job === undefined || job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  const crossedAtMs = Number(Atomics.load(progress, 1));
  channel.post({
    type: "limit",
    id: job.id,
    code,
    ...(crossedAtMs > 0 ? { diag: { crossedAtMs, seenAtMs: Date.now() } } : {}),
  });
  // the message needs a moment to leave; the backend ends this process too, as soon as it has it
  setTimeout(() => process.exit(0), 100);
}

function startWorker(settings: HostConfig): Worker {
  const next = new Worker(workerFile(), {
    resourceLimits: { maxOldGenerationSizeMb: settings.maxHeapMb },
    workerData: {
      progress: progress.buffer,
      maxExternalMemoryBytes: settings.maxExternalMemoryBytes,
    },
  });
  next.on("message", (reply: WorkerReply | WorkerUp) => {
    // the worker has loaded the normalizer: only now is the host ready, so a slow load is not a job's time
    if (reply.type === "up") {
      return channel.post({
        type: "ready",
        processType: (process as { type?: string }).type ?? null,
        parentKind,
      });
    }
    if (active === undefined || active.done || reply.id !== active.id) return;
    active.done = true;
    clearTimeout(active.timer);
    channel.post({ type: "result", id: reply.id, result: reply.result });
    active = undefined;
  });
  // out of V8 heap is an expected limit; any other worker error is a failure that is not memory
  next.on("error", (error: Error & { code?: string }) =>
    end(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "resource-exceeded" : "worker-failed"),
  );
  // a worker that ends by itself, idle or busy, is not worth keeping a host around for
  next.on("exit", () => (active === undefined ? process.exit(0) : end("worker-failed")));
  return next;
}

/** While the worker normalizes, reads its external memory; over the limit ends the host. */
async function watchExternalMemory(job: Active, settings: HostConfig, watched: Worker) {
  while (!job.done) {
    await new Promise((resolve) => setTimeout(resolve, settings.externalPollMs));
    if (job.done) return;
    const stats = await watched.getHeapStatistics().catch(() => undefined);
    if (stats !== undefined && stats.external_memory > settings.maxExternalMemoryBytes) {
      return end("resource-exceeded");
    }
  }
}

function run(job: HostJob, settings: HostConfig) {
  worker ??= startWorker(settings);
  const watched = worker;
  const current: Active = {
    id: job.id,
    done: false,
    // the host's own clock: the worker may be in a loop that never yields (I02B-R23)
    timer: setTimeout(() => end("timed-out"), settings.timeoutMs),
  };
  active = current;
  const message: WorkerJob = { ...job, type: "job" };
  watched.postMessage(message);
  void watchExternalMemory(current, settings, watched);
}

channel.onMessage((data) => {
  const message = parseToHost(data);
  if (message === undefined) return;
  if (message.type === "init") {
    if (config !== undefined) return;
    config = {
      maxHeapMb: message.maxHeapMb,
      maxExternalMemoryBytes: message.maxExternalMemoryBytes,
      externalPollMs: message.externalPollMs,
      timeoutMs: message.timeoutMs,
    };
    worker = startWorker(config);
    return;
  }
  // a job before the settings, or while another runs, is a backend bug: the backend queues
  if (config === undefined || active !== undefined) return process.exit(1);
  run(message, config);
});
