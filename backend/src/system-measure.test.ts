// H03-C2 (docs/specs/2026-11-24-H03-C2-measure-runner.md): the measurement runner at a small size. The runner starts
// the real backend as a child process with the stub Provider, so one run is a few seconds. The default-size run
// (eval/results/h03-c2-dev.json) is checked in the last case; the forced-kill phase is system-measure.kill.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import {
  runMeasurement,
  SYSTEM_THRESHOLDS,
  validateResult,
  type MeasurementResult,
  type MeasurementRun,
} from "./system-measure.test-support.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const SMALL = { sources: 6, queries: 5, warmup: 2, idleSeconds: 1, soakSeconds: 0, skipKill: true };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("system-measure (H03-C2)", () => {
  let run: MeasurementRun;
  let callRows = -1;
  beforeAll(async () => {
    run = await runMeasurement({
      ...SMALL,
      onBeforeCleanup: (dataDir) => {
        const db = openCanonicalDb(dataDir);
        try {
          callRows = (db.all("SELECT count(*) AS n FROM provider_calls")[0] as { n: number }).n;
        } finally {
          db.close();
        }
      },
    });
  }, 120_000);

  it("C1: writes a valid version-1 result that names its stub and its thresholds, judges nothing, and leaves nothing behind", () => {
    const { result } = run;
    expect(validateResult(result)).toEqual([]);
    expect(result.schemaVersion).toBe(1);
    expect(result.provider.kind).toBe("stub");
    expect(result.mode).toBe("source-run");
    expect(JSON.stringify(result)).not.toMatch(/"(pass|passed|fail|failed|verdict)"/);
    // the threshold texts are EVALUATION 4.4's, line for line
    const evaluation = readFileSync(join(ROOT, "docs/EVALUATION.md"), "utf8");
    for (const row of Object.values(SYSTEM_THRESHOLDS)) {
      expect(evaluation).toContain(`| ${row.label} | ${row.text} |`);
    }
    expect(result.unverified.map((u) => u.item)).toEqual(
      expect.arrayContaining([
        "installer size",
        "Windows 11 installed build",
        "real Provider",
        "multi-hour soak",
        "forced kill and recovery",
        "soak run",
      ]),
    );
    expect(run.trace.pids.length).toBeGreaterThan(0);
    for (const pid of run.trace.pids) expect(alive(pid)).toBe(false);
    expect(existsSync(run.trace.workDir)).toBe(false);
  });

  it("C2: counts the Provider calls the product recorded and the raw bytes it was given", () => {
    const { metrics } = run.result;
    expect(metrics.llmCalls.status).toBe("measured");
    if (metrics.llmCalls.status !== "measured") return;
    expect(metrics.llmCalls.total).toBe(callRows);
    expect(callRows).toBeGreaterThanOrEqual(SMALL.sources);
    if (metrics.storage.status !== "measured") throw new Error("storage not measured");
    const raw = metrics.storage.points.map((p) => p.rawBytes);
    expect(raw.at(-1)).toBe(run.trace.rawBytes);
    expect(raw).toEqual([...raw].sort((a, b) => a - b));
  });

  it("C2: stops with an error, timing nothing, when a query's own document is not in its results", async () => {
    await expect(
      runMeasurement({ ...SMALL, sources: 2, queries: 2, warmup: 0, queryFor: () => "zzabsentzz" }),
    ).rejects.toThrow(/not in the results/);
  }, 120_000);

  it("C4: the committed default-size run passes the same validator and measured the forced kill", () => {
    const committed = JSON.parse(
      readFileSync(join(ROOT, "eval/results/h03-c2-dev.json"), "utf8"),
    ) as MeasurementResult;
    expect(validateResult(committed)).toEqual([]);
    expect(committed.mode).toBe("source-run");
    expect(committed.metrics.killRecover.status).toBe("measured");
    expect(committed.args).toMatchObject({ sources: 200, queries: 220, idleSeconds: 30 });
  });
});
