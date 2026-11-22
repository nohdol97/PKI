// I03-T10, the storage half of R7 (projection jobs): the marker query ("끝나지 않았거나
// 포기한 projection-remove", "1시간 넘게 막힌 것"), the rebuild's cover of removals up to
// the change sequence it read, the latest canonical version a stale removal is re-sent
// with, and the kinds that carry no version fence. The handlers are backend's
// (projection-jobs.test.ts: `projection.*`).
import { seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { closeJob, leaseNextJob, readJob, registerJob, type StoredJob } from "./jobs.ts";
import { usesVersionFence } from "./job-kinds.ts";
import { migrate } from "./migrations.ts";
import {
  closeCoveredRemoves,
  latestCanonicalVersion,
  markedProjections,
  recordResultCounts,
  REMOVE_BLOCKED_AFTER_MS,
} from "./projection-jobs.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const HOUR = 60 * 60_000;

let n = 0;
/** A source with one version, deleted (tombstone), and its projection-remove job registered after. */
function removal(target: string, at = T0): StoredJob {
  const saved = saveSourceRecord(db, "c1", { externalId: `e${(n += 1)}`, title: "t", body: "b" });
  if (saved.status !== "created") throw new Error("expected a version");
  seedLegacyTombstone(db, {
    sourceId: saved.sourceId,
    version: saved.version,
    at: "x",
    reason: "user-deleted",
  });
  const r = registerJob(db, {
    kind: "projection-remove",
    target,
    sourceId: saved.sourceId,
    fenceVersion: saved.version,
    at: new Date(at),
  });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}
const status = (id: number) => readJob(db, id)?.status;
const setStatus = (id: number, to: string) =>
  db.run("UPDATE jobs SET status = ? WHERE id = ?", [to, id]);

describe("projection.markers (storage)", () => {
  it("at start every open or given-up removal marks its projection, however young", () => {
    const young = removal("engine", T0);
    const dead = removal("vector");
    setStatus(dead.id, "dead_letter");
    const done = removal("other");
    setStatus(done.id, "succeeded");
    const covered = removal("third");
    setStatus(covered.id, "superseded");
    expect(markedProjections(db, { phase: "start" }).sort()).toEqual(["engine", "vector"]);
    expect(young.status).toBe("queued");
  });

  it("at a check a given-up removal marks it and an open one only after an hour", () => {
    const young = removal("engine", T0 - REMOVE_BLOCKED_AFTER_MS + 60_000); // 59 minutes old
    const old = removal("vector", T0 - REMOVE_BLOCKED_AFTER_MS - 1); // an hour and a millisecond
    const dead = removal("graph", T0);
    setStatus(dead.id, "dead_letter");
    expect(markedProjections(db, { phase: "check", now: T0 }).sort()).toEqual(["graph", "vector"]);
    expect(status(young.id)).toBe("queued");
    expect(status(old.id)).toBe("queued");
  });

  it("an hour exactly is not over an hour", () => {
    removal("engine", T0 - HOUR);
    expect(markedProjections(db, { phase: "check", now: T0 })).toEqual([]);
    expect(markedProjections(db, { phase: "check", now: T0 + 1 })).toEqual(["engine"]);
  });

  it("only removals mark: a rebuild or an extract that is open or dead does not", () => {
    const rebuild = registerJob(db, {
      kind: "projection-rebuild",
      target: "engine",
      at: new Date(T0 - 2 * HOUR),
    });
    if (!rebuild.registered) throw new Error("expected a job");
    setStatus(rebuild.job.id, "dead_letter");
    expect(markedProjections(db, { phase: "start" })).toEqual([]);
    expect(markedProjections(db, { phase: "check", now: T0 })).toEqual([]);
  });
});

describe("projection.rebuild-race (storage cover)", () => {
  it("closes the target's open and dead removals up to the sequence read, as covered-by-rebuild, and nothing else", () => {
    const queued = removal("engine");
    const dead = removal("engine");
    setStatus(dead.id, "dead_letter");
    const retry = removal("engine");
    setStatus(retry.id, "retry");
    const other = removal("vector"); // another projection
    const done = removal("engine");
    setStatus(done.id, "succeeded");
    const cancelled = removal("engine");
    setStatus(cancelled.id, "cancelled");
    const seqRead = Number(db.all("SELECT change_seq AS s FROM revisions")[0]?.s);
    const later = removal("engine"); // registered after the read: its tombstone raised the sequence
    expect(readJob(db, later.id)?.registeredChangeSeq).toBeGreaterThan(seqRead);

    const closed = closeCoveredRemoves(db, "engine", seqRead, new Date(T0));
    expect(closed).toBe(3);
    for (const job of [queued, dead, retry]) {
      expect(readJob(db, job.id)).toMatchObject({
        status: "superseded",
        reason: "covered-by-rebuild",
        finishedAt: T0,
      });
    }
    expect(status(other.id)).toBe("queued");
    expect(status(later.id)).toBe("queued");
    expect(status(done.id)).toBe("succeeded");
    expect(status(cancelled.id)).toBe("cancelled");
  });

  it("covers a removal registered at exactly the sequence read, not one past it", () => {
    const job = removal("engine");
    const seqAt = readJob(db, job.id)?.registeredChangeSeq as number;
    expect(closeCoveredRemoves(db, "engine", seqAt - 1, new Date(T0))).toBe(0);
    expect(closeCoveredRemoves(db, "engine", seqAt, new Date(T0))).toBe(1);
  });

  it("takes a running removal's lease away: its holder's close writes nothing", () => {
    const job = removal("engine");
    const claimed = leaseNextJob(db, {
      kinds: ["projection-remove"],
      now: new Date(T0),
      leaseMs: HOUR,
    });
    expect(claimed?.id).toBe(job.id);
    closeCoveredRemoves(db, "engine", Number.MAX_SAFE_INTEGER, new Date(T0));
    expect(
      closeJob(db, claimed as StoredJob, { status: "succeeded", write: () => undefined }),
    ).toBe("not-leased");
    expect(status(job.id)).toBe("superseded");
  });

  it("records the rebuild's result counts as numbers only", () => {
    const rebuild = registerJob(db, { kind: "projection-rebuild", target: "engine" });
    if (!rebuild.registered) throw new Error("expected a job");
    recordResultCounts(db, rebuild.job.id, { readSeq: 7, covered: 2 });
    expect(JSON.parse(readJob(db, rebuild.job.id)?.resultCounts as string)).toEqual({
      covered: 2,
      readSeq: 7,
    });
    expect(() => recordResultCounts(db, rebuild.job.id, { readSeq: -1 })).toThrow(RangeError);
    expect(() => recordResultCounts(db, rebuild.job.id, { x: 1.5 })).toThrow(RangeError);
  });
});

describe("projection.stale-reissue (storage latest version)", () => {
  it("is the highest version number the source reached: its latest stored, or its tombstone's cover once all are purged", () => {
    const saved = saveSourceRecord(db, "c1", { externalId: "lv", title: "t", body: "1" });
    if (saved.status !== "created") throw new Error("expected a version");
    saveSourceRecord(db, "c1", { externalId: "lv", title: "t", body: "2" });
    expect(latestCanonicalVersion(db, saved.sourceId)).toBe(2);
    seedLegacyTombstone(db, {
      sourceId: saved.sourceId,
      version: 2,
      at: "x",
      reason: "user-deleted",
    });
    db.run("DELETE FROM source_versions WHERE source_id = ?", [saved.sourceId]);
    expect(latestCanonicalVersion(db, saved.sourceId)).toBe(2);
  });
});

describe("projection.no-source-fence (storage)", () => {
  it("the two projection kinds carry no version fence; every other kind does", () => {
    expect(usesVersionFence("projection-remove")).toBe(false);
    expect(usesVersionFence("projection-rebuild")).toBe(false);
    for (const kind of ["extract", "connector-sync", "maintenance", "test-effect"]) {
      expect(usesVersionFence(kind)).toBe(true);
    }
  });

  it("closeJob closes a removal of a purged source succeeded, not superseded by the fence", () => {
    const job = removal("engine");
    db.run("DELETE FROM source_versions"); // the deletion purged every version
    const claimed = leaseNextJob(db, {
      kinds: ["projection-remove"],
      now: new Date(T0),
      leaseMs: HOUR,
    });
    expect(claimed?.id).toBe(job.id);
    expect(
      closeJob(
        db,
        claimed as StoredJob,
        { status: "succeeded", write: () => undefined, reason: "adapter-unavailable" },
        new Date(T0),
      ),
    ).toBe("succeeded");
    expect(readJob(db, job.id)).toMatchObject({
      status: "succeeded",
      reason: "adapter-unavailable",
    });
  });
});
