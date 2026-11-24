// H03-C2 (docs/specs/2026-11-24-H03-C2-measure-runner.md): the measurement runner at a small size. The runner starts
// the real backend as a child process with the stub Provider, so one run is a few seconds. The default-size run
// (eval/results/h03-c2-dev.json) is checked in the last case; the forced-kill phase is system-measure.kill.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import {
  assertNoFailedExtract,
  cleanOnSignal,
  failedJobCounts,
  hasResumed,
  idleConditionLine,
  resultPath,
  rssCaveat,
  runMeasurement,
  SYSTEM_THRESHOLDS,
  validateResult,
  type MeasurementResult,
  tallyKnowledge,
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

  const job = (id: number, kind: string, status: string, attempts = 1) =>
    ({ id, kind, status, attempts }) as never;
  const jobsOf = (list: unknown[], counts: Record<string, number> = {}) =>
    ({ jobs: list, counts, truncated: false }) as never;

  it("H03C2F-C1: counts lost and duplicate knowledge from evidence rows, and failedJobs only for extract jobs", () => {
    expect(
      tallyKnowledge({ docs: 3, notSearchable: 0, evidence: 4, itemsNamed: 1, failedExtract: 0 }),
    ).toEqual({
      lostDocs: 0,
      duplicateItems: 1,
    });
    expect(
      tallyKnowledge({ docs: 3, notSearchable: 0, evidence: 2, itemsNamed: 1, failedExtract: 0 }),
    ).toEqual({
      lostDocs: 1,
      duplicateItems: 0,
    });
    const jobs = jobsOf([job(1, "extract", "dead_letter"), job(2, "reindex", "superseded")]);
    expect(failedJobCounts(jobs)).toEqual({ dead_letter: 1 });
  });

  it("H03C2F-C2: resumes only on a new attempt, not on a job that finished without one", () => {
    const snapshot = new Map([[1, 1]]);
    expect(hasResumed(snapshot, jobsOf([job(1, "extract", "succeeded", 1)]))).toBe(false);
    expect(hasResumed(snapshot, jobsOf([job(1, "extract", "running", 2)]))).toBe(true);
  });

  it("H03C2F-C3: a newly dead-lettered extract job ends the measurement with an error", () => {
    expect(() =>
      assertNoFailedExtract(jobsOf([job(1, "extract", "succeeded")]), "doc-1"),
    ).not.toThrow();
    expect(() =>
      assertNoFailedExtract(jobsOf([job(1, "extract", "dead_letter")]), "doc-1"),
    ).toThrow(/doc-1.*dead_letter/);
  });

  it("H03C2F-C4: states the idle conditions and what was not measured", () => {
    const { metrics, unverified } = run.result;
    if (metrics.idleCpu.status !== "measured" || metrics.idleRss.status !== "measured")
      throw new Error("idle not measured");
    expect(metrics.idleCpu.openJobs).toBe(0);
    expect(metrics.idleRss.openJobs).toBe(0);
    const items = unverified.map((u) => u.item).join("\n");
    for (const part of ["per document", "per question", "per day", "embedding"]) {
      expect(items).toContain(part);
    }
    expect(items).not.toContain("idle with open jobs");
    if (process.platform === "darwin") expect(metrics.idleRss.note).toContain("compressed");
    expect(rssCaveat("darwin")).toContain("compressed");
    expect(rssCaveat("linux")).toBeUndefined();
    expect(idleConditionLine(140)?.reason).toContain("140");
    expect(idleConditionLine(0)).toBeUndefined();
  });

  it("H03C2F-C5: the validator names an unexplained not-measured metric and a null failedJobs; the committed result still passes", () => {
    const copy = structuredClone(run.result) as MeasurementResult;
    copy.unverified = copy.unverified.filter((u) => u.item !== "forced kill and recovery");
    expect(validateResult(copy).join("\n")).toContain("killRecover");
    const killed = structuredClone(run.result) as unknown as Record<string, unknown>;
    (killed.metrics as Record<string, unknown>).killRecover = {
      ...(run.result.metrics.killRecover as object),
      status: "measured",
      failedJobs: null,
    };
    expect(validateResult(killed).join("\n")).toContain("failedJobs");
  });

  it("H03C2F-C6: refuses an existing result file without --force and an unsafe name", () => {
    const dir = mkdtempSync(join(tmpdir(), "pki-c6-"));
    try {
      writeFileSync(join(dir, "x.json"), "keep");
      expect(() => resultPath(dir, "x", false)).toThrow(/exists/);
      expect(readFileSync(join(dir, "x.json"), "utf8")).toBe("keep");
      expect(resultPath(dir, "x", true)).toBe(join(dir, "x.json"));
      expect(() => resultPath(dir, "../x", true)).toThrow(/name/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// HVT (docs/specs/2026-11-24-HVT-h03-verification-tools.md): pure checks, no measurement run.
describe("HVT (system-measure)", () => {
  const job = (id: number, kind: string, status: string) =>
    ({ id, kind, status, attempts: 1 }) as never;

  it("HVT-C1: a failed extract is subtracted from the expected evidence, so a loss and a duplicate no longer cancel", () => {
    expect(
      tallyKnowledge({ docs: 3, notSearchable: 0, evidence: 3, itemsNamed: 1, failedExtract: 1 }),
    ).toEqual({ lostDocs: 1, duplicateItems: 1 });
    expect(
      tallyKnowledge({ docs: 3, notSearchable: 0, evidence: 4, itemsNamed: 1, failedExtract: 0 }),
    ).toEqual({ lostDocs: 0, duplicateItems: 1 });
    expect(
      tallyKnowledge({ docs: 3, notSearchable: 0, evidence: 2, itemsNamed: 1, failedExtract: 0 }),
    ).toEqual({ lostDocs: 1, duplicateItems: 0 });
  });

  it("HVT-C2: a truncated list counts the hidden failures but not a visible other kind", () => {
    const jobs = (list: unknown[], counts: Record<string, number>) =>
      ({ jobs: list, counts, truncated: true }) as never;
    expect(failedJobCounts(jobs([job(1, "maintenance", "superseded")], { superseded: 1 }))).toEqual(
      {},
    );
    expect(failedJobCounts(jobs([], { dead_letter: 2 }))).toEqual({ dead_letter: 2 });
  });

  it("HVT-C3: the validator rejects a null or empty knowledge block and accepts its absence", () => {
    const base = JSON.parse(readFileSync(join(ROOT, "eval/results/h03-c2-dev.json"), "utf8"));
    const withKnowledge = (knowledge: unknown) => {
      const copy = structuredClone(base);
      copy.metrics.killRecover = { ...copy.metrics.killRecover, knowledge };
      return validateResult(copy).join("\n");
    };
    expect(validateResult(base)).toEqual([]);
    expect(withKnowledge(null)).toContain("knowledge");
    expect(withKnowledge({})).toContain("knowledge.facts");
  });

  it("HVT-C4: a throwing cleanup still detaches the signal listeners", () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const before = process.listenerCount(signal);
      const finish = cleanOnSignal(() => {
        throw new Error("rm failed");
      });
      expect(process.listenerCount(signal)).toBe(before + 1);
      expect(() => finish()).toThrow("rm failed");
      expect(process.listenerCount(signal)).toBe(before);
    }
  });
});
