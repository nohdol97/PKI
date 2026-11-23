// The stand-in backend of the test app (I02B-C50, test code): a utility process the test main starts
// like the real backend. It answers the shell's `start`, then runs the scenario the test main names
// (`test-run`), asking for normalizer hosts through the backend's real adapter ⓑ file and the real
// isolated normalizer. Everything it learns goes to the test main as `test-log` records.
/* eslint-disable pki/module-boundary -- the time-bomb inputs are test code the package's entry does not export (a product bundle refuses them: bundle.ts), so this test file reaches them by path (I02B-C50) */
import { BOMB, makeTriggerXlsx } from "../../packages/document-normalize/src/testing/time-bombs.ts";
import { electronHostChannel } from "./normalizer-host-electron.ts";
import {
  createIsolatedNormalizer,
  normalizeDocument,
  type HostHandle,
  type HostSpawner,
  type IsolatedResult,
} from "@pki/document-normalize";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

interface ParentPort {
  on(event: "message", listener: (event: { data: unknown; ports?: unknown[] }) => void): void;
  postMessage(message: unknown): void;
}
const parent = (process as unknown as { parentPort: ParentPort }).parentPort;
const send = (message: unknown) => parent.postMessage(message);
const log = (record: object) => send({ type: "test-log", record });
const here = import.meta.dirname;

const hosts = electronHostChannel(send);

/** The adapter's spawner, with a note of what each host says about itself when it is up. */
function watchedSpawner(): { spawner: HostSpawner; hellos: unknown[] } {
  const hellos: unknown[] = [];
  return {
    hellos,
    spawner: {
      async spawn(): Promise<HostHandle> {
        const handle = await hosts.spawner.spawn();
        handle.onMessage((m) => {
          if (typeof m === "object" && m !== null && (m as { type?: string }).type === "ready") {
            hellos.push(m);
          }
        });
        return handle;
      },
    },
  };
}

const MARKDOWN = new TextEncoder().encode("# Title\n\nA paragraph of text.\n\n- one\n- two\n");
const job = (name: string, bytes = new Uint8Array()) => ({ bytes, name });
const brief = (r: IsolatedResult) =>
  r.ok
    ? { ok: true as const }
    : {
        ok: false as const,
        code: r.error.code,
        unexplainedDeath: r.unexplainedDeath === true,
      };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const LIMITS = { maxHeapMb: 256, maxExternalMemoryBytes: 512 * 1024 ** 2 };

async function basic() {
  const { spawner, hellos } = watchedSpawner();
  const normalizer = createIsolatedNormalizer({ spawner, timeoutMs: 1_000, ...LIMITS });
  const first = await normalizer.normalize(job("a.md", MARKDOWN));
  const direct = await normalizeDocument({ kind: "bytes", bytes: MARKDOWN, name: "a.md" });
  log({ type: "markdown", viaHost: first, direct, hello: hellos[0] ?? null });
  const t0 = Date.now();
  const loop = await normalizer.normalize(job(BOMB.loop));
  log({ type: "loop", result: brief(loop), ms: Date.now() - t0 });
  // the host that ended the job is a process that is gone
  send({ type: "test-hosts-gone" });
  await sleep(200);
  const next = await normalizer.normalize(job("b.md", MARKDOWN));
  log({ type: "after-loop", ok: next.ok, hellos: hellos.length });
  await normalizer.close();
}

async function productWorker() {
  const { spawner, hellos } = watchedSpawner();
  const normalizer = createIsolatedNormalizer({
    spawner,
    timeoutMs: 20_000,
    ...LIMITS,
  });
  const result = await normalizer.normalize(job("a.md", MARKDOWN));
  const direct = await normalizeDocument({ kind: "bytes", bytes: MARKDOWN, name: "a.md" });
  log({ type: "markdown", viaHost: result, direct, hello: hellos[0] ?? null });
  await normalizer.close();
}

async function killMidJob() {
  const { spawner, hellos } = watchedSpawner();
  const normalizer = createIsolatedNormalizer({ spawner, timeoutMs: 30_000, ...LIMITS });
  const running = normalizer.normalize(job(BOMB.wait));
  // kill the host from outside while the job runs, then again while the retry runs
  for (const round of [1, 2]) {
    while (hellos.length < round) await sleep(20);
    await sleep(300);
    send({ type: "test-kill-host" });
  }
  const result = await running;
  log({ type: "killed-twice", result: brief(result), hosts: hellos.length });
  const next = await normalizer.normalize(job("b.md", MARKDOWN));
  log({ type: "after-kill", ok: next.ok, hosts: hellos.length });
  await normalizer.close();
}

async function flood() {
  const settled = await Promise.allSettled(
    Array.from({ length: 100 }, () => hosts.spawner.spawn()),
  );
  log({
    type: "flood",
    requests: settled.length,
    resolved: settled.filter((s) => s.status === "fulfilled").length,
    rejected: settled.filter((s) => s.status === "rejected").length,
  });
  hosts.close();
  await sleep(500);
}

async function badRequests() {
  // requests that carry more than a number, or a number that is not one: none may start a host
  for (const request of [
    { type: "normalizer-host-start", id: 1, entry: "/bin/sh" },
    { type: "normalizer-host-start", id: 2, args: ["--inspect"] },
    { type: "normalizer-host-start", id: 3, env: { A: "1" } },
    { type: "normalizer-host-start", id: 0 },
    { type: "normalizer-host-start", id: -1 },
    { type: "normalizer-host-start", id: "4" },
    { type: "normalizer-host-start" },
  ]) {
    send(request);
  }
  await sleep(1_000);
  log({ type: "bad-requests-sent", count: 7 });
  // and one proper request starts exactly one
  const handle = await hosts.spawner.spawn();
  log({ type: "proper-request", ok: handle !== undefined });
}

async function heapFill() {
  const { spawner } = watchedSpawner();
  const normalizer = createIsolatedNormalizer({
    spawner,
    timeoutMs: 60_000,
    maxHeapMb: 128,
    maxExternalMemoryBytes: LIMITS.maxExternalMemoryBytes,
  });
  const t0 = Date.now();
  const result = await normalizer.normalize(job(BOMB.heap));
  log({ type: "heap-fill", result: brief(result), ms: Date.now() - t0 });
  const next = await normalizer.normalize(job("b.md", MARKDOWN));
  log({ type: "after-heap-fill", ok: next.ok });
  await normalizer.close();
}

/** G23: the trigger XLSX's heap use inside Electron's V8, read from outside the worker every 20 ms. */
async function g23() {
  const bytes = makeTriggerXlsx();
  for (const maxHeapMb of [512, 1_536]) {
    const worker = new Worker(join(here, "isolated-worker.js"), {
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
      workerData: { progress: new SharedArrayBuffer(16), maxExternalMemoryBytes: 1 },
    });
    let peakUsed = 0;
    let peakTotal = 0;
    let peakExternal = 0;
    const outcome = new Promise<string>((resolve) => {
      worker.on("message", (m: { type: string; result?: { ok: boolean } }) => {
        // the worker says `up` first; the result is the message after the job
        if (m.type === "result") resolve(m.result?.ok ? "finished-ok" : "finished-error");
      });
      worker.once("error", (e: Error & { code?: string }) => resolve(`error:${e.code ?? e.name}`));
    });
    worker.postMessage({ type: "job", id: 1, bytes, name: "trigger.xlsx" });
    let done = false;
    void outcome.then(() => (done = true));
    while (!done) {
      await sleep(20);
      const stats = await worker.getHeapStatistics().catch(() => undefined);
      if (stats === undefined) continue;
      peakUsed = Math.max(peakUsed, stats.used_heap_size);
      peakTotal = Math.max(peakTotal, stats.total_heap_size);
      peakExternal = Math.max(peakExternal, stats.external_memory);
    }
    const MiB = 1024 ** 2;
    log({
      type: "g23",
      maxHeapMb,
      outcome: await outcome,
      peakUsedHeapMiB: Math.round(peakUsed / MiB),
      peakTotalHeapMiB: Math.round(peakTotal / MiB),
      peakExternalMiB: Math.round(peakExternal / MiB),
      fileMiB: Math.round((bytes.length / MiB) * 10) / 10,
    });
    await worker.terminate();
  }
}

/** Positive control for the path check: a host started here with `child_process.fork` says something else. */
async function forkControl() {
  const { fork } = await import("node:child_process");
  const child = fork(join(here, "host.js"), [], {
    execPath: process.execPath,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const hello = await new Promise<unknown>((resolve) => {
    child.once("message", resolve);
    child.send({ type: "init", ...LIMITS, externalPollMs: 250, timeoutMs: 10_000 });
    setTimeout(() => resolve(null), 10_000);
  });
  child.kill("SIGKILL");
  log({ type: "fork-control", hello });
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  "fork-control": forkControl,
  basic,
  "product-worker": productWorker,
  "kill-mid-job": killMidJob,
  flood,
  "bad-requests": badRequests,
  "heap-fill": heapFill,
  g23,
  // the backend dies while a host is up: the test main kills it and counts the hosts left
  "backend-kill": async () => {
    await hosts.spawner.spawn();
    log({ type: "host-up" });
    send({ type: "test-kill-backend" });
    await sleep(60_000);
  },
};

let started = false;
parent.on("message", ({ data, ports }) => {
  if (hosts.deliver(data, ports ?? [])) return;
  const message = data as { type?: string; scenario?: string; token?: string };
  if (message.type === "start" && !started) {
    started = true;
    send({ type: "ready", port: 1 });
  } else if (message.type === "stop") {
    hosts.close();
    process.exit(0);
  } else if (message.type === "test-run" && message.scenario !== undefined) {
    const run = SCENARIOS[message.scenario];
    void (run?.() ?? Promise.reject(new Error("unknown scenario")))
      .catch((error: unknown) => log({ type: "scenario-failed", error: String(error) }))
      .finally(() => {
        send({ type: "test-hosts" });
        if (message.scenario !== "backend-kill") send({ type: "test-done" });
      });
  }
});
