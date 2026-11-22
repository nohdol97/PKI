/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway): the one worker entry every measurement uses. `workerData.mode`
// picks what it does. Bytes in, a message out; it never opens a path (I02B-R22).
import { normalizeDocument } from "../../../packages/document-normalize/src/index.ts";
import { randomFillSync } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

interface Data {
  mode: "loop" | "normalize" | "mem-js" | "mem-buffer" | "idle";
  bytes?: Uint8Array;
  name?: string;
  stepMiB?: number;
  stepMs?: number;
  /** how the Buffers are touched: constant bytes (compressible) or random bytes (not) */
  fill?: "ones" | "random";
}
const data = workerData as Data;
if (parentPort === null) throw new Error("worker-entry is a worker file");
const port = parentPort;
port.postMessage({ type: "started" });

if (data.mode === "loop") {
  for (;;) {
    // a synchronous loop that never yields to the event loop
  }
} else if (data.mode === "normalize") {
  const result = await normalizeDocument({
    kind: "bytes",
    bytes: data.bytes ?? new Uint8Array(),
    ...(data.name === undefined ? {} : { name: data.name }),
  });
  port.postMessage({
    type: "result",
    ok: result.ok,
    detail: result.ok
      ? { format: result.document.format, textChars: result.document.text.length }
      : { code: result.error.code },
  });
} else if (data.mode === "mem-js") {
  // grows the V8 heap: arrays of fresh objects
  const keep: object[][] = [];
  for (;;) {
    keep.push(Array.from({ length: 100_000 }, (_, i) => ({ i, s: `x${i}` })));
    port.postMessage({ type: "grew", mib: keep.length });
  }
} else if (data.mode === "mem-buffer") {
  // holds memory outside the V8 heap: Buffers, touched so the pages are resident
  const keep: Buffer[] = [];
  const step = (data.stepMiB ?? 64) * 1024 ** 2;
  for (;;) {
    const b = Buffer.allocUnsafe(step);
    if (data.fill === "random") randomFillSync(b);
    else b.fill(1);
    keep.push(b);
    port.postMessage({ type: "grew", mib: keep.length * (data.stepMiB ?? 64) });
    await new Promise((r) => setTimeout(r, data.stepMs ?? 20));
  }
} else {
  // idle: loaded and waiting
  await new Promise(() => undefined);
}
