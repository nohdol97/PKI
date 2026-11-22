// I03-T09, the storage half of R21 (retention) and R16 ②′ (a held collector): the
// delete of ended jobs past the retention, which keeps the given-up projection removals
// a rebuild has not closed; the release of the held jobs of one Connector instance for
// its own reasons; the targets that have held jobs; result counts written only under
// the lease. The handlers are backend's (maintenance.test.ts, connector-sync-job.test.ts).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { requeueHeldTarget } from "./job-actions.ts";
import { leaseNextJob, readJob, registerJob, type StoredJob } from "./jobs.ts";
import { purgeEndedJobs } from "./job-retention.ts";
import { migrate } from "./migrations.ts";
import { recordResultCounts } from "./projection-jobs.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-11-22T03:00:00.000Z");

let n = 0;
/** A sourceless job of `kind` in `status`, finished `ageDays` before NOW (open ones have no end). */
function job(kind: string, status: string, ageDays: number, target = `t${(n += 1)}`): StoredJob {
  const at = new Date(NOW - 40 * DAY);
  let source: { sourceId: number; fenceVersion: number } | undefined;
  if (kind === "projection-remove") {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const saved = saveSourceRecord(db, "c1", { externalId: `e${(n += 1)}`, title: "t", body: "b" });
    if (saved.status !== "created") throw new Error("expected a version");
    source = { sourceId: saved.sourceId, fenceVersion: saved.version };
  }
  const r = registerJob(db, { kind, target, at, ...source });
  if (!r.registered) throw new Error("expected a new job");
  const ended = ["succeeded", "superseded", "cancelled", "dead_letter"].includes(status);
  db.run("UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?", [
    status,
    ended ? NOW - ageDays * DAY : null,
    r.job.id,
  ]);
  return r.job;
}
const exists = (id: number) => readJob(db, id) !== undefined;

describe("retention (I03-R21): ended jobs past 30 days are deleted", () => {
  it("deletes succeeded, superseded, cancelled and dead_letter rows ended 31 days ago and keeps those ended 29 days ago", () => {
    const old = ["succeeded", "superseded", "cancelled", "dead_letter"].map((s) =>
      job("maintenance", s, 31),
    );
    const young = ["succeeded", "superseded", "cancelled", "dead_letter"].map((s) =>
      job("maintenance", s, 29),
    );
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(4);
    expect(old.map((j) => exists(j.id))).toEqual([false, false, false, false]);
    expect(young.map((j) => exists(j.id))).toEqual([true, true, true, true]);
  });

  it("spares the newest job row, so a deleted id is never issued again (jobs.id has no AUTOINCREMENT)", () => {
    const old = job("maintenance", "succeeded", 40);
    const newest = job("maintenance", "succeeded", 40);
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(1);
    expect(exists(old.id)).toBe(false);
    expect(exists(newest.id)).toBe(true);
    const next = job("maintenance", "queued", 0);
    expect(next.id).toBeGreaterThan(newest.id);
    // once a newer job exists the spared row goes with the next pass
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(1);
    expect(exists(newest.id)).toBe(false);
    expect(exists(next.id)).toBe(true);
  });

  it("keeps a row ended exactly 30 days ago: it is deleted once it is more than 30 days past", () => {
    const edge = job("maintenance", "succeeded", 30);
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(0);
    expect(exists(edge.id)).toBe(true);
  });

  it("never deletes an unfinished job, however old its registration", () => {
    const open = [
      ...["queued", "running", "retry", "held"].map((s) => job("maintenance", s, 90)),
      ...["queued", "running", "retry", "held"].map((s) => job("projection-remove", s, 90)),
    ];
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(0);
    expect(open.every((j) => exists(j.id))).toBe(true);
  });

  it("keeps a given-up projection removal, the mark a rebuild has not closed, whatever its age", () => {
    const mark = job("projection-remove", "dead_letter", 400, "engine");
    const rebuildDead = job("projection-rebuild", "dead_letter", 31, "engine");
    const closed = job("projection-remove", "superseded", 31, "vector");
    job("maintenance", "queued", 0); // a newer row: the newest one is always spared
    expect(purgeEndedJobs(db, NOW - 30 * DAY)).toBe(2);
    expect(exists(mark.id)).toBe(true);
    expect(exists(rebuildDead.id)).toBe(false);
    expect(exists(closed.id)).toBe(false);
  });
});

describe("collector hold release (I03-R16 ②′, storage)", () => {
  it("puts back the held jobs of one instance for the given reasons only, attempt unspent", () => {
    const mine = job("connector-sync", "held", 0, "a");
    db.run("UPDATE jobs SET reason = 'not-implemented', attempts = 0 WHERE id = ?", [mine.id]);
    const other = job("connector-sync", "held", 0, "b");
    db.run("UPDATE jobs SET reason = 'not-implemented' WHERE id = ?", [other.id]);
    const otherReason = job("connector-sync", "held", 0, "a2");
    db.run("UPDATE jobs SET reason = 'no-consent' WHERE id = ?", [otherReason.id]);
    const otherKind = job("extract-like", "held", 0, "a");
    db.run("UPDATE jobs SET reason = 'not-implemented' WHERE id = ?", [otherKind.id]);

    expect(
      requeueHeldTarget(db, {
        kind: "connector-sync",
        target: "a",
        reasons: ["not-implemented", "connector-unavailable"],
        at: new Date(NOW),
      }),
    ).toBe(1);
    expect(readJob(db, mine.id)).toMatchObject({ status: "queued", reason: null, attempts: 0 });
    expect(readJob(db, other.id)?.status).toBe("held");
    expect(readJob(db, otherReason.id)?.status).toBe("held");
    expect(readJob(db, otherKind.id)?.status).toBe("held");
  });
});

describe("result counts under the lease (I03-R2)", () => {
  it("writes counts for the holder of the lease and refuses a run that lost it", () => {
    registerJob(db, { kind: "connector-sync", target: "a", at: new Date(NOW) });
    const leased = leaseNextJob(db, {
      kinds: ["connector-sync"],
      now: new Date(NOW),
      leaseMs: 60_000,
      owner: "o",
    }) as StoredJob;
    recordResultCounts(db, leased.id, { created: 2 }, { leaseToken: leased.leaseToken + 1 });
    expect(readJob(db, leased.id)?.resultCounts).toBeNull();
    recordResultCounts(db, leased.id, { created: 2 }, { leaseToken: leased.leaseToken });
    expect(readJob(db, leased.id)?.resultCounts).toBe('{"created":2}');
  });

  it("writes by id alone when no lease is named (the rebuild's own write inside its close)", () => {
    const j = job("maintenance", "succeeded", 0);
    recordResultCounts(db, j.id, { purged: 1 });
    expect(readJob(db, j.id)?.resultCounts).toBe('{"purged":1}');
  });
});
