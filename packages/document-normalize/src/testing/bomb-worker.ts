// The test worker of the normalizer host (I02B-R25, test code): the same protocol as
// `isolated-worker.ts`, plus jobs named in `BOMB` that never end or fill memory, so every limit of the
// host is proven without a parser. Any other name is an ordinary file. Handed to the host with
// `--worker <this file>`; the product host never runs it.
import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import { normalizeDocument } from "../normalize.ts";
import type { WorkerJob, WorkerReply, WorkerUp } from "../host-protocol.ts";
import { BOMB } from "./time-bombs.ts";

if (parentPort === null) throw new Error("bomb-worker is a worker file");
const port = parentPort;
const { progress, maxExternalMemoryBytes } = workerData as {
  progress: SharedArrayBuffer;
  maxExternalMemoryBytes: number;
};
const record = new BigInt64Array(progress);

port.on("message", (job: WorkerJob) => {
  if (job.name === BOMB.loop) {
    for (;;) {
      // never yields
    }
  } else if (job.name === BOMB.heap) {
    const keep: object[][] = [];
    for (;;) keep.push(Array.from({ length: 100_000 }, (_, i) => ({ i, s: `x${i}` })));
  } else if (job.name === BOMB.external) {
    // the amount taken so far and the moment it passed the limit go where the host can read them
    const keep: Buffer[] = [];
    let total = 0;
    for (;;) {
      if (total < maxExternalMemoryBytes * 3) {
        const block = Buffer.allocUnsafe(16 * 1024 ** 2);
        block.fill(1);
        keep.push(block);
        total += block.length;
        Atomics.store(record, 0, BigInt(total));
        // the crossing is recorded in the quantity the host reads (this isolate's external_memory,
        // which also holds the worker's own baseline), not in this loop's own total
        if (
          getHeapStatistics().external_memory > maxExternalMemoryBytes &&
          Atomics.load(record, 1) === 0n
        ) {
          Atomics.store(record, 1, BigInt(Date.now()));
        }
      }
    }
  } else if (job.name === BOMB.error) {
    throw new Error("test worker error");
  } else if (job.name === BOMB.wait) {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      // busy for a minute unless the host ends it
    }
  } else {
    void normalizeDocument({
      kind: "bytes",
      bytes: job.bytes,
      name: job.name,
      ...(job.format === undefined ? {} : { format: job.format }),
    }).then((result) => {
      const reply: WorkerReply = { type: "result", id: job.id, result };
      port.postMessage(reply);
    });
  }
});

port.postMessage({ type: "up" } satisfies WorkerUp);
