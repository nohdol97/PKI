// The scheduler (I03-R18, R20, R21, R22): the check that turns due periods into at
// most one job each, and the API that changes a period, turns it off and on, and runs
// it now. The slot arithmetic is schedule.ts (pure); the rows are storage's
// schedules.ts; this reads the injected clock and zone and judges, in the order of
// the design's check flowchart:
//   - a next due time past what it can legitimately hold, or a changed zone, is
//     recomputed (reconcileNextDue); stored job run times past now + the backoff cap
//     are pulled back (clampRunAt);
//   - a due period moves its next due time to the first slot after now whatever
//     follows, so a slot is never counted twice;
//   - a paused period registers nothing; one with an open job coalesces; at the cap
//     of open jobs the slot is skipped; a slot whose job exists was already run (or
//     coalesced if that job is open); else one job is registered.
// The loop checks at once on start and every `intervalMs` on a runtime timer (a
// Clock.sleep cannot be cancelled); a check after the clock jumped is itself the one
// that sees the jump. Each schedule is checked on its own: one that throws is
// reported and the rest go on. `onRegistered` fires after the check commits.
import {
  countOpenJobs,
  createSchedule,
  hasSucceededAfter,
  jobOfSlot,
  latestDeadLetterAfter,
  latestDeadLetterId,
  listSchedules,
  openJobOfSchedule,
  pullBackRunAfter,
  readJob,
  readSchedule,
  registerJob,
  updateSchedule,
  type JobPriority,
  type ScheduleCounts,
  type SchedulePatch,
  type SqlDriver,
  type StoredJob,
  type StoredSchedule,
} from "@pki/storage";
import { systemClock, systemTimeZone, type Clock } from "./clock.ts";
import {
  BACKOFF_MAX_MS,
  clampRunAt,
  dueSlots,
  nextSlotAfter,
  reconcileNextDue,
  type Period,
} from "./schedule.ts";

/** Open jobs of every kind at or above this are a full queue (I03-R21). */
export const OPEN_JOB_CAP = 1000;
/** The activity screen warns once the open jobs reach this share of the cap. */
export const OPEN_JOB_WARN_RATIO = 0.9;
/** The time between checks, and a gap over twice it is a clock discontinuity (I03-R22). */
export const CHECK_INTERVAL_MS = 30_000;

/** The cleanup kind: its period never pauses, or the 30-day retention would stop (I03-R20). */
export const MAINTENANCE_KIND = "maintenance";

const PERIOD_KINDS = ["every-10-minutes", "hourly", "daily", "weekly"];

/** Why a period registers nothing: its job gave up, or its job is held (I03-R20). */
export type SchedulePause = { kind: "failed"; code: string } | { kind: "held"; reason: string };

export interface ScheduleView extends Omit<StoredSchedule, "period" | "pausedCode" | "warning"> {
  period: Period;
  pause?: SchedulePause;
  /** The code of the last dead letter of a period that cannot pause. */
  warning?: string;
}

export type DueOutcome = "registered" | "coalesced" | "already-ran" | "skipped" | "paused";

export interface DueReport {
  scheduleId: number;
  outcome: DueOutcome;
  /** Slots from the stored next due time to now, both ends included. */
  missed: number;
  jobId?: number;
}

export interface Backlog {
  open: number;
  cap: number;
  /** At or past OPEN_JOB_WARN_RATIO of the cap. */
  warning: boolean;
}

export interface CheckReport {
  /** The wall clock differed from the last check's by more than twice the interval, or went back. */
  discontinuity: boolean;
  /** Stored job run times pulled back to now + the backoff cap. */
  pulledBack: number;
  due: DueReport[];
  /** Schedules whose check threw (`onError` got each); the others were checked. */
  failed: number[];
  backlog: Backlog;
}

export interface SchedulerDeps {
  db: SqlDriver;
  /** Default systemClock. */
  clock?: Clock;
  /** Read at every check (I03 "시계"); default the runtime's zone. */
  timeZone?: () => string;
  /** Default CHECK_INTERVAL_MS. */
  intervalMs?: number;
  /** Default OPEN_JOB_CAP. */
  openJobCap?: number;
  /** Called after the check that registered a job has committed, so a runner can wake. */
  onRegistered?: (job: StoredJob) => void;
  /** A failed check of the loop; the loop goes on. */
  onError?: (error: unknown) => void;
}

export interface Scheduler {
  /** One check. */
  check(): CheckReport;
  /**
   * Checks now, then every interval until `stop`, on a runtime timer that `stop`
   * cancels (a `Clock.sleep` cannot be cancelled and would hold the exit). Returns
   * the first check's report; undefined if it failed (`onError` got it) or the loop was already running.
   */
  start(): CheckReport | undefined;
  /** Cancels the timer; a check already under way finishes. */
  stop(): void;
  isRunning(): boolean;
  /** Creates the period of (kind, target) unless it exists; the stored one stands (I03-R18). */
  ensureSchedule(input: { kind: string; target?: string; period: Period; zone?: string }): {
    created: boolean;
    schedule: ScheduleView;
  };
  get(id: number): ScheduleView | undefined;
  list(): ScheduleView[];
  /** Changes the period; the next due time is the first slot of the new one after now. */
  change(id: number, period: Period): ScheduleView;
  /** Turns it off: nothing is registered until `enable`. */
  disable(id: number): ScheduleView;
  /** Turns it on and lifts a pause; it starts from the first slot after now, with no burst for the time it was off. */
  enable(id: number): ScheduleView;
  /** Registers a job now with the user's priority; while one is open, that one is returned. */
  runNow(id: number): { registered: boolean; job: StoredJob };
  backlog(): Backlog;
}

/** A period of the four kinds with a valid local time; anything else is a RangeError. */
export function checkedPeriod(value: unknown): Period {
  const period = value as Period | null;
  if (typeof period !== "object" || period === null || !PERIOD_KINDS.includes(period.kind)) {
    throw new RangeError("a period is every-10-minutes, hourly, daily or weekly");
  }
  nextSlotAfter(period, 0, "UTC"); // throws RangeError for a local time or weekday out of range
  return period;
}

const noSuchSchedule = (id: number) => new RangeError(`no schedule ${id}`);

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db } = deps;
  const clock = deps.clock ?? systemClock;
  const zoneNow = deps.timeZone ?? systemTimeZone;
  const intervalMs = deps.intervalMs ?? CHECK_INTERVAL_MS;
  const cap = deps.openJobCap ?? OPEN_JOB_CAP;
  let lastCheckAt: number | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const view = (row: StoredSchedule): ScheduleView => {
    const { period, pausedCode, warning, ...rest } = row;
    const open = openJobOfSchedule(db, row.id);
    const pause: SchedulePause | undefined =
      pausedCode !== null
        ? { kind: "failed", code: pausedCode }
        : open?.status === "held"
          ? { kind: "held", reason: open.reason ?? "unknown" }
          : undefined;
    return {
      ...rest,
      period: JSON.parse(period) as Period,
      ...(pause && { pause }),
      ...(warning !== null && { warning }),
    };
  };
  const stored = (id: number): StoredSchedule => readSchedule(db, id) ?? raise(noSuchSchedule(id));
  const periodOf = (row: StoredSchedule) => JSON.parse(row.period) as Period;

  function backlog(): Backlog {
    const open = countOpenJobs(db);
    return { open, cap, warning: open >= cap * OPEN_JOB_WARN_RATIO };
  }

  /**
   * What a dead letter of the period does: pause it, or warn when it cannot pause
   * (I03-R20). Dead letters are told apart by job ID (a marker that only grows; a
   * clock reading would hide the ones that end after the clock went back).
   */
  function noteFailure(row: StoredSchedule, now: number): StoredSchedule {
    const patch: SchedulePatch = {};
    let seen = row.failureSeenJob;
    let revived = row.revivedJob;
    // a dead letter seen before and taken up again by hand: its next end is news, and
    // only that job's (a newer one already accounted for stays accounted for)
    const open = openJobOfSchedule(db, row.id);
    if (open && open.id <= seen) revived = open.id;
    const dead = latestDeadLetterAfter(db, row.id, seen, revived);
    if (dead) {
      if (dead.id === revived) revived = 0;
      seen = Math.max(seen, dead.id);
      const code = dead.reason ?? "unknown";
      if (row.kind === MAINTENANCE_KIND) patch.warning = code;
      else patch.pausedCode = code;
    } else if (row.warning !== null && hasSucceededAfter(db, row.id, seen)) {
      patch.warning = null; // the cleanup ran again: the warning is over
    }
    if (seen !== row.failureSeenJob) patch.failureSeenJob = seen;
    if (revived !== row.revivedJob) patch.revivedJob = revived;
    if (Object.keys(patch).length === 0) return row;
    updateSchedule(db, row.id, patch, now);
    return stored(row.id);
  }

  function checkOne(
    initial: StoredSchedule,
    now: number,
    zone: string,
    registered: StoredJob[],
  ): DueReport | undefined {
    const row = noteFailure(initial, now);
    const period = periodOf(row);
    const reconciled = reconcileNextDue({
      period,
      nextDue: row.nextDue,
      storedZone: row.zone,
      zone,
      now,
      ...(row.lastRunSlot !== null && { lastRunSlot: row.lastRunSlot }),
    });
    const due = dueSlots(period, reconciled.nextDue, now, reconciled.zone);
    const patch: SchedulePatch = {};
    if (reconciled.nextDue !== row.nextDue) patch.nextDue = reconciled.nextDue;
    if (reconciled.zone !== row.zone) patch.zone = reconciled.zone;
    if (!due) {
      if (Object.keys(patch).length > 0) updateSchedule(db, row.id, patch, now);
      return undefined;
    }
    // the next due time moves whatever follows (flowchart E)
    patch.nextDue = due.nextDue;
    patch.lastMissed = due.missed;
    const finish = (outcome: DueOutcome, count?: keyof ScheduleCounts, extra?: SchedulePatch) => {
      updateSchedule(
        db,
        row.id,
        { ...patch, ...extra, ...(count && { count: { [count]: 1 } }) },
        now,
      );
      return { scheduleId: row.id, outcome, missed: due.missed };
    };
    if (row.pausedCode !== null) return finish("paused");
    const open = openJobOfSchedule(db, row.id);
    if (open) return finish("coalesced", open.status === "held" ? "heldCoalesced" : "coalesced");
    if (due.slot === undefined) {
      updateSchedule(db, row.id, patch, now); // off the grid: only the next due time moves
      return undefined;
    }
    if (countOpenJobs(db) >= cap) return finish("skipped", "skipped");
    const slotJob = jobOfSlot(db, row.id, due.slot);
    if (slotJob) return finish("already-ran", "alreadyRan");
    const job = registerJob(db, {
      kind: row.kind,
      target: row.target,
      priority: priorityOf(row.kind),
      schedule: { id: row.id, slot: due.slot },
      at: new Date(now),
    });
    if (!job.registered) return finish("coalesced", "coalesced"); // a race with another writer
    registered.push(job.job);
    return {
      ...finish("registered", "registered", { lastRunSlot: due.slot }),
      jobId: job.job.id,
    };
  }

  function check(): CheckReport {
    const now = clock.now();
    const zone = zoneNow();
    const discontinuity =
      lastCheckAt !== undefined && (now < lastCheckAt || now - lastCheckAt > 2 * intervalMs);
    lastCheckAt = now;
    const registered: StoredJob[] = [];
    const failed: number[] = [];
    const report = db.transaction(
      () => {
        // clampRunAt is the one rule of how far ahead a run time may lie
        const pulledBack = pullBackRunAfter(
          db,
          now + BACKOFF_MAX_MS,
          (at) => clampRunAt(at, now),
          now,
        );
        const due: DueReport[] = [];
        for (const row of listSchedules(db)) {
          if (!row.enabled) continue;
          try {
            const result = checkOne(row, now, zone, registered);
            if (result) due.push(result);
          } catch (error) {
            // one row that cannot be read must not stop the others or the pull-back
            failed.push(row.id);
            deps.onError?.(error);
          }
        }
        return { discontinuity, pulledBack, due, failed, backlog: backlog() };
      },
      { immediate: true },
    );
    for (const job of registered) deps.onRegistered?.(job); // after the commit
    return report;
  }

  function safeCheck(): CheckReport | undefined {
    try {
      return check();
    } catch (error) {
      deps.onError?.(error);
      return undefined;
    }
  }

  return {
    check,
    start() {
      if (timer !== undefined) return undefined;
      timer = setInterval(safeCheck, intervalMs);
      return safeCheck();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    isRunning: () => timer !== undefined,
    ensureSchedule({ kind, target = "", period, zone }) {
      checkedPeriod(period);
      const at = clock.now();
      const where = zone ?? zoneNow();
      const result = createSchedule(db, {
        kind,
        target,
        period: JSON.stringify(period),
        zone: where,
        nextDue: nextSlotAfter(period, at, where),
        at,
      });
      return { created: result.created, schedule: view(result.schedule) };
    },
    get: (id) => {
      const row = readSchedule(db, id);
      return row && view(row);
    },
    list: () => listSchedules(db).map(view),
    change(id, period) {
      checkedPeriod(period);
      const at = clock.now();
      const zone = zoneNow();
      stored(id);
      updateSchedule(
        db,
        id,
        { period: JSON.stringify(period), zone, nextDue: nextSlotAfter(period, at, zone) },
        at,
      );
      return view(stored(id));
    },
    disable(id) {
      stored(id);
      updateSchedule(db, id, { enabled: false }, clock.now());
      return view(stored(id));
    },
    enable(id) {
      const row = stored(id);
      const at = clock.now();
      const zone = zoneNow();
      updateSchedule(
        db,
        id,
        {
          enabled: true,
          pausedCode: null,
          // what died while it was off or before a check saw it is not a reason to pause again
          failureSeenJob: latestDeadLetterId(db, id),
          // a revived job that already ended again is dismissed too; one still open is not
          revivedJob: readJob(db, row.revivedJob)?.status === "dead_letter" ? 0 : row.revivedJob,
          zone,
          nextDue: nextSlotAfter(periodOf(row), at, zone),
        },
        at,
      );
      return view(stored(id));
    },
    runNow(id) {
      const row = stored(id);
      const at = clock.now();
      const result = db.transaction(() => {
        const open = openJobOfSchedule(db, id);
        if (open) return { registered: false, job: open };
        // the slot of a run now is its time; a second one in the same millisecond takes the next
        let slot = at;
        while (jobOfSlot(db, id, slot)) slot += 1;
        const job = registerJob(db, {
          kind: row.kind,
          target: row.target,
          priority: "user",
          schedule: { id, slot },
          at: new Date(at),
        });
        return job.registered
          ? { registered: true, job: job.job }
          : { registered: false, job: job.existing };
      });
      if (result.registered) deps.onRegistered?.(result.job);
      return result;
    },
    backlog,
  };
}

const priorityOf = (kind: string): JobPriority =>
  kind === MAINTENANCE_KIND ? "maintenance" : "scheduled";

function raise(error: Error): never {
  throw error;
}
