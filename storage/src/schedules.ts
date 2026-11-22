// The schedule table (I03-R18, R20, R21, R22): one row per (kind, target) holding its
// period, the zone its daily and weekly slots were computed in, the next due time,
// the slot of its last run, whether it is on or paused, and counters. This module
// reads and writes rows and asks the job table the questions a check needs; the slot
// arithmetic and the judgements are the backend's scheduler. The period is opaque
// here: the JSON of the backend's `Period`.
import { OPEN_JOB_STATUSES, readJob, type StoredJob } from "./jobs.ts";
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

/** The counters of what checks did with due slots (I03-R20, R21). */
export interface ScheduleCounts {
  registered: number;
  /** Due slots that joined a job already open (also a slot key met by an open job). */
  coalesced: number;
  /** Due slots that joined a held job: the period shows "paused (held)". */
  heldCoalesced: number;
  /** Due slots dropped because the open jobs were at the cap. */
  skipped: number;
  /** Due slots whose (schedule, slot) job had already ended. */
  alreadyRan: number;
}

export interface StoredSchedule {
  id: number;
  kind: string;
  target: string;
  /** JSON of the backend's Period. */
  period: string;
  zone: string;
  enabled: boolean;
  nextDue: number;
  lastRunSlot: number | null;
  /** The last error code of the job that gave the period up; null while it is not paused. */
  pausedCode: string | null;
  /** The end time of the latest dead letter a check has seen for this period. */
  failureSeenAt: number;
  /** An error code kept for a period that cannot pause (the cleanup period). */
  warning: string | null;
  /** The missed slots of the latest due check. */
  lastMissed: number;
  counts: ScheduleCounts;
  createdAt: number;
  updatedAt: number;
}

const COUNT_COLUMNS = {
  registered: "registered_count",
  coalesced: "coalesced_count",
  heldCoalesced: "held_coalesced_count",
  skipped: "skipped_count",
  alreadyRan: "already_ran_count",
} as const satisfies Record<keyof ScheduleCounts, string>;

export function readSchedule(db: SqlDriver, id: number): StoredSchedule | undefined {
  const row = db.all("SELECT * FROM schedules WHERE id = ?", [id])[0];
  return row && fromRow(row);
}

export function listSchedules(db: SqlDriver): StoredSchedule[] {
  return db.all("SELECT * FROM schedules ORDER BY id").map(fromRow);
}

function fromRow(row: Record<string, SqlValue>): StoredSchedule {
  return {
    id: row.id as number,
    kind: row.kind as string,
    target: row.target as string,
    period: row.period as string,
    zone: row.zone as string,
    enabled: row.enabled === 1,
    nextDue: row.next_due as number,
    lastRunSlot: (row.last_run_slot ?? null) as number | null,
    pausedCode: (row.paused_code ?? null) as string | null,
    failureSeenAt: row.failure_seen_at as number,
    warning: (row.warning ?? null) as string | null,
    lastMissed: row.last_missed as number,
    counts: {
      registered: row.registered_count as number,
      coalesced: row.coalesced_count as number,
      heldCoalesced: row.held_coalesced_count as number,
      skipped: row.skipped_count as number,
      alreadyRan: row.already_ran_count as number,
    },
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

/** Creates the period of (kind, target) unless one exists; the stored one is returned either way. */
export function createSchedule(
  db: SqlDriver,
  input: {
    kind: string;
    target: string;
    period: string;
    zone: string;
    nextDue: number;
    at: number;
  },
): { created: boolean; schedule: StoredSchedule } {
  const { changes, lastInsertRowid } = db.run(
    `INSERT INTO schedules (kind, target, period, zone, next_due, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, target) DO NOTHING`,
    [input.kind, input.target, input.period, input.zone, input.nextDue, input.at, input.at],
  );
  const id =
    changes === 1
      ? lastInsertRowid
      : (db.all("SELECT id FROM schedules WHERE kind = ? AND target = ?", [
          input.kind,
          input.target,
        ])[0]?.id as number);
  return { created: changes === 1, schedule: readSchedule(db, id) as StoredSchedule };
}

/** The columns of a schedule a caller may write; a key left out is not touched. */
export interface SchedulePatch {
  period?: string;
  zone?: string;
  enabled?: boolean;
  nextDue?: number;
  lastRunSlot?: number | null;
  pausedCode?: string | null;
  failureSeenAt?: number;
  warning?: string | null;
  lastMissed?: number;
  /** Added to the counters. */
  count?: Partial<ScheduleCounts>;
}

const COLUMNS = {
  period: "period",
  zone: "zone",
  nextDue: "next_due",
  lastRunSlot: "last_run_slot",
  pausedCode: "paused_code",
  failureSeenAt: "failure_seen_at",
  warning: "warning",
  lastMissed: "last_missed",
} as const;

/** Writes a patch to one schedule; false when there is no such schedule. */
export function updateSchedule(
  db: SqlDriver,
  id: number,
  patch: SchedulePatch,
  at: number,
): boolean {
  const sets = ["updated_at = ?"];
  const params: SqlValue[] = [at];
  for (const [key, column] of Object.entries(COLUMNS)) {
    const value = patch[key as keyof typeof COLUMNS];
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (patch.enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(patch.enabled ? 1 : 0);
  }
  for (const [key, by] of Object.entries(patch.count ?? {})) {
    if (by) {
      const column = COUNT_COLUMNS[key as keyof ScheduleCounts];
      sets.push(`${column} = ${column} + ?`);
      params.push(by);
    }
  }
  return (
    db.run(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`, [...params, id]).changes === 1
  );
}

const OPEN = `(${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** How many jobs are not finished, of every kind (I03-R21). */
export function countOpenJobs(db: SqlDriver): number {
  return db.all(`SELECT count(*) AS n FROM jobs WHERE status IN ${OPEN}`)[0]?.n as number;
}

/** The one not-finished job of a schedule, if any (I03-R2 allows at most one). */
export function openJobOfSchedule(db: SqlDriver, scheduleId: number): StoredJob | undefined {
  const id = db.all(`SELECT id FROM jobs WHERE schedule_id = ? AND status IN ${OPEN} LIMIT 1`, [
    scheduleId,
  ])[0]?.id;
  return id === undefined ? undefined : readJob(db, id as number);
}

/** The job of a schedule that holds a slot, if any (the (schedule, slot) key). */
export function jobOfSlot(db: SqlDriver, scheduleId: number, slot: number): StoredJob | undefined {
  const id = db.all("SELECT id FROM jobs WHERE schedule_id = ? AND slot = ?", [scheduleId, slot])[0]
    ?.id;
  return id === undefined ? undefined : readJob(db, id as number);
}

/** The latest dead letter of a schedule that ended after `after`: its code and end time. */
export function latestDeadLetterAfter(
  db: SqlDriver,
  scheduleId: number,
  after: number,
): { reason: string | null; finishedAt: number } | undefined {
  const row = db.all(
    `SELECT reason, finished_at FROM jobs
      WHERE schedule_id = ? AND status = 'dead_letter' AND finished_at > ?
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [scheduleId, after],
  )[0];
  return row && { reason: row.reason as string | null, finishedAt: row.finished_at as number };
}

/** Whether a job of the schedule succeeded after `after`. */
export function hasSucceededAfter(db: SqlDriver, scheduleId: number, after: number): boolean {
  return (
    db.all(
      "SELECT 1 AS hit FROM jobs WHERE schedule_id = ? AND status = 'succeeded' AND finished_at > ? LIMIT 1",
      [scheduleId, after],
    ).length === 1
  );
}

/**
 * Pulls the run times of queued and retry jobs that lie past `above` back to what
 * `clamp` gives (I03-R22: a clock that went back left them in a future that would
 * not arrive). Returns how many moved.
 */
export function pullBackRunAfter(
  db: SqlDriver,
  above: number,
  clamp: (runAfter: number) => number,
): number {
  const rows = db.all(
    "SELECT id, run_after FROM jobs WHERE status IN ('queued', 'retry') AND run_after > ?",
    [above],
  );
  let moved = 0;
  for (const row of rows) {
    const to = clamp(row.run_after as number);
    if (to !== row.run_after) {
      moved += db.run("UPDATE jobs SET run_after = ? WHERE id = ?", [to, row.id as number]).changes;
    }
  }
  return moved;
}
