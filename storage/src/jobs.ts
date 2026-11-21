// Job records (V01-R6, V02-R3, R4, R5). The Broker reads a job to treat a call as
// background (V01-R8), and only from the current lease holder. A job names its source
// and the version it was registered for, its fence, so it outlives the deletion
// of that version. It is registered once per (kind, source, fence version), claimed
// with a lease that runs out (each claim raises its lease token), and closed by
// `closeJob` for the current token only, which checks the fence in the
// transaction that writes the result. The runner is backend/src/job-runner.ts.
import type { SqlDriver } from "./sql-driver.ts";

/**
 * queued -> leased -> done | superseded | held | failed. A leased job whose lease
 * ran out is claimed again. Closed jobs are never claimed again.
 */
export type JobStatus = "queued" | "leased" | "done" | "superseded" | "held" | "failed";

export interface StoredJob {
  id: number;
  kind: string;
  sourceId: number;
  fenceVersion: number;
  status: JobStatus;
  leaseUntil: string | null;
  /** Raised on every claim; the holder names it to the Broker and to closeJob. */
  leaseToken: number;
  /** Why a job was held or failed: a code, never Provider text. */
  reason: string | null;
}

/** A reason is a short lowercase code: never text that could carry content. */
export const isReasonCode = (reason: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(reason);

/** What `write` threw, so callers tell a failed result apart from a failing database. */
export class JobWriteError extends Error {
  constructor(cause: unknown) {
    super("the job result could not be written", { cause });
    this.name = "JobWriteError";
  }
}

export interface NewJob {
  kind: string;
  sourceId: number;
  fenceVersion: number;
}

export function readJob(db: SqlDriver, id: number): StoredJob | undefined {
  const row = db.all(
    `SELECT kind, source_id, fence_version, status, lease_until, lease_token, reason
       FROM jobs WHERE id = ?`,
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id,
    kind: row.kind as string,
    sourceId: row.source_id as number,
    fenceVersion: row.fence_version as number,
    status: row.status as JobStatus,
    leaseUntil: row.lease_until as string | null,
    leaseToken: row.lease_token as number,
    reason: row.reason as string | null,
  };
}

/**
 * Queues a job inside the caller's transaction (T04: with the version it fences).
 * A conflict is not a registration: the job already there is returned for the
 * caller to inspect.
 */
export function registerJob(
  db: SqlDriver,
  job: NewJob,
): { registered: true; job: StoredJob } | { registered: false; existing: StoredJob } {
  const { changes, lastInsertRowid } = db.run(
    `INSERT INTO jobs (kind, source_id, fence_version, status) VALUES (?, ?, ?, 'queued')
     ON CONFLICT DO NOTHING`,
    [job.kind, job.sourceId, job.fenceVersion],
  );
  if (changes === 1) return { registered: true, job: readJob(db, lastInsertRowid) as StoredJob };
  const id = db.all("SELECT id FROM jobs WHERE kind = ? AND source_id = ? AND fence_version = ?", [
    job.kind,
    job.sourceId,
    job.fenceVersion,
  ])[0]?.id as number;
  return { registered: false, existing: readJob(db, id) as StoredJob };
}

export interface LeaseRequest {
  /** Only jobs of these kinds are claimed (the kinds a handler exists for). */
  kinds: readonly string[];
  now: Date;
  leaseMs: number;
}

/** Claims the oldest queued job, or leased job whose lease ran out, until now + leaseMs. */
export function leaseNextJob(db: SqlDriver, request: LeaseRequest): StoredJob | undefined {
  if (request.kinds.length === 0) return undefined;
  const now = request.now.toISOString();
  return db.transaction(() => {
    const id = db.all(
      `SELECT id FROM jobs
        WHERE kind IN (${request.kinds.map(() => "?").join(", ")})
          AND (status = 'queued' OR (status = 'leased' AND lease_until <= ?))
        ORDER BY id LIMIT 1`,
      [...request.kinds, now],
    )[0]?.id as number | undefined;
    if (id === undefined) return undefined;
    db.run(
      "UPDATE jobs SET status = 'leased', lease_until = ?, lease_token = lease_token + 1 WHERE id = ?",
      [new Date(request.now.getTime() + request.leaseMs).toISOString(), id],
    );
    return readJob(db, id);
  });
}

/** The fence holds while the job's version is the source's latest and no tombstone reaches it. */
export function isFenceCurrent(db: SqlDriver, job: Pick<StoredJob, "sourceId" | "fenceVersion">) {
  const row = db.all(
    `SELECT (SELECT max(version) FROM source_versions WHERE source_id = ?) AS latest,
            (SELECT version FROM tombstones WHERE source_id = ?) AS tombstone`,
    [job.sourceId, job.sourceId],
  )[0];
  const tombstone = row?.tombstone as number | null;
  return row?.latest === job.fenceVersion && (tombstone === null || tombstone < job.fenceVersion);
}

export type JobClosing =
  | { status: "done"; write: () => void }
  | { status: "held" | "failed"; reason: string }
  | { status: "superseded" };

/**
 * Closes a leased job in one transaction (V02-R5) for the holder of its current
 * lease. A stale fence discards the closing, `write` included, and closes the job
 * superseded. A job that is not leased by that lease (closed already, never
 * claimed, or claimed again after the lease ran out) is left as it is and nothing
 * is written. The job row is updated before `write` runs, so the transaction
 * holds the write lock first: a file locked by another process fails the close
 * (SQLITE_BUSY) before any result is written. A throwing `write` rolls back,
 * leaves the job leased and surfaces as JobWriteError, unless it met a locked
 * file (SQLITE_BUSY, SQLITE_LOCKED), which stays the database's error like any
 * other. A reason that is not a code is refused (RangeError) before anything is read.
 */
/** A locked file is transient: the job stays leased and is claimed again after its lease. */
const isLockError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
};

export function closeJob(
  db: SqlDriver,
  lease: Pick<StoredJob, "id" | "leaseToken">,
  closing: JobClosing,
): Exclude<JobStatus, "queued" | "leased"> | "not-leased" {
  if ("reason" in closing && !isReasonCode(closing.reason)) {
    throw new RangeError("a job reason must be a code");
  }
  return db.transaction(() => {
    const job = readJob(db, lease.id);
    if (job?.status !== "leased" || job.leaseToken !== lease.leaseToken) return "not-leased";
    const status = isFenceCurrent(db, job) ? closing.status : "superseded";
    const reason = status === closing.status && "reason" in closing ? closing.reason : null;
    db.run("UPDATE jobs SET status = ?, lease_until = NULL, reason = ? WHERE id = ?", [
      status,
      reason,
      lease.id,
    ]);
    if (status === "done" && closing.status === "done") {
      try {
        closing.write();
      } catch (error) {
        if (isLockError(error)) throw error;
        throw new JobWriteError(error);
      }
    }
    return status;
  });
}

/** What an extraction dropped (V02-R6): quotes not found exactly once, and anything else. */
export interface ExtractionDrops {
  quotes: number;
  other: number;
}

/** Records the dropped counts on the job, inside the transaction writing its result. */
export function recordExtractionDrops(db: SqlDriver, jobId: number, drops: ExtractionDrops): void {
  for (const n of [drops.quotes, drops.other]) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError("a dropped count is a whole number");
  }
  const { changes } = db.run("UPDATE jobs SET dropped_quotes = ?, dropped_other = ? WHERE id = ?", [
    drops.quotes,
    drops.other,
    jobId,
  ]);
  if (changes !== 1) throw new Error(`job ${jobId} not found`);
}

export function readExtractionDrops(db: SqlDriver, jobId: number): ExtractionDrops | undefined {
  const row = db.all("SELECT dropped_quotes, dropped_other FROM jobs WHERE id = ?", [jobId])[0];
  if (row?.dropped_quotes == null || row.dropped_other == null) return undefined;
  return { quotes: row.dropped_quotes as number, other: row.dropped_other as number };
}

/**
 * Puts held jobs back in the queue, in their own rows (V02 미해결 질문 7): called
 * when a condition that blocked them may have changed. Jobs held for a reason in
 * `keep` stay held (a source too large stays too large). Each later claim raises
 * the lease token as usual. Returns how many were queued.
 */
export function requeueHeldJobs(db: SqlDriver, options: { keep: readonly string[] }): number {
  return db.run(
    `UPDATE jobs SET status = 'queued', reason = NULL
      WHERE status = 'held' AND reason NOT IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(options.keep)],
  ).changes;
}
