// I02B-T01 PoC (throwaway), G1 + G13: does `worker.terminate()` end a worker that is stuck in
// a synchronous loop within 1 s? Cases: the test loop, the slow Markdown, the PDF bomb.
// Time = from the `terminate()` call until its promise resolves (the worker is gone).
// Usage: node g1-terminate.ts [loopReps mdReps pdfReps pdfInflatedBytes]
import { Worker } from "node:worker_threads";
import { makePdfBomb, makeSlowMarkdown } from "./repro-inputs.ts";

export interface Stats {
  n: number;
  min: number;
  median: number;
  max: number;
}
export function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    median: s[Math.floor(s.length / 2)] ?? NaN,
    max: s.at(-1) ?? NaN,
  };
}

export interface TerminateRun {
  /** the worker was still running (not exited, no result) when terminate() was called */
  stillBusy: boolean;
  terminateMs: number;
  exitCode: number;
}

export async function terminateOnce(
  workerFile: string | URL,
  workerData: object,
  busyMs: number,
): Promise<TerminateRun> {
  const worker = new Worker(workerFile, { workerData });
  let finished = false;
  worker.on("message", (m: { type: string }) => {
    if (m.type === "result") finished = true;
  });
  const exited = new Promise<number>((r) => worker.once("exit", r));
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  await new Promise((r) => setTimeout(r, busyMs));
  const stillBusy = !finished;
  const t0 = performance.now();
  await worker.terminate();
  const terminateMs = performance.now() - t0;
  return { stillBusy, terminateMs, exitCode: await exited };
}

export async function g1Cases(
  workerFile: string | URL,
  reps: { loop: number; md: number; pdf: number },
  pdfInflated: number,
  log: (line: string) => void,
): Promise<void> {
  const cases: [string, object, number, number][] = [
    ["loop", { mode: "loop" }, 300, reps.loop],
    [
      "markdown-24KB",
      { mode: "normalize", bytes: makeSlowMarkdown(), name: "x.md" },
      1500,
      reps.md,
    ],
  ];
  if (reps.pdf > 0) {
    const pdf = await makePdfBomb(pdfInflated);
    log(`pdf input: ${pdf.length} bytes, inflates to ${pdfInflated}`);
    cases.push(["pdf-bomb", { mode: "normalize", bytes: pdf, name: "x.pdf" }, 1500, reps.pdf]);
  }
  for (const [label, data, busyMs, n] of cases) {
    const runs: TerminateRun[] = [];
    for (let i = 0; i < n; i++) runs.push(await terminateOnce(workerFile, data, busyMs));
    const s = stats(runs.map((r) => r.terminateMs));
    log(
      `${label}: n=${s.n} terminate ms min=${s.min.toFixed(1)} median=${s.median.toFixed(1)} max=${s.max.toFixed(1)} ` +
        `stillBusyAtTerminate=${runs.filter((r) => r.stillBusy).length}/${n} exitCodes=${[...new Set(runs.map((r) => r.exitCode))].join(",")} ` +
        `within1s=${runs.every((r) => r.terminateMs < 1000)}`,
    );
  }
}

// run as a script only when this file is the entry (not when bundled into another entry)
if (import.meta.main && import.meta.filename.endsWith("g1-terminate.ts")) {
  const [loop = "20", md = "10", pdf = "5", inflated = String(3 * 1024 ** 3)] =
    process.argv.slice(2);
  console.log(`node ${process.version} ${process.platform}-${process.arch}`);
  await g1Cases(
    new URL("./worker-entry.ts", import.meta.url),
    { loop: Number(loop), md: Number(md), pdf: Number(pdf) },
    Number(inflated),
    (l) => console.log(l),
  );
}
