// I02B-T01 PoC (throwaway), G13: can the two reproduction inputs be rebuilt by a function,
// and does each really run long without a limit (the I02B-C17 guard: under 5 s means the input
// got weaker)? The unbounded run happens in a worker so the main thread can time and give up.
// Usage: node g13-regenerate.ts <md|pdf> [reps] [pdfInflatedBytes] [capSeconds]
import { Worker } from "node:worker_threads";
import { makePdfBomb, makeSlowMarkdown, sha256 } from "./repro-inputs.ts";

const [which = "md", repsArg = "3", inflatedArg = String(3 * 1024 ** 3), capArg = "1200"] =
  process.argv.slice(2);
const reps = Number(repsArg);
const cap = Number(capArg);
console.log(`node ${process.version} ${process.platform}-${process.arch}`);

const bytes = which === "md" ? makeSlowMarkdown() : await makePdfBomb(Number(inflatedArg));
const again = which === "md" ? makeSlowMarkdown() : await makePdfBomb(Number(inflatedArg));
console.log(
  `${which}: bytes=${bytes.length} sha256=${sha256(bytes)} rebuilt-identical=${sha256(bytes) === sha256(again)}`,
);

const seconds: number[] = [];
for (let i = 0; i < reps; i++) {
  const t0 = performance.now();
  const worker = new Worker(new URL("./worker-entry.ts", import.meta.url), {
    workerData: { mode: "normalize", bytes, name: which === "md" ? "x.md" : "x.pdf" },
  });
  const outcome = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(`gave up after ${cap} s`), cap * 1000);
    worker.on("message", (m: { type: string; ok?: boolean; detail?: unknown }) => {
      if (m.type === "result") {
        clearTimeout(timer);
        resolve(`finished ok=${m.ok} ${JSON.stringify(m.detail)}`);
      }
    });
    worker.on("error", (e) => {
      clearTimeout(timer);
      resolve(`worker error ${String(e)}`);
    });
  });
  const s = (performance.now() - t0) / 1000;
  seconds.push(s);
  console.log(`run ${i + 1}: ${s.toFixed(1)} s ${outcome}`);
  await worker.terminate();
}
const sorted = [...seconds].sort((a, b) => a - b);
console.log(
  `${which}: n=${sorted.length} seconds min=${(sorted[0] ?? NaN).toFixed(1)} median=${(sorted[Math.floor(sorted.length / 2)] ?? NaN).toFixed(1)} max=${(sorted.at(-1) ?? NaN).toFixed(1)} over5s=${sorted.every((s) => s > 5)}`,
);
