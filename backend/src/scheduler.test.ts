// I03-C2 proofs of the scheduler (I03-R18, R20, R21 cap, R22): the schedule table, the
// check (coalescing, the (schedule, slot) key, pause, the open-job cap), the clock
// discontinuities and the schedule API. The clock is injected; nothing sleeps.
import {
  closeJob,
  leaseNextJob,
  readJob,
  registerJob,
  releaseRetryJobs,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { BACKOFF_MAX_MS, type Period } from "./schedule.ts";
import { createScheduler, OPEN_JOB_CAP, OPEN_JOB_WARN_RATIO, type Scheduler } from "./scheduler.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-21T00:00:00.000Z");
const ZONE = "UTC";

let dir: string;
let db: SqlDriver;
const open: SqlDriver[] = [];
let wall = T0;
let sleepers: (() => void)[] = [];
const clock: Clock = {
  now: () => wall,
  sleep: () => new Promise<void>((resolve) => sleepers.push(resolve)),
  monotonic: () => 0,
};

function reopen(): SqlDriver {
  const next = openCanonicalDb(join(dir, "data"));
  open.push(next);
  return next;
}

function scheduler(options: Partial<Parameters<typeof createScheduler>[0]> = {}): Scheduler {
  return createScheduler({ db, clock, timeZone: () => ZONE, ...options });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-scheduler-"));
  db = reopen();
  wall = T0;
  sleepers = [];
});

afterEach(() => {
  for (const d of open.splice(0)) d.close();
  rmSync(dir, { recursive: true, force: true });
});

const tenMinutes: Period = { kind: "every-10-minutes" };
const hourly: Period = { kind: "hourly" };
const daily: Period = { kind: "daily", at: { hour: 3, minute: 0 } };
const weekly: Period = { kind: "weekly", weekday: 1, at: { hour: 3, minute: 0 } };

/** Claims the next job of a kind and closes it as `closing` says. */
function finish(
  closing: Parameters<typeof closeJob>[2] = { status: "succeeded", write: () => undefined },
  kind = "connector-sync",
): StoredJob {
  const job = leaseNextJob(db, { kinds: [kind], now: new Date(wall), leaseMs: HOUR });
  if (!job) throw new Error("no job to claim");
  closeJob(db, job, closing, new Date(wall));
  return readJob(db, job.id) as StoredJob;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const jobsOf = (scheduleId: number) =>
  db.all("SELECT id, slot, status FROM jobs WHERE schedule_id = ? ORDER BY id", [scheduleId]);

describe("coalesce.sleep", () => {
  it("runs a 10-minute period once for 48 missed slots, the next due 10 minutes past the wake", () => {
    const s = scheduler();
    wall = T0 + 5 * MIN;
    const { schedule } = s.ensureSchedule({
      kind: "connector-sync",
      target: "c1",
      period: tenMinutes,
    });
    expect(schedule.nextDue).toBe(T0 + 10 * MIN);
    wall = T0 + 8 * HOUR; // no check in between: the machine slept
    const report = s.check();
    expect(report.due).toEqual([
      { scheduleId: schedule.id, outcome: "registered", missed: 48, jobId: expect.any(Number) },
    ]);
    expect(jobsOf(schedule.id)).toEqual([
      { id: report.due[0]?.jobId, slot: T0 + 8 * HOUR, status: "queued" },
    ]);
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + 8 * HOUR + 10 * MIN);
    expect(s.get(schedule.id)?.lastMissed).toBe(48);
  });

  it("runs a weekly period once after three skipped weeks", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: weekly });
    wall = T0 + 22 * DAY;
    const report = s.check();
    expect(report.due).toHaveLength(1);
    expect(report.due[0]).toMatchObject({ outcome: "registered", missed: 3 });
    expect(jobsOf(schedule.id)).toHaveLength(1);
  });

  it("does nothing while no period is due", () => {
    const s = scheduler();
    s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + 59 * MIN;
    expect(s.check().due).toEqual([]);
  });
});

describe("coalesce.restart", () => {
  it("a backend stopped for two hours starts one job, and the table is read back from the file", () => {
    const first = scheduler();
    const { schedule } = first.ensureSchedule({
      kind: "connector-sync",
      target: "c1",
      period: hourly,
    });
    db.close();
    wall = T0 + 2 * HOUR + 5 * MIN;
    db = reopen();
    const second = scheduler();
    const report = second.start();
    expect(report?.due).toEqual([
      { scheduleId: schedule.id, outcome: "registered", missed: 2, jobId: expect.any(Number) },
    ]);
    second.stop();
    expect(jobsOf(schedule.id)).toHaveLength(1);
  });

  it.each(["retry", "held"] as const)(
    "a job left in %s is not joined by a new one: it counts as coalesced",
    (parked) => {
      const s = scheduler();
      const { schedule } = s.ensureSchedule({
        kind: "connector-sync",
        target: "c1",
        period: hourly,
      });
      wall += HOUR;
      s.check();
      finish(
        parked === "retry"
          ? { status: "retry", reason: "storage-failed", runAfter: wall + HOUR }
          : { status: "held", reason: "no-provider" },
      );
      wall += 2 * HOUR;
      const report = s.check();
      expect(report.due).toEqual([{ scheduleId: schedule.id, outcome: "coalesced", missed: 2 }]);
      expect(jobsOf(schedule.id)).toHaveLength(1);
      const view = s.get(schedule.id);
      expect(view?.counts[parked === "held" ? "heldCoalesced" : "coalesced"]).toBe(1);
      expect(view?.pause).toEqual(
        parked === "held" ? { kind: "held", reason: "no-provider" } : undefined,
      );
    },
  );

  it("a held period shows its pause and clears it once the job ends", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall += HOUR;
    s.check();
    finish({ status: "held", reason: "no-provider" });
    expect(s.get(schedule.id)?.pause).toEqual({ kind: "held", reason: "no-provider" });
    db.run("UPDATE jobs SET status = 'queued', reason = NULL WHERE schedule_id = ?", [schedule.id]);
    finish();
    expect(s.get(schedule.id)?.pause).toBeUndefined();
  });
});

describe("clock.jump", () => {
  it("a clock set back a day does not stall the period; a slot seen again counts as already run", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + 11 * HOUR + 30 * 1000; // slot 11:00
    s.check();
    finish();
    const slot11 = T0 + 11 * HOUR;
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + 12 * HOUR);

    wall = T0 + 11 * HOUR - DAY + 30 * MIN; // the clock went back a day
    const back = s.check();
    expect(back.discontinuity).toBe(true);
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + 12 * HOUR - DAY); // recomputed from now
    expect(back.due).toEqual([]);

    wall = T0 + 12 * HOUR - DAY + 30 * 1000; // not stalled: its next slot runs
    expect(s.check().due[0]).toMatchObject({ outcome: "registered" });
    finish();

    wall = slot11 + 30 * MIN; // forward again: the day-old slot 11:00 is computed once more
    const again = s.check();
    expect(again.due).toEqual([{ scheduleId: schedule.id, outcome: "already-ran", missed: 23 }]);
    expect(s.get(schedule.id)?.counts.alreadyRan).toBe(1);
    expect(jobsOf(schedule.id).filter((j) => j.slot === slot11)).toHaveLength(1);
    expect(jobsOf(schedule.id)).toHaveLength(2);
  });

  it("a slot seen again while its job is still open counts as coalesced", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + 11 * HOUR + 1000;
    s.check();
    wall = T0 + 11 * HOUR - DAY + 30 * MIN;
    s.check();
    wall = T0 + 11 * HOUR + 30 * MIN;
    expect(s.check().due[0]).toMatchObject({ outcome: "coalesced" });
    expect(jobsOf(schedule.id)).toHaveLength(1);
  });

  it("a day ahead starts one job per period", () => {
    const s = scheduler();
    const ids = [tenMinutes, hourly, daily].map(
      (period, i) =>
        s.ensureSchedule({ kind: "connector-sync", target: `c${i}`, period }).schedule.id,
    );
    s.check();
    wall = T0 + DAY + 2 * HOUR;
    const report = s.check();
    expect(report.discontinuity).toBe(true);
    expect(report.due.map((d) => d.outcome)).toEqual(["registered", "registered", "registered"]);
    for (const id of ids) expect(jobsOf(id)).toHaveLength(1);
  });

  it("the discontinuity is a difference over twice the interval or a negative one", () => {
    const s = scheduler({ intervalMs: 30_000 });
    expect(s.check().discontinuity).toBe(false); // the first check has nothing to compare
    wall += 60_000;
    expect(s.check().discontinuity).toBe(false);
    wall += 60_001;
    expect(s.check().discontinuity).toBe(true);
    wall -= 1;
    expect(s.check().discontinuity).toBe(true);
  });

  it("pulls stored run times that lie past now plus the backoff cap back to it (clampRunAt)", () => {
    const s = scheduler();
    const queued = registerJob(db, { kind: "test-effect", target: "a", at: new Date(wall) });
    const retry = registerJob(db, { kind: "test-effect", target: "b", at: new Date(wall) });
    const fine = registerJob(db, { kind: "test-effect", target: "c", at: new Date(wall) });
    if (!queued.registered || !retry.registered || !fine.registered) throw new Error("register");
    db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [wall + DAY, queued.job.id]);
    db.run("UPDATE jobs SET status = 'retry', run_after = ? WHERE id = ?", [
      wall + 9 * DAY,
      retry.job.id,
    ]);
    db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [wall + BACKOFF_MAX_MS, fine.job.id]);
    const report = s.check();
    expect(report.pulledBack).toBe(2);
    expect((readJob(db, queued.job.id) as StoredJob).runAfter).toBe(wall + BACKOFF_MAX_MS);
    expect((readJob(db, retry.job.id) as StoredJob).runAfter).toBe(wall + BACKOFF_MAX_MS);
    expect((readJob(db, fine.job.id) as StoredJob).runAfter).toBe(wall + BACKOFF_MAX_MS);
    expect(s.check().pulledBack).toBe(0);
  });
});

describe("backlog.bound", () => {
  const sourceless = (n: number) =>
    registerJob(db, { kind: "test-effect", target: `fill-${n}`, at: new Date(wall) });

  it("skips scheduled jobs while the open jobs are at the cap; an import still registers", () => {
    const s = scheduler({ openJobCap: 10 });
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    for (let i = 0; i < 10; i++) sourceless(i);
    wall = T0 + HOUR + 1000;
    const report = s.check();
    expect(report.due).toEqual([{ scheduleId: schedule.id, outcome: "skipped", missed: 1 }]);
    expect(report.backlog).toEqual({ open: 10, cap: 10, warning: true });
    expect(jobsOf(schedule.id)).toEqual([]);
    expect(s.get(schedule.id)?.counts.skipped).toBe(1);
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + 2 * HOUR); // the slot is not counted twice
    expect(sourceless(11).registered).toBe(true); // a user's import is not refused
    // room again: the next slot goes in
    db.run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE target = 'fill-0'", [wall]);
    db.run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE target = 'fill-1'", [wall]);
    db.run("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE target = 'fill-11'", [
      wall,
    ]);
    wall = T0 + 2 * HOUR + 1000;
    expect(s.check().due[0]).toMatchObject({ outcome: "registered" });
  });

  it("raises the warning at 90% of the cap and not below it", () => {
    expect(OPEN_JOB_CAP).toBe(1000);
    expect(OPEN_JOB_WARN_RATIO).toBe(0.9);
    const s = scheduler({ openJobCap: 10 });
    for (let i = 0; i < 8; i++) sourceless(i);
    expect(s.backlog()).toEqual({ open: 8, cap: 10, warning: false });
    sourceless(8);
    expect(s.backlog()).toEqual({ open: 9, cap: 10, warning: true });
    expect(s.check().backlog.warning).toBe(true);
  });

  it("never holds more than one open job per schedule, whatever the order of checks", () => {
    const s = scheduler({ openJobCap: 1000 });
    const ids = [tenMinutes, hourly, daily, weekly].map(
      (period, i) =>
        s.ensureSchedule({ kind: "connector-sync", target: `c${i}`, period }).schedule.id,
    );
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let step = 0; step < 400; step++) {
      const move = random();
      if (move < 0.15)
        wall -= Math.floor(random() * 2 * DAY); // the clock goes back
      else wall += Math.floor(random() * 3 * HOUR);
      if (random() < 0.5) s.check();
      if (random() < 0.4) {
        const job = leaseNextJob(db, {
          kinds: ["connector-sync"],
          now: new Date(wall),
          leaseMs: HOUR,
        });
        if (job) {
          const r = random();
          closeJob(
            db,
            job,
            r < 0.5
              ? { status: "succeeded", write: () => undefined }
              : r < 0.8
                ? { status: "held", reason: "no-provider" }
                : { status: "retry", reason: "storage-failed", runAfter: wall + MIN },
            new Date(wall),
          );
        }
      }
      for (const id of ids) {
        const open = db.all(
          "SELECT count(*) AS n FROM jobs WHERE schedule_id = ? AND status IN ('queued','running','retry','held')",
          [id],
        )[0]?.n;
        expect(open).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("schedule.pause", () => {
  /** Runs the one job of a schedule into dead_letter by `attempts` retryable failures. */
  function exhaust(): StoredJob {
    let job: StoredJob | undefined;
    for (let i = 0; i < 5; i++) {
      job = finish({ status: "retry", reason: "storage-failed", runAfter: wall + MIN });
      wall += MIN;
      releaseRetryJobs(db, { kinds: ["connector-sync"], now: new Date(wall) });
      job = readJob(db, job.id);
    }
    return job as StoredJob;
  }

  it("pauses a period whose job gave up after the attempts ran out, until it is enabled again", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + HOUR + 1000;
    s.check();
    expect(exhaust().status).toBe("dead_letter");
    wall = T0 + 3 * HOUR;
    const report = s.check();
    expect(report.due).toEqual([{ scheduleId: schedule.id, outcome: "paused", missed: 2 }]);
    expect(s.get(schedule.id)?.pause).toEqual({ kind: "failed", code: "storage-failed" });
    expect(jobsOf(schedule.id)).toHaveLength(1);
    wall = T0 + 6 * HOUR;
    s.check();
    expect(jobsOf(schedule.id)).toHaveLength(1);
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + 7 * HOUR); // it keeps moving
    s.enable(schedule.id);
    expect(s.get(schedule.id)?.pause).toBeUndefined();
    wall = T0 + 7 * HOUR + 1000;
    expect(s.check().due[0]).toMatchObject({ outcome: "registered" });
    expect(jobsOf(schedule.id)).toHaveLength(2);
  });

  it("pauses a period whose job gave up on a failure that cannot be retried", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + HOUR + 1000;
    s.check();
    finish({ status: "dead_letter", reason: "permission-denied" });
    wall += HOUR;
    expect(s.check().due[0]).toMatchObject({ outcome: "paused" });
    expect(s.get(schedule.id)?.pause).toEqual({ kind: "failed", code: "permission-denied" });
  });

  it("a dead letter the user retried by hand and that gave up again pauses it again", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + HOUR + 1000;
    s.check();
    const dead = finish({ status: "dead_letter", reason: "permission-denied" });
    wall += HOUR;
    s.check();
    s.enable(schedule.id);
    wall += 1000;
    s.check(); // the old dead letter does not pause it again
    expect(s.get(schedule.id)?.pause).toBeUndefined();
    db.run("UPDATE jobs SET status = 'queued', reason = NULL, finished_at = NULL WHERE id = ?", [
      dead.id,
    ]);
    wall += 1000;
    finish({ status: "dead_letter", reason: "other-code" });
    wall += HOUR;
    s.check();
    expect(s.get(schedule.id)?.pause).toEqual({ kind: "failed", code: "other-code" });
  });

  it("does not pause the maintenance period: it runs the next slot and leaves a warning", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "maintenance", period: daily });
    wall = T0 + 3 * HOUR + 1000;
    s.check();
    const job = readJob(db, (jobsOf(schedule.id)[0] as { id: number }).id) as StoredJob;
    expect(job.priority).toBe("maintenance");
    finish({ status: "dead_letter", reason: "storage-failed" }, "maintenance");
    wall = T0 + DAY + 3 * HOUR + 1000;
    const report = s.check();
    expect(report.due[0]).toMatchObject({ outcome: "registered" });
    expect(jobsOf(schedule.id)).toHaveLength(2);
    expect(s.get(schedule.id)?.pause).toBeUndefined();
    expect(s.get(schedule.id)?.warning).toBe("storage-failed");
    finish(undefined, "maintenance"); // a later run that succeeds takes the warning away
    wall += DAY;
    s.check();
    expect(s.get(schedule.id)?.warning).toBeUndefined();
  });
});

describe("schedule.config", () => {
  it("changes a period to each of the four, moving the next due time to the new grid", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + 90 * MIN;
    const expected: [Period, number][] = [
      [tenMinutes, T0 + 100 * MIN],
      [hourly, T0 + 2 * HOUR],
      [daily, T0 + 3 * HOUR],
      [weekly, Date.parse("2026-11-23T03:00:00Z")],
    ];
    for (const [period, nextDue] of expected) {
      const changed = s.change(schedule.id, period);
      expect(changed.period).toEqual(period);
      expect(changed.nextDue).toBe(nextDue);
    }
  });

  it("refuses a period that is not one of the four or is out of range", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    expect(() => s.change(schedule.id, { kind: "monthly" } as unknown as Period)).toThrow(
      RangeError,
    );
    expect(() => s.change(schedule.id, { kind: "daily", at: { hour: 24, minute: 0 } })).toThrow(
      RangeError,
    );
    expect(() =>
      s.change(schedule.id, { kind: "weekly", weekday: 7 as 0, at: { hour: 1, minute: 0 } }),
    ).toThrow(RangeError);
    expect(s.get(schedule.id)?.period).toEqual(hourly);
    expect(() => s.change(9999, hourly)).toThrow(/no schedule/);
  });

  it("disables a period so nothing is registered, and enabling again starts from the next slot", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    s.disable(schedule.id);
    wall = T0 + 5 * HOUR;
    expect(s.check().due).toEqual([]);
    expect(jobsOf(schedule.id)).toEqual([]);
    const enabled = s.enable(schedule.id);
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextDue).toBe(T0 + 6 * HOUR); // no burst for the time it was off
    wall = T0 + 6 * HOUR + 1000;
    expect(s.check().due[0]).toMatchObject({ outcome: "registered", missed: 1 });
  });

  it("runs now with the user's priority, once while one is open, without moving the next due time", () => {
    const s = scheduler();
    const { schedule } = s.ensureSchedule({ kind: "connector-sync", target: "c1", period: hourly });
    wall = T0 + 10 * MIN;
    const first = s.runNow(schedule.id);
    expect(first.registered).toBe(true);
    expect(first.job.priority).toBe("user");
    expect(first.job.scheduleId).toBe(schedule.id);
    expect(s.runNow(schedule.id)).toMatchObject({ registered: false, job: { id: first.job.id } });
    expect(s.get(schedule.id)?.nextDue).toBe(T0 + HOUR);
    s.disable(schedule.id);
    finish();
    expect(s.runNow(schedule.id).registered).toBe(true); // also while it is off
  });

  it("keeps a changed period, its disabled state and its counters across a restart", () => {
    const first = scheduler();
    const { schedule } = first.ensureSchedule({
      kind: "connector-sync",
      target: "c1",
      period: hourly,
    });
    first.change(schedule.id, weekly);
    first.disable(schedule.id);
    expect(
      first.ensureSchedule({ kind: "connector-sync", target: "c1", period: daily }).created,
    ).toBe(false); // one period per (kind, target); the stored one stands
    db.close();
    db = reopen();
    const again = scheduler().get(schedule.id);
    expect(again).toMatchObject({ period: weekly, enabled: false, zone: ZONE });
    expect(
      scheduler()
        .list()
        .map((v) => v.id),
    ).toEqual([schedule.id]);
  });

  it("stores the zone with the period and rezones a daily period when the zone changes", () => {
    let zone = "Asia/Seoul";
    const s = scheduler({ timeZone: () => zone });
    const { schedule } = s.ensureSchedule({ kind: "maintenance", period: daily });
    expect(schedule.zone).toBe("Asia/Seoul");
    expect(schedule.nextDue).toBe(Date.parse("2026-11-21T18:00:00Z")); // 03:00 KST
    zone = "Europe/London";
    s.check();
    expect(s.get(schedule.id)?.zone).toBe("Europe/London");
    expect(s.get(schedule.id)?.nextDue).toBe(Date.parse("2026-11-21T03:00:00Z"));
  });
});

describe("schedule.loop", () => {
  it("checks at start, then every interval, and stops", async () => {
    const s = scheduler({ intervalMs: 30_000 });
    const { schedule } = s.ensureSchedule({
      kind: "connector-sync",
      target: "c1",
      period: tenMinutes,
    });
    wall = T0 + 10 * MIN + 1000;
    s.start(); // the first check runs before any sleep
    expect(jobsOf(schedule.id)).toHaveLength(1);
    finish();
    expect(sleepers).toHaveLength(1);
    wall += 10 * MIN;
    sleepers.shift()?.();
    await flush();
    expect(jobsOf(schedule.id)).toHaveLength(2);
    const stopped = s.stop();
    await stopped;
    sleepers.splice(0).forEach((wake) => wake());
    await flush();
    wall += HOUR;
    expect(jobsOf(schedule.id)).toHaveLength(2);
  });

  it("reports a failing check to onError and goes on", async () => {
    const errors: unknown[] = [];
    const s = scheduler({ onError: (e) => errors.push(e), timeZone: () => "No/Such_Zone" });
    s.ensureSchedule({ kind: "maintenance", period: daily, zone: "UTC" });
    wall += HOUR;
    s.start();
    expect(errors).toHaveLength(1);
    expect(sleepers).toHaveLength(1);
    await s.stop();
  });
});
