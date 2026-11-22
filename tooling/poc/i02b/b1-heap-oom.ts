// I02B-T01 PoC (throwaway), B1: one PROCESS = one trial. The trigger XLSX goes to a worker whose
// V8 old-space limit is <heapMb>; the line printed says how the worker ended. If the whole
// process aborts, nothing is printed after the start line and the caller sees exit code 134.
// Usage: node b1-heap-oom.ts <xlsxFile> <heapMb>
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";

const [file, heapArg] = process.argv.slice(2);
if (!file || !heapArg) throw new Error("usage: b1-heap-oom.ts <xlsxFile> <heapMb>");
const heapMb = Number(heapArg);
const bytes = new Uint8Array(readFileSync(file));
const MiB = 1024 ** 2;
console.log(`start heapMb=${heapMb} bytes=${bytes.length}`);
const w = new Worker(new URL("./worker-entry.ts", import.meta.url), {
  workerData: { mode: "normalize", bytes, name: "big.xlsx" },
  resourceLimits: { maxOldGenerationSizeMb: heapMb },
});
let result: string | undefined;
let error: string | undefined;
let peakExt = 0;
let peakHeap = 0;
w.on("message", (m: { type: string; ok?: boolean; detail?: unknown }) => {
  if (m.type === "result") result = JSON.stringify({ ok: m.ok, detail: m.detail });
});
w.on("error", (e: Error & { code?: string }) => (error = `${e.code ?? e.name}`));
const exited = new Promise<number>((r) => w.once("exit", r));
const t0 = performance.now();
let alive = true;
void exited.then(() => (alive = false));
await Promise.race([new Promise((r) => w.once("message", r)), exited]);
while (alive) {
  try {
    const h = await w.getHeapStatistics();
    peakExt = Math.max(peakExt, h.external_memory);
    peakHeap = Math.max(peakHeap, h.used_heap_size);
  } catch {
    break;
  }
  await new Promise((r) => setTimeout(r, 5));
}
const code = await exited;
console.log(
  `end worker-exit-code=${code} error=${error ?? "none"} result=${result ?? "none"} seconds=${((performance.now() - t0) / 1000).toFixed(1)} peakExternalMiB=${(peakExt / MiB).toFixed(1)} peakUsedHeapMiB=${(peakHeap / MiB).toFixed(1)}`,
);
