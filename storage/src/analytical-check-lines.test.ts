// S03-T05 `check.job` / `check.staleness` (storage part): the registration of the `analytical-check` job, the
// reach from an item to the table sources behind it, and the check lines with their currentness (S03-R11,
// R12). All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { registerAnalyticalCheckJob } from "./analytical.ts";
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import { listCheckLines, saveCheckLine, tableSourcesOf } from "./analytical-check-lines.ts";
import { ANALYTICAL_CHECK_JOB_KIND } from "./job-kinds.ts";
import { leaseNextJob, transitionJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const AT = new Date("2026-11-23T00:00:00.000Z");
const jobs = () =>
  db.all("SELECT source_id, fence_version, target, status FROM jobs WHERE kind = ? ORDER BY id", [
    ANALYTICAL_CHECK_JOB_KIND,
  ]);

describe("registerAnalyticalCheckJob", () => {
  it("check.job: registers a job fenced to the source's current version, and none for a source with no bound table or a covered source", () => {
    const bound = storeVersion(db, "bound");
    const bare = storeVersion(db, "bare");
    const covered = storeVersion(db, "covered");
    dataset(db, "d1", bound.sourceId);
    dataset(db, "d3", covered.sourceId);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, 't', 'user-deleted')",
      [covered.sourceId, covered.version],
    );
    expect(registerAnalyticalCheckJob(db, bound.sourceId, AT)).toBe(true);
    expect(registerAnalyticalCheckJob(db, bare.sourceId, AT)).toBe(false);
    expect(registerAnalyticalCheckJob(db, covered.sourceId, AT)).toBe(false);
    expect(registerAnalyticalCheckJob(db, 9999, AT)).toBe(false);
    expect(jobs()).toEqual([
      {
        source_id: bound.sourceId,
        fence_version: bound.version,
        target: "run:1",
        status: "queued",
      },
    ]);
  });

  it("check.job: a second registration while one is queued makes none; after that job runs or while it runs, it makes a new one on the same version", () => {
    const a = storeVersion(db, "a");
    dataset(db, "d1", a.sourceId);
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(true);
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(false);
    // running: it may have read the old state, so a new one is queued
    const running = leaseNextJob(db, {
      kinds: [ANALYTICAL_CHECK_JOB_KIND],
      now: AT,
      leaseMs: 60_000,
    });
    expect(running?.status).toBe("running");
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(true);
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(false);
    // the first ends, the second is still open; once it ends too a third is made
    expect(
      transitionJob(db, running?.id as number, { from: "running", to: "succeeded", at: AT }),
    ).toBe(true);
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(false);
    const second = leaseNextJob(db, {
      kinds: [ANALYTICAL_CHECK_JOB_KIND],
      now: AT,
      leaseMs: 60_000,
    });
    transitionJob(db, second?.id as number, { from: "running", to: "succeeded", at: AT });
    expect(registerAnalyticalCheckJob(db, a.sourceId, AT)).toBe(true);
    expect(jobs().map((j) => [j.target, j.status])).toEqual([
      ["run:1", "succeeded"],
      ["run:2", "succeeded"],
      ["run:3", "queued"],
    ]);
  });
});

describe("tableSourcesOf", () => {
  it("check.job: follows the Dataset itself, MEASURED_ON, JOIN_LEFT/RIGHT and USES_JOIN→JOIN_*; a rejected or superseded relation is not followed; a Metric that reaches no table gives none", () => {
    const s1 = storeVersion(db, "s1");
    const s2 = storeVersion(db, "s2");
    const s3 = storeVersion(db, "s3");
    const d1 = dataset(db, "d1", s1.sourceId);
    const d2 = dataset(db, "d2", s2.sourceId);
    const d3 = dataset(db, "d3", s3.sourceId);
    const join = item(db, "Join", "j");
    const metric = item(db, "Metric", "m");
    const bare = item(db, "Metric", "bare");
    relation(db, join, "JOIN_LEFT", d1);
    relation(db, join, "JOIN_RIGHT", d2);
    relation(db, metric, "MEASURED_ON", d3);
    expect(tableSourcesOf(db, d1)).toEqual([s1.sourceId]);
    expect(tableSourcesOf(db, join)).toEqual([s1.sourceId, s2.sourceId]);
    expect(tableSourcesOf(db, metric)).toEqual([s3.sourceId]);
    expect(tableSourcesOf(db, bare)).toEqual([]);
    // through the used Join (two written joins, no recursion)
    relation(db, metric, "USES_JOIN", join);
    expect(tableSourcesOf(db, metric)).toEqual(
      [s1.sourceId, s2.sourceId, s3.sourceId].sort((a, b) => a - b),
    );
    // a rejected or superseded relation reaches nothing
    const only = item(db, "Metric", "only");
    relation(db, only, "MEASURED_ON", d1, "rejected");
    expect(tableSourcesOf(db, only)).toEqual([]);
    relation(db, only, "MEASURED_ON", d2, "superseded");
    expect(tableSourcesOf(db, only)).toEqual([]);
    // a path relation of another type is no path
    relation(db, bare, "USES_JOIN", item(db, "Join", "empty-join"));
    expect(tableSourcesOf(db, bare)).toEqual([]);
  });
});

describe("analytical_checks lines", () => {
  it("check.staleness: a line is current only while each version it read is its source's latest and uncovered", () => {
    const a = storeVersion(db, "a");
    const b = storeVersion(db, "b");
    const d = dataset(db, "d", a.sourceId);
    const f = fact(db, d, "dataset.grain", '["x"]');
    line(db, f, "grain", a.versionId, b.versionId);
    const current = () => listCheckLines(db, f).map((l) => l.current);
    expect(current()).toEqual([true]);
    // a new version of the version_id's source
    const a2 = storeVersion(db, "a");
    expect(a2.sourceId).toBe(a.sourceId);
    expect(current()).toEqual([false]);
    line(db, f, "grain", a2.versionId, b.versionId);
    expect(current()).toEqual([true]);
    // a new version of the other_version_id's source
    storeVersion(db, "b");
    expect(current()).toEqual([false]);
    // a tombstone covering the version read
    line(db, f, "grain", a2.versionId);
    expect(current()).toEqual([true]);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, 't', 'user-deleted')",
      [a.sourceId, a2.version],
    );
    expect(current()).toEqual([false]);
  });

  it("saveCheckLine keeps one line per (fact, check) and stores codes and counts only", () => {
    const a = storeVersion(db, "a");
    const d = dataset(db, "d", a.sourceId);
    const f = fact(db, d, "dataset.grain", '["x"]');
    const base = {
      factId: f,
      check: "grain",
      versionId: a.versionId,
      otherVersionId: null,
    } as const;
    saveCheckLine(db, {
      ...base,
      passed: true,
      failure: null,
      examined: 5,
      violations: 0,
      skipped: 1,
      at: "t1",
    });
    saveCheckLine(db, {
      ...base,
      passed: false,
      failure: "grain-duplicate",
      examined: 6,
      violations: 2,
      skipped: 0,
      at: "t2",
    });
    expect(db.all("SELECT * FROM analytical_checks")).toEqual([
      {
        id: expect.any(Number),
        fact_id: f,
        check_name: "grain",
        passed: 0,
        failure_code: "grain-duplicate",
        examined: 6,
        violations: 2,
        skipped: 0,
        version_id: a.versionId,
        other_version_id: null,
        checked_at: "t2",
      },
    ]);
    expect(listCheckLines(db, f)).toEqual([
      {
        id: expect.any(Number),
        check: "grain",
        passed: false,
        failure: "grain-duplicate",
        examined: 6,
        violations: 2,
        skipped: 0,
        versionId: a.versionId,
        otherVersionId: null,
        at: "t2",
        current: true,
      },
    ]);
  });
});
