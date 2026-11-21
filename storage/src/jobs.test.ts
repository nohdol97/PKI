// V01-R6 job records: the Broker reads a job to decide that a call is background.
// V02-R3: a job carries its source and the version it was registered for (the fence).
// V02-R4: registered once per kind, source and version, claimed with a lease that
// expires. V02-R5: a result is written only while the fence version is still the
// source's latest and no tombstone covers it; otherwise the job closes superseded.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { closeJob, leaseNextJob, readJob, registerJob, type StoredJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { writeTombstone } from "./tombstones.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "b" });
});

afterEach(() => {
  db.close();
});

const T0 = new Date("2026-11-21T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE = 60_000;

function registered(kind = "extract", sourceId = 1, fenceVersion = 1): StoredJob {
  const r = registerJob(db, { kind, sourceId, fenceVersion });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

const lease = (now = T0, kinds: readonly string[] = ["extract"]) =>
  leaseNextJob(db, { kinds, now, leaseMs: LEASE });

const newVersion = (body: string) =>
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body });

describe("readJob", () => {
  it("returns a stored job's kind, source, fence version, status, lease and reason", () => {
    const { lastInsertRowid } = db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, lease_until)
       VALUES ('extract', 1, 1, 'queued', '2026-11-21T00:05:00.000Z')`,
    );
    expect(readJob(db, lastInsertRowid)).toEqual({
      id: lastInsertRowid,
      kind: "extract",
      sourceId: 1,
      fenceVersion: 1,
      status: "queued",
      leaseUntil: "2026-11-21T00:05:00.000Z",
      reason: null,
    });
  });

  it("returns undefined for a missing job", () => {
    expect(readJob(db, 404)).toBeUndefined();
  });
});

describe("registerJob", () => {
  it("queues a new job with no lease", () => {
    expect(registered()).toMatchObject({
      kind: "extract",
      sourceId: 1,
      fenceVersion: 1,
      status: "queued",
      leaseUntil: null,
      reason: null,
    });
  });

  it("does not count a conflict as a registration: it returns the job already there", () => {
    const first = registered();
    lease();
    closeJob(db, first.id, { status: "failed", reason: "provider-error" });
    expect(registerJob(db, { kind: "extract", sourceId: 1, fenceVersion: 1 })).toEqual({
      registered: false,
      existing: { ...first, status: "failed", reason: "provider-error" },
    });
    expect(db.all("SELECT count(*) AS n FROM jobs")[0]?.n).toBe(1);
  });

  it("registers another kind or another version of the same source separately", () => {
    registered();
    newVersion("b2");
    expect(registerJob(db, { kind: "extract", sourceId: 1, fenceVersion: 2 }).registered).toBe(
      true,
    );
    expect(registerJob(db, { kind: "other", sourceId: 1, fenceVersion: 1 }).registered).toBe(true);
  });
});

describe("leaseNextJob", () => {
  it("claims the oldest queued job of a handled kind until now + lease", () => {
    registerJob(db, { kind: "unhandled", sourceId: 1, fenceVersion: 1 });
    const job = registered();
    expect(lease()).toEqual({
      ...job,
      status: "leased",
      leaseUntil: at(LEASE).toISOString(),
    });
    expect(readJob(db, job.id)?.status).toBe("leased");
  });

  it("returns undefined when nothing is due", () => {
    expect(lease()).toBeUndefined();
    registerJob(db, { kind: "unhandled", sourceId: 1, fenceVersion: 1 });
    expect(lease()).toBeUndefined();
  });

  it("does not claim a job whose lease is still running", () => {
    registered();
    lease();
    expect(lease(at(LEASE - 1))).toBeUndefined();
  });

  it("claims again a job whose lease ran out (restart after a crash)", () => {
    const job = registered();
    lease();
    expect(lease(at(LEASE))).toMatchObject({
      id: job.id,
      status: "leased",
      leaseUntil: at(2 * LEASE).toISOString(),
    });
  });

  it("never claims a closed job", () => {
    for (const status of ["done", "superseded", "held", "failed"] as const) {
      const job = registered(`k-${status}`);
      lease(T0, [job.kind]);
      closeJob(
        db,
        job.id,
        status === "done" ? { status, write: () => {} } : { status, reason: "r" },
      );
      expect(lease(at(10 * LEASE), [job.kind])).toBeUndefined();
    }
  });
});

describe("closeJob: the version fence (V02-R5)", () => {
  it("writes the result and closes the job done while its version is the latest", () => {
    const job = registered();
    lease();
    let wrote = 0;
    expect(closeJob(db, job.id, { status: "done", write: () => void wrote++ })).toBe("done");
    expect(wrote).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({ status: "done", leaseUntil: null, reason: null });
  });

  it("discards a result from a stale version and closes the job superseded", () => {
    const job = registered();
    lease();
    newVersion("b2");
    let wrote = 0;
    expect(closeJob(db, job.id, { status: "done", write: () => void wrote++ })).toBe("superseded");
    expect(wrote).toBe(0);
    expect(readJob(db, job.id)).toMatchObject({ status: "superseded", leaseUntil: null });
  });

  it("discards a result once its source is purged and tombstoned (V02-R12)", () => {
    const job = registered();
    lease();
    db.transaction(() => {
      db.run("DELETE FROM source_versions WHERE source_id = 1");
      writeTombstone(db, { sourceId: 1, version: 1, at: T0.toISOString(), reason: "deleted" });
    });
    let wrote = 0;
    expect(closeJob(db, job.id, { status: "done", write: () => void wrote++ })).toBe("superseded");
    expect(wrote).toBe(0);
  });

  it("discards a result when a tombstone covers the fence even if the version row is left", () => {
    const job = registered();
    lease();
    writeTombstone(db, { sourceId: 1, version: 1, at: T0.toISOString(), reason: "access-revoked" });
    expect(closeJob(db, job.id, { status: "done", write: () => {} })).toBe("superseded");
  });

  it("accepts a version stored above an older tombstone", () => {
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    writeTombstone(db, { sourceId: 1, version: 1, at: T0.toISOString(), reason: "deleted" });
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 2, 'h', 't', 'b2')",
    );
    const job = registered("extract", 1, 2);
    lease();
    expect(closeJob(db, job.id, { status: "done", write: () => {} })).toBe("done");
  });

  it("closes a held or failed job superseded instead when its version is stale", () => {
    const job = registered();
    lease();
    newVersion("b2");
    expect(closeJob(db, job.id, { status: "held", reason: "cli-background-off" })).toBe(
      "superseded",
    );
    expect(readJob(db, job.id)?.reason).toBeNull();
  });

  it("records why a current job was held or failed, as a code", () => {
    const held = registered("a");
    lease(T0, ["a"]);
    expect(closeJob(db, held.id, { status: "held", reason: "cli-background-off" })).toBe("held");
    expect(readJob(db, held.id)).toMatchObject({
      status: "held",
      reason: "cli-background-off",
      leaseUntil: null,
    });
    const failed = registered("b");
    lease(T0, ["b"]);
    expect(closeJob(db, failed.id, { status: "failed", reason: "timeout" })).toBe("failed");
    expect(readJob(db, failed.id)).toMatchObject({ status: "failed", reason: "timeout" });
  });

  it("closes superseded without a result", () => {
    const job = registered();
    lease();
    expect(closeJob(db, job.id, { status: "superseded" })).toBe("superseded");
  });

  it("discards a second result for a job already closed (a job run twice counts once)", () => {
    const job = registered();
    lease();
    closeJob(db, job.id, { status: "done", write: () => {} });
    let wrote = 0;
    expect(closeJob(db, job.id, { status: "done", write: () => void wrote++ })).toBe("not-leased");
    expect(wrote).toBe(0);
    expect(closeJob(db, 404, { status: "done", write: () => void wrote++ })).toBe("not-leased");
  });

  it("refuses to close a queued job that was never leased", () => {
    const job = registered();
    expect(closeJob(db, job.id, { status: "done", write: () => {} })).toBe("not-leased");
    expect(readJob(db, job.id)?.status).toBe("queued");
  });

  it("rolls the result back and leaves the job leased when the write throws", () => {
    const job = registered();
    lease();
    expect(() =>
      closeJob(db, job.id, {
        status: "done",
        write: () => {
          db.run("INSERT INTO settings (key, value) VALUES ('partial', 'x')");
          throw new Error("write failed");
        },
      }),
    ).toThrow("write failed");
    expect(db.all("SELECT * FROM settings WHERE key = 'partial'")).toEqual([]);
    expect(readJob(db, job.id)?.status).toBe("leased");
  });
});
