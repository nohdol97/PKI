// V01-R6 job records: the Broker reads a job to decide that a call is background.
// V02-R3: a job carries its source and the version it was registered for (the fence).
// V02-R4: registered once per kind, source and version, claimed with a lease that
// expires. V02-R5: a result is written only while the fence version is still the
// source's latest and no tombstone covers it; otherwise the job closes superseded.
// I03-R1..R3 (I03-T01): eight statuses and only the drawn transitions, the jobs
// with no source, the three duplicate guards, and closing a source's open jobs.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  closeJob,
  heartbeatJob,
  isJobTransition,
  isReasonCode,
  JOB_STATUSES,
  JobWriteError,
  leaseNextJob,
  readJob,
  registerJob,
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
    expect(fresh.leaseToken).toBeGreaterThan(old.leaseToken);
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

describe("heartbeatJob (I03-R4, the conditional extension T03 runs)", () => {
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
});
