/* eslint-disable pki/module-boundary -- a throwaway measurement script that reaches into the packages' sources on purpose (I02B-T01) */
// I02B-T01 PoC (throwaway): the one worker entry every measurement uses. `workerData.mode`
// picks what it does. Bytes in, a message out; it never opens a path (I02B-R22).
import { normalizeDocument } from "../../../packages/document-normalize/src/index.ts";
import { randomFillSync } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";

interface Data {
  mode:
    | "loop"
    | "normalize"
    | "mem-js"
    | "mem-buffer"
    | "mem-sync"
    | "self-report"
    | "native-sqlite"
    | "native-wasm"
    | "idle";
  capMiB?: number;
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
} else if (data.mode === "mem-sync" || data.mode === "self-report") {
  // keeps allocating Buffers in one synchronous loop (no await, no message handling), and
  // spins at the cap so the worker stays busy for as long as the parent wants to look at it
  if (data.mode === "self-report") {
    setInterval(
      () => port.postMessage({ type: "self", external: process.memoryUsage().external }),
      50,
    );
  }
  const keep: Buffer[] = [];
  const cap = (data.capMiB ?? 3072) * 1024 ** 2;
  let total = 0;
  for (;;) {
    if (total < cap) {
      const b = Buffer.allocUnsafe(16 * 1024 ** 2);
      b.fill(1);
      keep.push(b);
      total += b.length;
    }
  }
} else if (data.mode === "native-sqlite") {
  // memory V8 does not account for: SQLite's own malloc inside node:sqlite (no native addon)
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (b BLOB)");
  const insert = db.prepare("INSERT INTO t VALUES (randomblob(1048576))");
  const cap = data.capMiB ?? 1024;
  for (let i = 1; i <= cap; i++) {
    insert.run();
    if (i % 64 === 0) port.postMessage({ type: "grew", mib: i });
  }
  port.postMessage({ type: "grew", mib: cap });
  setInterval(() => undefined, 1000); // keep the worker alive
} else if (data.mode === "native-wasm") {
  // WebAssembly memory
  const memories: WebAssembly.Memory[] = [];
  const cap = (data.capMiB ?? 1024) / 64;
  for (let i = 1; i <= cap; i++) {
    const m = new WebAssembly.Memory({ initial: 1024 }); // 64 MiB
    new Uint8Array(m.buffer).fill(1);
    memories.push(m);
    port.postMessage({ type: "grew", mib: i * 64 });
  }
  setInterval(() => undefined, 1000); // keep the worker alive
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
