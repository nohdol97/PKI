/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway), B2/B3: the entry a child process (child_process.fork, the same with
// ELECTRON_RUN_AS_NODE, or an Electron utility process) runs. It hosts the normalizer and takes
// jobs over the parent channel. Jobs:
//   normalize    bytes in, a result summary out
//   bomb-main    allocate Buffers in a synchronous loop on this (main) thread up to capMiB, then spin
//   bomb-gauged  run the Buffer bomb in a worker; this main thread polls the worker's
//                external_memory every 250 ms and exits the process (code 3) over limitMiB
import { getHeapStatistics } from "node:v8";
import { Worker } from "node:worker_threads";
import { normalizeDocument } from "../../../packages/document-normalize/src/index.ts";

interface Port {
  send(m: unknown): void;
  onMessage(l: (m: Job) => void): void;
}
type Job =
  | { type: "job"; id: number; kind: "normalize"; bytes: Uint8Array; name: string }
  | {
      type: "job";
      id: number;
      kind: "normalize-in-worker";
      bytes: Uint8Array;
      heapMb: number;
      workerFile: string;
    }
  | { type: "job"; id: number; kind: "bomb-main"; capMiB: number }
  | {
      type: "job";
      id: number;
      kind: "bomb-gauged";
      capMiB: number;
      limitMiB: number;
      workerFile: string;
    };

const parentPort = (
  process as unknown as {
    parentPort?: {
      postMessage(m: unknown): void;
      on(e: "message", l: (e: { data: Job }) => void): void;
    };
  }
).parentPort;
const port: Port = parentPort
  ? {
      send: (m) => parentPort.postMessage(m),
      onMessage: (l) => parentPort.on("message", (e) => l(e.data)),
    }
  : {
      send: (m) => void process.send?.(m),
      onMessage: (l) => void process.on("message", (m) => l(m as Job)),
    };

port.onMessage((job) => {
  void handle(job);
});
port.send({
  type: "ready",
  versions: { node: process.versions.node, electron: process.versions.electron ?? null },
  heapLimitMiB: Math.round(getHeapStatistics().heap_size_limit / 1024 ** 2),
  execArgv: process.execArgv,
});

async function handle(job: Job): Promise<void> {
  if (job.kind === "normalize") {
    const r = await normalizeDocument({ kind: "bytes", bytes: job.bytes, name: job.name });
    port.send({
      type: "result",
      id: job.id,
      ok: r.ok,
      detail: r.ok
        ? { format: r.document.format, textChars: r.document.text.length }
        : { code: r.error.code },
    });
  } else if (job.kind === "normalize-in-worker") {
    // the child hosts the normalizer in a worker with a V8 heap limit; if that worker dies
    // cleanly the child reports it, if V8 aborts the process the parent sees the exit signal
    const w = new Worker(job.workerFile, {
      workerData: { mode: "normalize", bytes: job.bytes, name: "big.xlsx" },
      resourceLimits: { maxOldGenerationSizeMb: job.heapMb },
    });
    w.on("message", (m: { type: string; ok?: boolean; detail?: unknown }) => {
      if (m.type === "result")
        port.send({ type: "result", id: job.id, ok: m.ok, detail: m.detail });
    });
    w.on("error", (e: Error & { code?: string }) =>
      port.send({ type: "worker-error", id: job.id, code: e.code ?? e.name }),
    );
  } else if (job.kind === "bomb-main") {
    const keep: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (total < job.capMiB * 1024 ** 2) {
        const b = Buffer.allocUnsafe(16 * 1024 ** 2);
        b.fill(1);
        keep.push(b);
        total += b.length;
      }
    }
  } else {
    const w = new Worker(job.workerFile, { workerData: { mode: "mem-sync", capMiB: job.capMiB } });
    await new Promise((r) => w.once("message", r));
    const t0 = performance.now();
    let peak = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      peak = Math.max(peak, (await w.getHeapStatistics()).external_memory);
      if (peak > job.limitMiB * 1024 ** 2) {
        port.send({
          type: "limit",
          id: job.id,
          peakExternalMiB: peak / 1024 ** 2,
          atMs: performance.now() - t0,
        });
        setTimeout(() => process.exit(3), 50);
        return;
      }
    }
  }
}
