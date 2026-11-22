// V01-R6 job records: the Broker reads a job to decide that a call is background.
// V02-R3: a job carries its source and the version it was registered for (the fence).
// V02-R4: registered once per kind, source and version, claimed with a lease that
// expires. V02-R5: a result is written only while the fence version is still the
// source's latest and no tombstone covers it; otherwise the job closes superseded.
// I03-R1..R3 (I03-T01): eight statuses and only the drawn transitions, the jobs
// with no source, the three duplicate guards, and closing a source's open jobs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  closeJob,
  CLOCK_REGRESSION_LEASES,
  DEFAULT_MAX_ATTEMPTS,
  heartbeatJob,
  isJobTransition,
  isReasonCode,
  JOB_STATUSES,
  JobWriteError,
  leaseNextJob,
  readJob,
  reclaimLeases,
  registerJob,
  releaseRetryJobs,
  supersedeOpenJobs,
  transitionJob,
  type JobStatus,
  type NewJob,
  type StoredJob,
} from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
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
  const r = registerJob(db, { kind, sourceId, fenceVersion, at: T0 });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}

const lease = (now = T0, kinds: readonly string[] = ["extract"]) =>
  leaseNextJob(db, { kinds, now, leaseMs: LEASE, owner: "runner-a" });

function claimed(now = T0): StoredJob {
  const job = lease(now);
  if (!job) throw new Error("expected a claim");
  return job;
}

/** The job's current lease, as its holder knows it. */
const held = (id: number) => ({ id, leaseToken: readJob(db, id)?.leaseToken ?? 0 });

const newVersion = (body: string) =>
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body });

describe("readJob", () => {
  it("returns every column of a stored job, times as UTC milliseconds", () => {
    const job = registered();
    expect(readJob(db, job.id)).toEqual({
      id: job.id,
      kind: "extract",
      target: "",
      sourceId: 1,
      fenceVersion: 1,
      status: "queued",
      reason: null,
      attempts: 0,
      runAfter: T0.getTime(),
      leaseOwner: null,
      leaseToken: 0,
      leaseUntil: null,
      heartbeatAt: null,
      priority: "user",
      fairnessKey: "c1",
      scheduleId: null,
      slot: null,
      checkpoint: null,
      resultCounts: null,
      policyFingerprint: null,
      cancelRequested: false,
      registeredChangeSeq: readChangeSeq(db),
      createdAt: T0.getTime(),
      updatedAt: T0.getTime(),
      finishedAt: null,
    });
  });

  it("returns undefined for a missing job", () => {
    expect(readJob(db, 404)).toBeUndefined();
  });
});

describe("registerJob", () => {
  it("queues a new job with no lease, due at once, with the change sequence after the caller's writes", () => {
    const job = db.transaction(() => {
      newVersion("b2"); // the caller's own write comes first (I03-R2)
      return registerJob(db, { kind: "extract", sourceId: 1, fenceVersion: 2, at: T0 });
    });
    expect(job).toMatchObject({
      registered: true,
      job: {
        status: "queued",
        target: "",
        leaseUntil: null,
        leaseToken: 0,
        attempts: 0,
        runAfter: T0.getTime(),
        registeredChangeSeq: readChangeSeq(db),
      },
    });
  });

  it("does not count a conflict as a registration: it returns the job already there", () => {
    const first = registered();
    lease();
    closeJob(db, held(first.id), { status: "dead_letter", reason: "provider-error" }, T0);
    expect(registerJob(db, { kind: "extract", sourceId: 1, fenceVersion: 1 })).toEqual({
      registered: false,
      existing: readJob(db, first.id),
    });
    expect(readJob(db, first.id)).toMatchObject({
      status: "dead_letter",
      reason: "provider-error",
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
      status: "running",
      leaseUntil: at(LEASE).getTime(),
      leaseOwner: "runner-a",
      heartbeatAt: T0.getTime(),
      leaseToken: 1,
      attempts: 1,
    });
    expect(readJob(db, job.id)?.status).toBe("running");
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

  it("claims again a job whose lease ran out (restart after a crash), through queued", () => {
    const job = registered();
    lease();
    // reclaimed (token 2) then claimed (token 3): the drawn running -> queued -> running
    expect(lease(at(LEASE))).toMatchObject({
      id: job.id,
      status: "running",
      leaseUntil: at(2 * LEASE).getTime(),
      leaseToken: 3,
      attempts: 2,
    });
  });

  it("never claims a closed job", () => {
    for (const status of ["succeeded", "superseded", "held", "dead_letter"] as const) {
      const job = registered(`k-${status}`);
      lease(T0, [job.kind]);
      closeJob(
        db,
        held(job.id),
        status === "succeeded" ? { status, write: () => {} } : { status, reason: "r" },
      );
      expect(lease(at(10 * LEASE), [job.kind])).toBeUndefined();
    }
  });
});

describe("closeJob: the version fence (V02-R5)", () => {
  it("writes the result and closes the job succeeded while its version is the latest", () => {
    const job = registered();
    lease();
    let wrote = 0;
    expect(
      closeJob(db, held(job.id), { status: "succeeded", write: () => void wrote++ }, at(5)),
    ).toBe("succeeded");
    expect(wrote).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({
      status: "succeeded",
      leaseUntil: null,
      leaseOwner: null,
      reason: null,
      updatedAt: at(5).getTime(),
      finishedAt: at(5).getTime(),
    });
  });

  it("discards a result from a stale version and closes the job superseded", () => {
    const job = registered();
    lease();
    newVersion("b2");
    let wrote = 0;
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => void wrote++ })).toBe(
      "superseded",
    );
    expect(wrote).toBe(0);
    expect(readJob(db, job.id)).toMatchObject({ status: "superseded", leaseUntil: null });
  });

  it("discards a result once its source is purged and tombstoned (V02-R12)", () => {
    const job = registered();
    lease();
    db.transaction(() => {
      db.run("DELETE FROM source_versions WHERE source_id = 1");
      writeTombstone(db, {
        sourceId: 1,
        version: 1,
        at: T0.toISOString(),
        reason: "source-deleted",
      });
    });
    let wrote = 0;
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => void wrote++ })).toBe(
      "superseded",
    );
    expect(wrote).toBe(0);
  });

  it("discards a result when a tombstone covers the fence even if the version row is left", () => {
    const job = registered();
    lease();
    writeTombstone(db, { sourceId: 1, version: 1, at: T0.toISOString(), reason: "access-revoked" });
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => {} })).toBe("superseded");
  });

  it("accepts a version stored above an older tombstone", () => {
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    writeTombstone(db, { sourceId: 1, version: 1, at: T0.toISOString(), reason: "source-deleted" });
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 2, 'h', 't', 'b2')",
    );
    const job = registered("extract", 1, 2);
    lease();
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => {} })).toBe("succeeded");
  });

  it("closes a held or dead-letter job superseded instead when its version is stale", () => {
    const job = registered();
    lease();
    newVersion("b2");
    expect(closeJob(db, held(job.id), { status: "held", reason: "cli-background-off" })).toBe(
      "superseded",
    );
    expect(readJob(db, job.id)?.reason).toBeNull();
  });

  it("records why a current job was held or dead-lettered, as a code", () => {
    const onHold = registered("a");
    lease(T0, ["a"]);
    expect(closeJob(db, held(onHold.id), { status: "held", reason: "cli-background-off" })).toBe(
      "held",
    );
    expect(readJob(db, onHold.id)).toMatchObject({
      status: "held",
      reason: "cli-background-off",
      leaseUntil: null,
    });
    const failed = registered("b");
    lease(T0, ["b"]);
    expect(closeJob(db, held(failed.id), { status: "dead_letter", reason: "timeout" })).toBe(
      "dead_letter",
    );
    expect(readJob(db, failed.id)).toMatchObject({ status: "dead_letter", reason: "timeout" });
  });

  it("closes superseded without a result", () => {
    const job = registered();
    lease();
    expect(closeJob(db, held(job.id), { status: "superseded" })).toBe("superseded");
  });

  it("discards a second result for a job already closed (a job run twice counts once)", () => {
    const job = registered();
    lease();
    closeJob(db, held(job.id), { status: "succeeded", write: () => {} });
    let wrote = 0;
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => void wrote++ })).toBe(
      "not-leased",
    );
    expect(wrote).toBe(0);
    expect(
      closeJob(db, { id: 404, leaseToken: 1 }, { status: "succeeded", write: () => void wrote++ }),
    ).toBe("not-leased");
  });

  it("refuses to close a queued job that was never leased", () => {
    const job = registered();
    expect(closeJob(db, held(job.id), { status: "succeeded", write: () => {} })).toBe("not-leased");
    expect(readJob(db, job.id)?.status).toBe("queued");
  });

  it("rolls the result back and leaves the job running when the write throws", () => {
    const job = registered();
    lease();
    expect(() =>
      closeJob(db, held(job.id), {
        status: "succeeded",
        write: () => {
          db.run("INSERT INTO settings (key, value) VALUES ('partial', 'x')");
          throw new Error("write failed");
        },
      }),
    ).toThrow(JobWriteError);
    expect(db.all("SELECT * FROM settings WHERE key = 'partial'")).toEqual([]);
    expect(readJob(db, job.id)?.status).toBe("running");
  });
});

describe("closeJob: only the current lease holder closes (V02-T03 rework)", () => {
  it("does not apply a close from a holder whose lease ran out and was taken again", () => {
    const job = registered();
    const old = claimed();
    const fresh = claimed(at(LEASE));
    expect(fresh.leaseToken).toBe(old.leaseToken + 2); // reclaimed, then claimed
    let wrote = 0;
    expect(closeJob(db, old, { status: "succeeded", write: () => void wrote++ })).toBe(
      "not-leased",
    );
    expect(wrote).toBe(0);
    expect(readJob(db, job.id)?.status).toBe("running");
    expect(closeJob(db, fresh, { status: "succeeded", write: () => void wrote++ })).toBe(
      "succeeded",
    );
    expect(wrote).toBe(1);
  });

  it("does not let a stale holder's held overwrite the fresh holder's done", () => {
    const job = registered();
    const old = claimed();
    const fresh = claimed(at(LEASE));
    expect(closeJob(db, fresh, { status: "succeeded", write: () => {} })).toBe("succeeded");
    expect(closeJob(db, old, { status: "held", reason: "cli-background-off" })).toBe("not-leased");
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded", reason: null });
  });
});

describe("closeJob: reasons are codes, never text (V02-T03 rework)", () => {
  it("accepts short lowercase codes", () => {
    for (const code of ["cli-background-off", "timeout", "handler-error", "a", "x".repeat(64)]) {
      expect(isReasonCode(code)).toBe(true);
    }
  });

  it("refuses a reason that is not a code and leaves the job running", () => {
    const job = registered();
    lease();
    for (const reason of [
      "",
      "Provider said: SECRET-BODY-TEXT line 1\nstack",
      "Timeout",
      "-x",
      "1x",
      "x".repeat(65),
      "a b",
    ]) {
      expect(isReasonCode(reason)).toBe(false);
      expect(() => closeJob(db, held(job.id), { status: "dead_letter", reason })).toThrow(
        RangeError,
      );
    }
    expect(readJob(db, job.id)).toMatchObject({ status: "running", reason: null });
  });
});

// I03-R1: the drawn transitions, and nothing else.
const DRAWN: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled", "superseded"],
  running: ["succeeded", "retry", "queued", "cancelled", "superseded", "held", "dead_letter"],
  retry: ["queued", "dead_letter", "cancelled", "superseded"],
  held: ["queued", "cancelled", "superseded"],
  dead_letter: ["queued", "cancelled", "superseded"],
  succeeded: [],
  superseded: [],
  cancelled: [],
};

describe("jobs.transitions (I03-R1)", () => {
  it("names the eight statuses", () => {
    expect([...JOB_STATUSES].sort()).toEqual(Object.keys(DRAWN).sort());
  });

  const pairs = JOB_STATUSES.flatMap((from) => JOB_STATUSES.map((to) => [from, to] as const));
  it.each(pairs)("%s -> %s: only a drawn transition changes the row", (from, to) => {
    const job = registered();
    db.run("UPDATE jobs SET status = ?, lease_token = 4 WHERE id = ?", [from, job.id]);
    const before = readJob(db, job.id);
    const change = { from, to, leaseToken: 4, reason: null, at: at(7) };
    if (from === "queued" && to === "running") {
      // the one drawn transition into running is the claim, which writes the lease
      expect(isJobTransition(from, to)).toBe(true);
      expect(() => transitionJob(db, job.id, change)).toThrow(RangeError);
      expect(lease(at(7))).toMatchObject({ status: to, updatedAt: at(7).getTime() });
    } else if (DRAWN[from].includes(to)) {
      expect(isJobTransition(from, to)).toBe(true);
      expect(transitionJob(db, job.id, change)).toBe(true);
      expect(readJob(db, job.id)).toMatchObject({ status: to, updatedAt: at(7).getTime() });
    } else {
      expect(isJobTransition(from, to)).toBe(false);
      expect(() => transitionJob(db, job.id, change)).toThrow(RangeError);
      expect(readJob(db, job.id)).toEqual(before);
    }
  });

  it("changes nothing when the row is not in the stated status or lease", () => {
    const job = registered();
    expect(transitionJob(db, job.id, { from: "held", to: "queued", at: at(1) })).toBe(false);
    lease();
    const change = { from: "running", to: "retry", leaseToken: 99, at: at(1) } as const;
    expect(transitionJob(db, job.id, change)).toBe(false);
    expect(readJob(db, job.id)).toMatchObject({ status: "running", leaseToken: 1 });
  });

  it("marks the end time of a finished job and clears it when a dead letter is retried", () => {
    const job = registered();
    lease();
    transitionJob(db, job.id, {
      from: "running",
      to: "dead_letter",
      reason: "invalid-output",
      at: at(3),
    });
    expect(readJob(db, job.id)).toMatchObject({ finishedAt: at(3).getTime(), leaseUntil: null });
    transitionJob(db, job.id, { from: "dead_letter", to: "queued", at: at(4) });
    expect(readJob(db, job.id)).toMatchObject({ status: "queued", finishedAt: null, reason: null });
  });

  it("refuses a reason that is not a code", () => {
    const job = registered();
    const change = { from: "queued", to: "cancelled", reason: "Provider said X", at: T0 } as const;
    expect(() => transitionJob(db, job.id, change)).toThrow(RangeError);
    expect(readJob(db, job.id)?.status).toBe("queued");
  });

  it("lets the database refuse a status outside the list (CHECK)", () => {
    const job = registered();
    for (const status of ["leased", "done", "failed", "Queued", ""]) {
      expect(() => db.run("UPDATE jobs SET status = ? WHERE id = ?", [status, job.id])).toThrow(
        /CHECK/,
      );
    }
    expect(readJob(db, job.id)?.status).toBe("queued");
  });
});

describe("jobs.register-conflict (I03-R2)", () => {
  const removal = (target: string): NewJob => ({
    kind: "projection-remove",
    target,
    sourceId: 1,
    fenceVersion: 1,
    at: T0,
  });

  it("returns the job already there for the same kind, target, source and fence version", () => {
    const first = registerJob(db, removal("engine"));
    expect(first.registered).toBe(true);
    const again = registerJob(db, removal("engine"));
    expect(again).toEqual({
      registered: false,
      existing: first.registered ? first.job : undefined,
    });
    expect(db.all("SELECT count(*) AS n FROM jobs")[0]?.n).toBe(1);
  });

  it("registers one projection removal per target", () => {
    expect(registerJob(db, removal("engine")).registered).toBe(true);
    expect(registerJob(db, removal("vector")).registered).toBe(true);
  });

  it("requires a source for a kind fenced by one, and both or neither of source and version", () => {
    for (const kind of ["extract", "projection-remove"]) {
      expect(() => registerJob(db, { kind, at: T0 })).toThrow(/CHECK/);
    }
    expect(() =>
      db.run(
        `INSERT INTO jobs (kind, source_id, status, run_after, fairness_key,
           registered_change_seq, created_at, updated_at)
         VALUES ('test-effect', 1, 'queued', 0, 'k', 0, 0, 0)`,
      ),
    ).toThrow(/CHECK/);
  });

  it("keys a source job's fairness by its Connector instance and a sourceless one by its kind", () => {
    const sourced = registerJob(db, removal("engine"));
    const sourceless = registerJob(db, { kind: "projection-rebuild", target: "engine", at: T0 });
    expect(sourced.registered && sourced.job.fairnessKey).toBe("c1");
    expect(sourceless.registered && sourceless.job.fairnessKey).toBe("projection-rebuild");
  });
});

describe("jobs.unique-sourceless (I03-R2)", () => {
  const rebuild = (target = "engine"): NewJob => ({ kind: "projection-rebuild", target, at: T0 });

  it("keeps one open rebuild per projection, and registers again once it finished", () => {
    const first = registerJob(db, rebuild());
    if (!first.registered) throw new Error("expected a new job");
    expect(registerJob(db, rebuild())).toEqual({ registered: false, existing: first.job });
    expect(registerJob(db, rebuild("vector")).registered).toBe(true);
    for (const status of ["running", "retry", "held"] as const) {
      db.run("UPDATE jobs SET status = ? WHERE id = ?", [status, first.job.id]);
      expect(registerJob(db, rebuild()).registered).toBe(false);
    }
    db.run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", [first.job.id]);
    expect(registerJob(db, rebuild()).registered).toBe(true);
  });

  it("does not let a sourceless guard bind a source job of the same kind and empty target", () => {
    expect(registerJob(db, { kind: "test-effect", at: T0 }).registered).toBe(true);
    expect(
      registerJob(db, { kind: "test-effect", sourceId: 1, fenceVersion: 1, at: T0 }).registered,
    ).toBe(true);
    saveSourceRecord(db, "c1", { externalId: "e2", title: "t", body: "b" });
    expect(
      registerJob(db, { kind: "test-effect", sourceId: 2, fenceVersion: 1, at: T0 }).registered,
    ).toBe(true);
  });

  it("keeps one open job per schedule, so a second run-now is the first", () => {
    const runNow = (slot: number): NewJob => ({
      kind: "connector-sync",
      target: "c1",
      priority: "user",
      schedule: { id: 7, slot },
      at: T0,
    });
    const first = registerJob(db, runNow(1_000));
    if (!first.registered) throw new Error("expected a new job");
    expect(registerJob(db, runNow(2_000))).toEqual({ registered: false, existing: first.job });
    expect(first.job).toMatchObject({ scheduleId: 7, slot: 1_000, priority: "user" });
  });

  it("registers a schedule's slot once, even after that job finished", () => {
    const slot = (n: number): NewJob => ({
      kind: "maintenance",
      priority: "maintenance",
      schedule: { id: 3, slot: n },
      at: T0,
    });
    const first = registerJob(db, slot(1));
    if (!first.registered) throw new Error("expected a new job");
    db.run("UPDATE jobs SET status = 'succeeded' WHERE id = ?", [first.job.id]);
    expect(registerJob(db, slot(1))).toMatchObject({
      registered: false,
      existing: { id: first.job.id, status: "succeeded" },
    });
    expect(registerJob(db, slot(2)).registered).toBe(true);
  });
});

describe("jobs.supersede-open (I03-R3)", () => {
  beforeEach(() => {
    saveSourceRecord(db, "c1", { externalId: "e2", title: "t", body: "b" });
  });

  it("closes source X's open jobs superseded and raises their tokens, leaving the rest", () => {
    const running = registered("a");
    lease(T0, ["a"]);
    const ids = {
      running: running.id,
      queued: registered("b").id,
      retry: registered("c").id,
      held: registered("d").id,
      deadLetter: registered("e").id,
      removal: registerJob(db, {
        kind: "projection-remove",
        target: "engine",
        sourceId: 1,
        fenceVersion: 1,
        at: T0,
      }),
      other: registered("b", 2).id,
    };
    db.run("UPDATE jobs SET status = 'retry' WHERE id = ?", [ids.retry]);
    db.run("UPDATE jobs SET status = 'held', reason = 'no-consent' WHERE id = ?", [ids.held]);
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [ids.deadLetter]);
    const removalId = ids.removal.registered ? ids.removal.job.id : 0;
    const before = (id: number) => readJob(db, id) as StoredJob;
    const untouched = [ids.deadLetter, removalId, ids.other].map(before);
    const tokens = [ids.running, ids.queued, ids.retry, ids.held].map(
      (id) => before(id).leaseToken,
    );

    expect(db.transaction(() => supersedeOpenJobs(db, 1, at(9)))).toBe(4);

    [ids.running, ids.queued, ids.retry, ids.held].forEach((id, i) =>
      expect(readJob(db, id)).toMatchObject({
        status: "superseded",
        reason: "source-closed",
        leaseToken: (tokens[i] as number) + 1,
        leaseUntil: null,
        finishedAt: at(9).getTime(),
      }),
    );
    expect([ids.deadLetter, removalId, ids.other].map(before)).toEqual(untouched);
  });

  it("fails the closed running job's heartbeat and result write", () => {
    const job = registered();
    const lease1 = claimed();
    expect(heartbeatJob(db, lease1, { now: at(1), leaseMs: LEASE })).toBe(true);
    supersedeOpenJobs(db, 1, at(2));
    expect(heartbeatJob(db, lease1, { now: at(3), leaseMs: LEASE })).toBe(false);
    let wrote = 0;
    expect(closeJob(db, lease1, { status: "succeeded", write: () => void wrote++ })).toBe(
      "not-leased",
    );
    expect(wrote).toBe(0);
    expect(readJob(db, job.id)?.status).toBe("superseded");
  });
});

describe("lease.heartbeat-after-expiry (I03-R4): the conditional extension", () => {
  it("extends the current holder's lease, even past its expiry", () => {
    const job = registered();
    const held1 = claimed();
    expect(heartbeatJob(db, held1, { now: at(LEASE + 5), leaseMs: LEASE })).toBe(true);
    expect(readJob(db, job.id)).toMatchObject({
      leaseUntil: at(2 * LEASE + 5).getTime(),
      heartbeatAt: at(LEASE + 5).getTime(),
      leaseToken: held1.leaseToken,
    });
    expect(heartbeatJob(db, { ...held1, leaseToken: 9 }, { now: at(1), leaseMs: LEASE })).toBe(
      false,
    );
  });
  it("fails once the job left running, even under the same token", () => {
    const job = registered();
    const held1 = claimed();
    expect(closeJob(db, held1, { status: "succeeded", write: () => {} })).toBe("succeeded");
    expect(readJob(db, job.id)?.leaseToken).toBe(held1.leaseToken); // a close keeps the token
    expect(heartbeatJob(db, held1, { now: at(1), leaseMs: LEASE })).toBe(false);
    expect(readJob(db, job.id)).toMatchObject({ status: "succeeded", leaseUntil: null });
  });
  it("fails for a job held under the same token, and leaves it held", () => {
    const job = registered();
    const held1 = claimed();
    // running -> held keeps the token: only the status tells the holder apart
    expect(
      transitionJob(db, job.id, {
        from: "running",
        to: "held",
        reason: "r",
        leaseToken: held1.leaseToken,
      }),
    ).toBe(true);
    expect(readJob(db, job.id)?.leaseToken).toBe(held1.leaseToken);
    expect(heartbeatJob(db, held1, { now: at(LEASE + 5), leaseMs: LEASE })).toBe(false);
    expect(readJob(db, job.id)).toMatchObject({ status: "held", leaseUntil: null });
  });
});

/** Writes a column the code under test only reads (T07 sets cancel requests, T04 run-at times). */
const poke = (id: number, set: string, params: (number | string)[] = []) =>
  db.run(`UPDATE jobs SET ${set} WHERE id = ?`, [...params, id]);

describe("lease.pick (I03-R4): what a claim skips and closes", () => {
  it("does not claim a queued job whose run-at time is still ahead, and claims it once due", () => {
    const job = registered();
    poke(job.id, "run_after = ?", [at(1000).getTime()]);
    expect(lease(at(999))).toBeUndefined();
    expect(readJob(db, job.id)?.status).toBe("queued");
    expect(lease(at(1000))).toMatchObject({ id: job.id, status: "running" });
  });

  it("closes a queued job with a cancel request cancelled instead of claiming it, and claims the next", () => {
    const cancelled = registered("extract", 1, 1);
    newVersion("b2");
    const next = registered("extract", 1, 2);
    poke(cancelled.id, "cancel_requested = 1");
    expect(lease()).toMatchObject({ id: next.id, status: "running" });
    expect(readJob(db, cancelled.id)).toMatchObject({
      status: "cancelled",
      attempts: 0,
      leaseToken: 0,
      finishedAt: T0.getTime(),
    });
  });

  it("leaves a cancel-requested job of a kind it does not handle", () => {
    const other = registered("unhandled");
    poke(other.id, "cancel_requested = 1");
    expect(lease()).toBeUndefined();
    expect(readJob(db, other.id)?.status).toBe("queued");
  });
});

describe("lease.reclaim (I03-R5)", () => {
  const reclaim = (now: Date, holding: readonly number[] = []) =>
    reclaimLeases(db, { kinds: ["extract"], now, leaseMs: LEASE, holding });

  it("reclaims a lease that ran out, raising the token: running -> queued, attempts kept", () => {
    const job = registered();
    const held1 = claimed();
    expect(reclaim(at(LEASE - 1))).toBe(0);
    expect(reclaim(at(LEASE))).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({
      status: "queued",
      leaseToken: held1.leaseToken + 1,
      attempts: 1,
      leaseUntil: null,
      leaseOwner: null,
      reason: null,
    });
  });

  it("reclaims a lease further ahead than two lease lengths (the wall clock went back)", () => {
    expect(CLOCK_REGRESSION_LEASES).toBe(2);
    const job = registered();
    const held1 = claimed(at(10 * LEASE)); // until 11 * LEASE
    // up to two leases ahead is kept: a fresh claim or heartbeat, or one written a moment later
    expect(reclaim(at(9 * LEASE))).toBe(0);
    expect(reclaim(at(9 * LEASE - 1))).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({
      status: "queued",
      leaseToken: held1.leaseToken + 1,
    });
  });

  it("keeps a lease another backend's heartbeat extended a millisecond past now + lease (review RA-1)", () => {
    // A claims at T0 and heartbeats at T0 + 30 001 ms; B claims with now = T0 + 30 000
    const job = registered();
    const a = claimed();
    expect(heartbeatJob(db, a, { now: at(30_001), leaseMs: LEASE })).toBe(true);
    expect(lease(at(30_000))).toBeUndefined();
    expect(readJob(db, job.id)).toMatchObject({ status: "running", leaseToken: a.leaseToken });
    expect(heartbeatJob(db, a, { now: at(30_002), leaseMs: LEASE })).toBe(true);
  });

  it("leaves the jobs the runner holds in memory to its heartbeat", () => {
    const job = registered();
    claimed();
    expect(reclaim(at(5 * LEASE), [job.id])).toBe(0);
    expect(readJob(db, job.id)?.status).toBe("running");
    expect(reclaim(at(5 * LEASE), [job.id + 1])).toBe(1);
  });

  it("leaves running jobs of kinds it was not asked for", () => {
    const other = registered("unhandled");
    lease(T0, ["unhandled"]);
    expect(reclaim(at(5 * LEASE))).toBe(0);
    expect(readJob(db, other.id)?.status).toBe("running");
  });

  it("closes a reclaimed job with a cancel request cancelled", () => {
    const job = registered();
    const held1 = claimed();
    poke(job.id, "cancel_requested = 1");
    expect(reclaim(at(LEASE))).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({
      status: "cancelled",
      leaseToken: held1.leaseToken + 1,
      finishedAt: at(LEASE).getTime(),
    });
  });

  it("sends a job out of attempts to retry with lease-expired, and the claim dead-letters it", () => {
    const job = registered();
    expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
    let t = 0;
    for (let i = 1; i < DEFAULT_MAX_ATTEMPTS; i++) {
      expect(lease(at(t))).toMatchObject({ id: job.id, attempts: i });
      t += LEASE;
    }
    expect(lease(at(t))).toMatchObject({ id: job.id, attempts: DEFAULT_MAX_ATTEMPTS });
    t += LEASE;
    // the fifth reclaim: no attempt left, so retry, not queued
    expect(reclaim(at(t))).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({ status: "retry", reason: "lease-expired" });
    // the one exit from retry (R11) gives up: dead letter, the code kept
    expect(lease(at(t))).toBeUndefined();
    expect(readJob(db, job.id)).toMatchObject({
      status: "dead_letter",
      reason: "lease-expired",
      attempts: DEFAULT_MAX_ATTEMPTS,
      finishedAt: at(t).getTime(),
    });
  });

  it("takes the attempt limit from the request", () => {
    const job = registered();
    leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: LEASE, maxAttempts: 1 });
    expect(
      reclaimLeases(db, { kinds: ["extract"], now: at(LEASE), leaseMs: LEASE, maxAttempts: 1 }),
    ).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({ status: "retry", reason: "lease-expired" });
  });

  it("reclaims a running row with no lease end (nothing else would claim it again)", () => {
    const job = registered();
    claimed();
    poke(job.id, "lease_until = NULL");
    expect(reclaim(T0)).toBe(1);
    expect(readJob(db, job.id)?.status).toBe("queued");
  });
});

describe("releaseRetryJobs (I03-R11, provisional until T04): the one exit from retry", () => {
  /** A job of the given attempts sent to retry the way a reclaim does. */
  function retrying(attempts: number, runAfter = T0.getTime()): StoredJob {
    const job = registered();
    poke(job.id, "status = 'retry', reason = 'lease-expired', attempts = ?, run_after = ?", [
      attempts,
      runAfter,
    ]);
    return job;
  }
  const release = (now: Date) => releaseRetryJobs(db, { kinds: ["extract"], now });

  it("queues a job with attempts left once its run-at time came, clearing the code", () => {
    const job = retrying(2, at(1000).getTime());
    expect(release(at(999))).toBe(0);
    expect(readJob(db, job.id)?.status).toBe("retry");
    expect(release(at(1000))).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({ status: "queued", reason: null, finishedAt: null });
  });

  it("dead-letters a job out of attempts at once, whatever its run-at time", () => {
    const job = retrying(DEFAULT_MAX_ATTEMPTS, at(10_000).getTime());
    expect(release(T0)).toBe(1);
    expect(readJob(db, job.id)).toMatchObject({ status: "dead_letter", reason: "lease-expired" });
  });

  it("leaves retry jobs of other kinds", () => {
    const job = retrying(DEFAULT_MAX_ATTEMPTS);
    expect(releaseRetryJobs(db, { kinds: ["other"], now: T0 })).toBe(0);
    expect(readJob(db, job.id)?.status).toBe("retry");
  });
});

describe("closeJob takes the write lock as it begins (review B-W1)", () => {
  // Deferred, the close read the job and then met another connection's write
  // lock with SQLITE_BUSY at once (SQLite skips the busy wait to avoid deadlock).
  // Immediate, it asks for the lock before reading, where the busy wait applies.
  // The second connection's open write transaction stands for the other backend.
  let dir: string;
  let file: SqlDriver;
  let other: SqlDriver;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pki-jobs-lock-"));
    file = openBetterSqlite3(join(dir, "db.sqlite"));
    migrate(file);
    registerConnectorInstance(file, "c1", "test-fixtures");
    saveSourceRecord(file, "c1", { externalId: "e1", title: "t", body: "b" });
    // due at T0: a claim honours the run-at time (I03-T03)
    registerJob(file, { kind: "extract", sourceId: 1, fenceVersion: 1, at: T0 });
    other = openBetterSqlite3(join(dir, "db.sqlite"));
    file.exec("PRAGMA busy_timeout = 0"); // no test waits on the lock
  });
  afterEach(() => {
    other.close();
    file.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks for the lock before reading the job, and closes once the lock is free", () => {
    const job = leaseNextJob(file, { kinds: ["extract"], now: T0, leaseMs: LEASE }) as StoredJob;
    let reads = 0;
    const counted: SqlDriver = { ...file, all: (sql, params) => (reads++, file.all(sql, params)) };
    other.exec("BEGIN IMMEDIATE; INSERT INTO settings (key, value) VALUES ('lock', 'x')");
    expect(() => closeJob(counted, job, { status: "succeeded", write: () => {} })).toThrow(
      /locked|busy/i,
    );
    expect(reads).toBe(0);
    other.exec("COMMIT");
    expect(closeJob(counted, job, { status: "succeeded", write: () => {} })).toBe("succeeded");
  });

  it("lease.pick: a claim asks for the lock before running any statement (BEGIN IMMEDIATE)", () => {
    // reads and writes both: deferred, the transaction would begin and its first
    // statement meet the lock; immediate, nothing runs before the lock is held
    let reads = 0;
    const counted: SqlDriver = {
      ...file,
      all: (sql, params) => (reads++, file.all(sql, params)),
      run: (sql, params) => (reads++, file.run(sql, params)),
    };
    other.exec("BEGIN IMMEDIATE; INSERT INTO settings (key, value) VALUES ('lock', 'x')");
    expect(() => leaseNextJob(counted, { kinds: ["extract"], now: T0, leaseMs: LEASE })).toThrow(
      /locked|busy/i,
    );
    expect(reads).toBe(0);
    other.exec("COMMIT");
    expect(leaseNextJob(counted, { kinds: ["extract"], now: T0, leaseMs: LEASE })).toMatchObject({
      status: "running",
    });
  });

  it("lease.reclaim: reclaimLeases on its own also reads a clock function only under the lock", () => {
    const reads: number[] = [];
    const clock = () => (reads.push(reads.length), at(10 * LEASE));
    leaseNextJob(file, { kinds: ["extract"], now: T0, leaseMs: LEASE });
    other.exec("BEGIN IMMEDIATE; INSERT INTO settings (key, value) VALUES ('lock', 'x')");
    expect(() => reclaimLeases(file, { kinds: ["extract"], now: clock, leaseMs: LEASE })).toThrow(
      /locked|busy/i,
    );
    expect(reads).toEqual([]);
    other.exec("COMMIT");
    expect(reclaimLeases(file, { kinds: ["extract"], now: clock, leaseMs: LEASE })).toBe(1);
    expect(reads).toEqual([0]);
  });

  it("lease.pick: reads a clock function once, after the lock is held (review RA-1)", () => {
    const reads: number[] = [];
    const clock = () => (reads.push(reads.length), T0);
    other.exec("BEGIN IMMEDIATE; INSERT INTO settings (key, value) VALUES ('lock', 'x')");
    expect(() => leaseNextJob(file, { kinds: ["extract"], now: clock, leaseMs: LEASE })).toThrow(
      /locked|busy/i,
    );
    expect(reads).toEqual([]); // the lock was not held: the clock was never read
    other.exec("COMMIT");
    expect(leaseNextJob(file, { kinds: ["extract"], now: clock, leaseMs: LEASE })).toMatchObject({
      status: "running",
      leaseUntil: T0.getTime() + LEASE,
    });
    expect(reads).toEqual([0]);
  });
});
