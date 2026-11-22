// I03-T07, the storage half of R12 (cancel, discard, manual retry) and R16 (the
// held jobs a condition's change puts back in the queue): `cancel`,
// `cancel.flag-exits`, `manual-retry` and the release functions `held.release`,
// `held.precheck` build on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  closeJob,
  heartbeatJob,
  leaseNextJob,
  readJob,
  reclaimLeases,
  registerJob,
  type JobClosing,
  type JobStatus,
  type StoredJob,
} from "./jobs.ts";
import {
  cancelJob,
  discardJob,
  heldGroups,
  requeueHeldOnFingerprint,
  requeueHeldReasons,
  retryJob,
} from "./job-actions.ts";
import { migrate } from "./migrations.ts";
import { createSchedule, readSchedule } from "./schedules.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "b" });
});
afterEach(() => db.close());

const T0 = new Date("2026-11-21T00:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const LEASE = 60_000;

let seq = 0;
/** A queued extract job; each call stores a new version of the one source, so the keys differ. */
function registered(): StoredJob {
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: `b${(seq += 1)}` });
  const row = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = 1")[0];
  const r = registerJob(db, {
    kind: "extract",
    sourceId: 1,
    fenceVersion: row?.v as number,
    at: T0,
  });
  if (!r.registered) throw new Error("expected a new job");
  return r.job;
}
/** The job claimed (queued → running). */
function running(): StoredJob {
  const job = registered();
  const claimed = leaseNextJob(db, { kinds: ["extract"], now: T0, leaseMs: LEASE });
  if (claimed?.id !== job.id) throw new Error("expected to claim the new job");
  return claimed;
}
const lease = (id: number) => ({ id, leaseToken: readJob(db, id)?.leaseToken ?? 0 });
const state = (id: number) => readJob(db, id) as StoredJob;
/** A job moved to `status` the way its own path would leave it. */
function inStatus(status: JobStatus): StoredJob {
  if (status === "queued") return registered();
  const job = running();
  const close = (closing: JobClosing) => closeJob(db, lease(job.id), closing, at(1));
  switch (status) {
    case "running":
      return job;
    case "succeeded":
      close({ status: "succeeded", write: () => {} });
      break;
    case "superseded":
      close({ status: "superseded" });
      break;
    case "dead_letter":
      close({ status: "dead_letter", reason: "invalid-output" });
      break;
    case "held":
      close({ status: "held", reason: "no-consent" });
      break;
    case "retry":
      close({ status: "retry", reason: "timeout", runAfter: at(99_000).getTime() });
      break;
    case "cancelled":
      cancelJob(db, job.id, at(1));
      close({ status: "succeeded", write: () => {} });
      break;
  }
  return state(job.id);
}

describe("cancel (I03-R12 ③, C3)", () => {
  it.each(["queued", "retry", "held"] as const)("closes a %s job cancelled at once", (status) => {
    const job = inStatus(status);
    expect(cancelJob(db, job.id, at(2))).toBe("cancelled");
    expect(state(job.id)).toMatchObject({
      status: "cancelled",
      reason: null,
      leaseUntil: null,
      finishedAt: at(2).getTime(),
    });
  });

  it("only writes the cancel request on a running job, which stays running for its holder", () => {
    const job = inStatus("running");
    expect(cancelJob(db, job.id, at(2))).toBe("requested");
    expect(state(job.id)).toMatchObject({
      status: "running",
      cancelRequested: true,
      leaseToken: job.leaseToken,
    });
    // asking twice changes nothing more
    expect(cancelJob(db, job.id, at(3))).toBe("requested");
  });

  it.each(["succeeded", "superseded", "cancelled"] as const)(
    "says a %s job is finished and changes nothing",
    (status) => {
      const job = inStatus(status);
      const before = state(job.id);
      expect(cancelJob(db, job.id, at(9))).toBe("finished");
      expect(state(job.id)).toEqual(before);
    },
  );

  it("leaves a dead letter to discarding, and names an unknown job", () => {
    const job = inStatus("dead_letter");
    expect(cancelJob(db, job.id, at(2))).toBe("not-cancellable");
    expect(state(job.id).status).toBe("dead_letter");
    expect(cancelJob(db, 9999, at(2))).toBe("not-found");
  });
});

describe("cancel.flag-exits (I03-R12, R5, R6 ②)", () => {
  const closings: [string, JobClosing][] = [
    ["succeeded", { status: "succeeded", write: () => {} }],
    ["held", { status: "held", reason: "no-consent" }],
    ["retry", { status: "retry", reason: "timeout", runAfter: 1 }],
    ["dead_letter", { status: "dead_letter", reason: "invalid-output" }],
    ["a yield (queued)", { status: "queued", runAfter: 1 }],
    ["superseded", { status: "superseded" }],
  ];

  it.each(closings)(
    "closes a flagged running job cancelled whatever it ends with: %s",
    (_, closing) => {
      const job = inStatus("running");
      let wrote = false;
      cancelJob(db, job.id, at(2));
      const result = closeJob(
        db,
        lease(job.id),
        closing.status === "succeeded"
          ? { status: "succeeded", write: () => void (wrote = true) }
          : closing,
        at(3),
      );
      expect(result).toBe("cancelled");
      expect(wrote).toBe(false);
      expect(state(job.id)).toMatchObject({ status: "cancelled", reason: null });
    },
  );

  it("closes a flagged job cancelled when its lease is reclaimed, with attempts left", () => {
    const job = inStatus("running");
    cancelJob(db, job.id, at(2));
    expect(reclaimLeases(db, { kinds: ["extract"], now: at(LEASE + 1), leaseMs: LEASE })).toBe(1);
    expect(state(job.id).status).toBe("cancelled");
  });

  it("does not claim a flagged job whose holder died, and stops its heartbeat", () => {
    const job = inStatus("running");
    cancelJob(db, job.id, at(2));
    // the holder died: the flagged job is not claimed again, whatever the due time
    expect(leaseNextJob(db, { kinds: ["extract"], now: at(LEASE * 3), leaseMs: LEASE })).toBe(
      undefined,
    );
    expect(state(job.id).status).toBe("cancelled");
    expect(heartbeatJob(db, lease(job.id), { now: at(LEASE * 3), leaseMs: LEASE })).toBe(false);
  });

  it("clears the flag of a dead letter that is tried again, so a claim does not close it", () => {
    const job = inStatus("running");
    cancelJob(db, job.id, at(2));
    db.run("UPDATE jobs SET status = 'dead_letter' WHERE id = ?", [job.id]); // as a race left it
    expect(state(job.id).cancelRequested).toBe(true);
    expect(retryJob(db, job.id, at(4))).toBe("queued");
    expect(state(job.id).cancelRequested).toBe(false);
    const claimed = leaseNextJob(db, { kinds: ["extract"], now: at(5), leaseMs: LEASE });
    expect(claimed).toMatchObject({ id: job.id, status: "running" });
  });
});

describe("manual-retry and discard (I03-R12 ① ②, C3)", () => {
  it.each(["dead_letter", "held"] as const)(
    "queues a %s job again: no attempts, user priority",
    (status) => {
      const job = inStatus(status);
      db.run("UPDATE jobs SET attempts = 5, priority = 'maintenance' WHERE id = ?", [job.id]);
      expect(retryJob(db, job.id, at(10))).toBe("queued");
      expect(state(job.id)).toMatchObject({
        status: "queued",
        attempts: 0,
        priority: "user",
        reason: null,
        cancelRequested: false,
        runAfter: at(10).getTime(),
        finishedAt: null,
        policyFingerprint: null,
      });
    },
  );

  it("keeps a dead letter's checkpoint for the new run to go on from", () => {
    const job = inStatus("dead_letter");
    db.run("UPDATE jobs SET checkpoint = '{\"page\":3}' WHERE id = ?", [job.id]);
    retryJob(db, job.id, at(10));
    expect(state(job.id).checkpoint).toBe('{"page":3}');
  });

  it.each(["queued", "running", "retry", "succeeded", "superseded", "cancelled"] as const)(
    "does not retry a %s job",
    (status) => {
      const job = inStatus(status);
      const before = state(job.id);
      expect(retryJob(db, job.id, at(10))).toBe("not-retryable");
      expect(state(job.id)).toEqual(before);
    },
  );

  it("answers duplicate-open when an open job already holds the key a dead letter would take", () => {
    const first = registerJob(db, { kind: "projection-rebuild", target: "engine", at: T0 });
    if (!first.registered) throw new Error("expected a new job");
    db.run("UPDATE jobs SET status = 'dead_letter', finished_at = 1 WHERE id = ?", [first.job.id]);
    const second = registerJob(db, { kind: "projection-rebuild", target: "engine", at: T0 });
    expect(second.registered).toBe(true);
    expect(retryJob(db, first.job.id, at(10))).toBe("duplicate-open");
    expect(state(first.job.id).status).toBe("dead_letter");
  });

  describe("manual-retry.revives-schedule-marker (I03-T08 handoff)", () => {
    let targets = 0;
    const schedule = () =>
      createSchedule(db, {
        kind: "extract",
        target: `t${(targets += 1)}`,
        period: "{}",
        zone: "UTC",
        nextDue: 1,
        at: 1,
      }).schedule;
    const scheduledJob = (scheduleId: number, status: JobStatus): StoredJob => {
      const r = registerJob(db, {
        kind: "extract",
        sourceId: 1,
        fenceVersion: 1,
        schedule: { id: scheduleId, slot: 1 },
        at: T0,
      });
      if (!r.registered) throw new Error("expected a new job");
      db.run("UPDATE jobs SET status = ?, finished_at = 1 WHERE id = ?", [status, r.job.id]);
      return state(r.job.id);
    };
    const scheduledDeadLetter = (scheduleId: number): StoredJob =>
      scheduledJob(scheduleId, "dead_letter");

    it("records the revived job on its schedule, in the retry's transaction", () => {
      const { id } = schedule();
      const job = scheduledDeadLetter(id);
      expect(readSchedule(db, id)?.revivedJob).toBe(0);
      expect(retryJob(db, job.id, at(10))).toBe("queued");
      expect(readSchedule(db, id)?.revivedJob).toBe(job.id);
    });

    it("writes nothing for a job without a schedule", () => {
      const { id } = schedule();
      expect(retryJob(db, inStatus("dead_letter").id, at(10))).toBe("queued");
      expect(readSchedule(db, id)?.revivedJob).toBe(0);
    });

    it("writes nothing for a held job of a schedule (never a dead letter)", () => {
      const { id } = schedule();
      const held = scheduledJob(id, "held");
      expect(retryJob(db, held.id, at(10))).toBe("queued");
      expect(readSchedule(db, id)?.revivedJob).toBe(0);
    });

    it("writes nothing when the retry is refused", () => {
      const { id } = schedule();
      const done = scheduledJob(id, "succeeded");
      expect(retryJob(db, done.id, at(10))).toBe("not-retryable");
      expect(readSchedule(db, id)?.revivedJob).toBe(0);
    });
  });

  it("discards a dead letter as cancelled, and nothing else", () => {
    const dead = inStatus("dead_letter");
    expect(discardJob(db, dead.id, at(7))).toBe("discarded");
    expect(state(dead.id)).toMatchObject({ status: "cancelled", finishedAt: at(7).getTime() });
    const held = inStatus("held");
    expect(discardJob(db, held.id, at(7))).toBe("not-dead-letter");
    expect(state(held.id).status).toBe("held");
    expect(discardJob(db, 9999, at(7))).toBe("not-found");
  });
});

describe("releasing held jobs (I03-R16)", () => {
  const hold = (reason: string, fingerprint: string | null = null, kind = "extract"): number => {
    const job = inStatus("held");
    db.run("UPDATE jobs SET reason = ?, policy_fingerprint = ?, kind = ? WHERE id = ?", [
      reason,
      fingerprint,
      kind,
      job.id,
    ]);
    return job.id;
  };

  it("requeues only the held jobs of the named reasons, spending no attempt", () => {
    const a = hold("no-consent");
    const b = hold("cli-background-off");
    const c = hold("source-too-large");
    expect(requeueHeldReasons(db, { reasons: ["no-consent", "cli-unknown"], at: at(5) })).toBe(1);
    expect(state(a)).toMatchObject({ status: "queued", reason: null, attempts: 0 });
    expect(state(b).status).toBe("held");
    expect(state(c).status).toBe("held");
  });

  it("narrows a release to one kind", () => {
    const a = hold("cli-not-verified", null, "extract");
    const b = hold("cli-not-verified", null, "connector-sync");
    expect(
      requeueHeldReasons(db, { reasons: ["cli-not-verified"], kind: "extract", at: at(5) }),
    ).toBe(1);
    expect(state(a).status).toBe("queued");
    expect(state(b).status).toBe("held");
  });

  it("groups the held jobs by reason and kind", () => {
    hold("cli-not-verified");
    hold("cli-not-verified");
    hold("no-consent");
    expect(heldGroups(db)).toEqual([
      { reason: "cli-not-verified", kind: "extract", count: 2 },
      { reason: "no-consent", kind: "extract", count: 1 },
    ]);
  });

  it("releases on a policy fingerprint: an empty one counts as changed, a different one only for the policy reasons", () => {
    const empty = hold("no-consent", null);
    const sameConsent = hold("no-consent", "fp-1");
    const changedRule = hold("rule-denied", "fp-1");
    const same = hold("rule-denied", "fp-2");
    const size = hold("source-too-large", null);
    const n = requeueHeldOnFingerprint(db, {
      fingerprint: "fp-2",
      reasons: ["no-consent", "rule-denied"],
      changedReasons: ["rule-denied"],
      at: at(5),
    });
    expect(n).toBe(2);
    expect(state(empty).status).toBe("queued");
    expect(state(changedRule).status).toBe("queued");
    expect(state(sameConsent).status).toBe("held");
    expect(state(same).status).toBe("held");
    expect(state(size).status).toBe("held");
  });

  it("writes the fingerprint on a job a run holds (closeJob)", () => {
    const job = inStatus("running");
    closeJob(
      db,
      lease(job.id),
      { status: "held", reason: "no-consent", policyFingerprint: "fp-9" },
      at(2),
    );
    expect(state(job.id)).toMatchObject({ status: "held", policyFingerprint: "fp-9" });
  });
});
