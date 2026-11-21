// Job records (V01-R6, V02-R3, R4, R5). The Broker reads a job to treat a call as
// background (V01-R8), and only while the job is leased. A job names its source
// and the version it was registered for, its fence, so it outlives the deletion
// of that version. It is registered once per (kind, source, fence version), claimed
// with a lease that runs out, and closed by `closeJob`, which checks the fence in
// the transaction that writes the result. The runner is backend/src/job-runner.ts.
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
  /** Why a job was held or failed: a code, never Provider text. */
  reason: string | null;
}

export interface NewJob {
  kind: string;
  sourceId: number;
  fenceVersion: number;
}

export function readJob(db: SqlDriver, id: number): StoredJob | undefined {
  const row = db.all(
    "SELECT kind, source_id, fence_version, status, lease_until, reason FROM jobs WHERE id = ?",
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
    db.run("UPDATE jobs SET status = 'leased', lease_until = ? WHERE id = ?", [
      new Date(request.now.getTime() + request.leaseMs).toISOString(),
      id,
    ]);
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
 * Closes a leased job in one transaction (V02-R5). A stale fence discards the
 * closing, `write` included, and closes the job superseded. A job that is not
 * leased (closed already, or never claimed) is left as it is and nothing is
 * written. A throwing `write` rolls back and leaves the job leased.
 */
export function closeJob(
  db: SqlDriver,
  jobId: number,
  closing: JobClosing,
): Exclude<JobStatus, "queued" | "leased"> | "not-leased" {
  return db.transaction(() => {
    const job = readJob(db, jobId);
    if (job?.status !== "leased") return "not-leased";
    const status = isFenceCurrent(db, job) ? closing.status : "superseded";
    if (status === "done" && closing.status === "done") closing.write();
    const reason = status === closing.status && "reason" in closing ? closing.reason : null;
    db.run("UPDATE jobs SET status = ?, lease_until = NULL, reason = ? WHERE id = ?", [
      status,
      reason,
      jobId,
    ]);
    return status;
  });
}
