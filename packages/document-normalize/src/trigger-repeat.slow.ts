// I02B-C49 (I02B-R22, R23): the trigger input, repeated. The XLSX that aborted a whole process at a 512 MB
// worker heap (I02B-T01, G19) goes into the isolated normalizer 30 times with `maxHeapMb` 512, one
// process per time (`testing/trigger-backend.ts` plays the backend). Pass: 30 of 30 backend processes end
// by themselves with exit code 0, report `resource-exceeded` for the XLSX and normalize the next small
// file. The test must be able to go red: the same 30 times with the worker inside the backend process
// itself (no boundary) are counted too. If that variant never aborts, the result here is `판정 불가`
// (undetermined), not a pass: in that environment the boundary changes nothing the test can see.
// Not a `.test.ts`: one run takes 6 to 36 s, so `pnpm test` does not run it. Run it with
//   pnpm exec vitest run --config vitest.normalizer-slow.config.ts
// and write the date, the commit and both counts in the PR (I02B-C49).
import { fork } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CHILD = fileURLToPath(new URL("./testing/trigger-backend.ts", import.meta.url));
/** When set, every run and the summary are appended here as lines of JSON (the console of a passing test is not kept). */
const LOG = process.env.PKI_SLOW_LOG;
const note = (line: object) => {
  if (LOG !== undefined) appendFileSync(LOG, `${JSON.stringify(line)}\n`);
};
const RUNS = 30;
const HEAP_MB = 512;

interface Ended {
  code: number | null;
  signal: NodeJS.Signals | null;
  report: Record<string, unknown> | undefined;
  /** V8's own abort text on the process's standard error: `FATAL ERROR: ... heap limit ...`. */
  fatal: string;
}

function runOnce(mode: "isolated" | "in-process", heapMb = HEAP_MB): Promise<Ended> {
  return new Promise((resolve) => {
    const child = fork(CHILD, [mode, String(heapMb)], {
      execArgv: [],
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let fatal = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      fatal ||= /FATAL ERROR[^\n]*/.exec(chunk.toString())?.[0] ?? "";
    });
    let report: Record<string, unknown> | undefined;
    child.on("message", (m) => (report = m as Record<string, unknown>));
    child.once("exit", (code, signal) => {
      note({ mode, code, signal, fatal, report, at: new Date().toISOString() });
      resolve({ code, signal, report, fatal });
    });
  });
}

async function repeat(mode: "isolated" | "in-process") {
  const ends: Ended[] = [];
  for (let i = 0; i < RUNS; i++) ends.push(await runOnce(mode));
  return ends;
}

describe("I02B-C49: the trigger input, 30 times at maxHeapMb 512", () => {
  it("with the host: the backend process lives 30 of 30, maps the result and normalizes the next file; without it: counted", async (context) => {
    const withHost = await repeat("isolated");
    const lived = withHost.filter((e) => e.code === 0 && e.signal === null).length;
    const mapped = withHost.filter(
      (e) => e.report?.first === "resource-exceeded" && e.report.second === true,
    ).length;
    const unexplained = withHost.filter((e) => e.report?.unexplainedDeath === true).length;
    const without = await repeat("in-process");
    // aborted: the process ended without a word, by a signal or by V8's own fatal heap abort; a process
    // that ended some other way (a crash of the test's own script) is counted apart and is not an abort
    const aborted = without.filter(
      (e) => e.report === undefined && (e.signal !== null || e.fatal !== ""),
    ).length;
    const otherEnds = without.filter(
      (e) => e.report === undefined && e.signal === null && e.fatal === "",
    ).length;
    const finished = without.filter((e) => e.report?.first === "ok").length;
    const summary =
      `C49 at ${new Date().toISOString()}: with the host: backend alive ${lived}/${RUNS}, ` +
      `resource-exceeded and the next file normalized ${mapped}/${RUNS} (host aborted without a word in ${unexplained}); ` +
      `without the boundary: process aborted ${aborted}/${RUNS} (other ends without a word: ${otherEnds}), worker finished the file ${finished}/${RUNS}, ` +
      `fatal lines ${JSON.stringify([...new Set(without.map((e) => e.fatal).filter(Boolean))])}, ` +
      `signals ${JSON.stringify(without.map((e) => e.signal).filter((s) => s !== null))}`;
    console.log(summary);
    note({ summary });
    expect(lived, summary).toBe(RUNS);
    expect(mapped, summary).toBe(RUNS);
    if (aborted === 0) context.skip(`판정 불가: ${summary}`);
    expect(aborted, summary).toBeGreaterThanOrEqual(1);
  });

  it("the no-boundary script reports what its worker did: with a heap large enough the file is normalized", async () => {
    // guards the variant against counting its own script's crash as an abort
    const end = await runOnce("in-process", 2_048);
    expect(end.report, JSON.stringify(end)).toEqual({ first: "ok" });
    expect(end.code).toBe(0);
  });
});
