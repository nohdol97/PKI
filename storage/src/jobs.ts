// Job records (V01-R6, V02-R3..R5, I03-R1..R4). The Broker reads a job to treat a
// call as background (V01-R8), and only from the current lease holder. A job
// names its source and the version it was registered for, its fence, so it
// outlives the deletion of that version; Connector syncs, projection rebuilds
// and cleanup have no source. A job is registered once per duplicate key,
// claimed with a lease that runs out (each claim raises its lease token), and
// leaves `running` for the current token only. Only the functions here change a
// status, and only along JOB_TRANSITIONS. The runner is backend/src/job-runner.ts.
import { readChangeSeq } from "./revisions.ts";
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

/** The eight statuses (I03-R1); the database's CHECK holds the same list. */
export const JOB_STATUSES = [
  "queued",
  "running",
  "retry",
  "held",
  "succeeded",
  "superseded",
  "cancelled",
  "dead_letter",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Not finished: at most one per schedule, and what a source's closing closes (I03-R21, R3). */
export const OPEN_JOB_STATUSES = ["queued", "running", "retry", "held"] as const;

/** The drawn transitions of I03-R1 ("작업 한 건의 상태"); succeeded, superseded and cancelled are final. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["running", "cancelled", "superseded"],
  running: ["succeeded", "retry", "queued", "cancelled", "superseded", "held", "dead_letter"],
  retry: ["queued", "dead_letter", "cancelled", "superseded"],
  held: ["queued", "cancelled", "superseded"],
  dead_letter: ["queued", "cancelled", "superseded"],
  succeeded: [],
  superseded: [],
  cancelled: [],
};

export const isJobTransition = (from: JobStatus, to: JobStatus): boolean =>
  JOB_TRANSITIONS[from].includes(to);

/** Final statuses clear the checkpoint (I03-R8). */
const FINAL: readonly JobStatus[] = ["succeeded", "superseded", "cancelled"];
/** Statuses that start the retention clock (I03-R21): the final ones and dead letters. */
const ENDED: readonly JobStatus[] = [...FINAL, "dead_letter"];

export type JobPriority = "user" | "scheduled" | "maintenance";

export interface StoredJob {
  id: number;
  kind: string;
  /** A projection name or Connector instance ID; '' when the kind has none. */
  target: string;
  /** Both null for a kind with no source. */
  sourceId: number | null;
  fenceVersion: number | null;
  status: JobStatus;
  /** Why a job was held or ended: a code, never Provider text. */
  reason: string | null;
  attempts: number;
  /** UTC milliseconds, as every time here. */
  runAfter: number;
  leaseOwner: string | null;
  /** Raised on every claim and reclaim; the holder names it to the Broker and to closeJob. */
  leaseToken: number;
  leaseUntil: number | null;
  heartbeatAt: number | null;
  priority: JobPriority;
  fairnessKey: string;
  scheduleId: number | null;
  slot: number | null;
  checkpoint: string | null;
  resultCounts: string | null;
  policyFingerprint: string | null;
  cancelRequested: boolean;
  /** The change sequence read after the registering transaction's own writes (I03-R2). */
  registeredChangeSeq: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

/** A reason is a short lowercase code: never text that could carry content. */
export const isReasonCode = (reason: string): boolean => /^[a-z][a-z0-9-]{0,63}$/.test(reason);

const assertReason = (reason: string | null | undefined): void => {
  if (reason != null && !isReasonCode(reason)) throw new RangeError("a job reason must be a code");
};

/** What `write` threw, so callers tell a failed result apart from a failing database. */
export class JobWriteError extends Error {
  constructor(cause: unknown) {
    super("the job result could not be written", { cause });
    this.name = "JobWriteError";
  }
}

export type NewJob = {
  kind: string;
  /** Default '' (V02's registration code names none). */
  target?: string;
  /** Default 'user'. */
  priority?: JobPriority;
  /** A scheduled run, keyed once per (schedule, slot). */
  schedule?: { id: number; slot: number };
  /** Registration time, also the first run-at; default now. */
  at?: Date;
} & (
  { sourceId: number; fenceVersion: number } | { sourceId?: undefined; fenceVersion?: undefined }
);

const n = (v: SqlValue | undefined) => (v ?? null) as number | null;

export function readJob(db: SqlDriver, id: number): StoredJob | undefined {
  const row = db.all("SELECT * FROM jobs WHERE id = ?", [id])[0];
  if (!row) return undefined;
  return {
    id,
    kind: row.kind as string,
    target: row.target as string,
    sourceId: n(row.source_id),
    fenceVersion: n(row.fence_version),
    status: row.status as JobStatus,
    reason: row.reason as string | null,
    attempts: row.attempts as number,
    runAfter: row.run_after as number,
    leaseOwner: row.lease_owner as string | null,
    leaseToken: row.lease_token as number,
    leaseUntil: n(row.lease_until),
    heartbeatAt: n(row.heartbeat_at),
    priority: row.priority as JobPriority,
    fairnessKey: row.fairness_key as string,
    scheduleId: n(row.schedule_id),
    slot: n(row.slot),
    checkpoint: row.checkpoint as string | null,
    resultCounts: row.result_counts as string | null,
    policyFingerprint: row.policy_fingerprint as string | null,
    cancelRequested: row.cancel_requested === 1,
    registeredChangeSeq: row.registered_change_seq as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    finishedAt: n(row.finished_at),
  };
}

const OPEN_SQL = `(${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** The job a refused registration ran into, by the duplicate keys in their order. */
function conflicting(db: SqlDriver, job: NewJob, target: string): number | undefined {
  const lookups: [string, SqlValue[]][] = [];
  if (job.sourceId !== undefined) {
    lookups.push([
      "kind = ? AND target = ? AND source_id = ? AND fence_version = ?",
      [job.kind, target, job.sourceId, job.fenceVersion],
    ]);
  }
  if (job.schedule) {
    lookups.push(["schedule_id = ? AND slot = ?", [job.schedule.id, job.schedule.slot]]);
    lookups.push([`schedule_id = ? AND status IN ${OPEN_SQL}`, [job.schedule.id]]);
  }
  if (job.sourceId === undefined) {
    lookups.push([
      `source_id IS NULL AND kind = ? AND target = ? AND status IN ${OPEN_SQL}`,
      [job.kind, target],
    ]);
  }
  for (const [where, params] of lookups) {
    const id = db.all(`SELECT id FROM jobs WHERE ${where} LIMIT 1`, params)[0]?.id;
    if (id !== undefined) return id as number;
  }
  return undefined;
}

/**
 * Queues a job inside the caller's transaction, after the caller's own writes:
 * its change sequence is read here (I03-R2). A conflict with one of the three
 * duplicate keys is not a registration: the job already there is returned for
 * the caller to inspect. A source job's fairness key is its Connector instance,
 * a sourceless one's its kind (I03-R13).
 */
export function registerJob(
  db: SqlDriver,
  job: NewJob,
): { registered: true; job: StoredJob } | { registered: false; existing: StoredJob } {
  const at = (job.at ?? new Date()).getTime();
  const target = job.target ?? "";
  const fairness =
    job.sourceId === undefined
      ? job.kind
      : (db.all("SELECT connector_instance_id AS c FROM sources WHERE id = ?", [job.sourceId])[0]
          ?.c ?? job.kind);
  const { changes, lastInsertRowid } = db.run(
    `INSERT INTO jobs (kind, target, source_id, fence_version, status, priority, schedule_id, slot,
       run_after, fairness_key, registered_change_seq, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      job.kind,
      target,
      job.sourceId ?? null,
      job.fenceVersion ?? null,
      job.priority ?? "user",
      job.schedule?.id ?? null,
      job.schedule?.slot ?? null,
      at,
      fairness,
      readChangeSeq(db),
      at,
      at,
    ],
  );
  if (changes === 1) return { registered: true, job: readJob(db, lastInsertRowid) as StoredJob };
  const id = conflicting(db, job, target) as number; // ON CONFLICT met one of the keys
  return { registered: false, existing: readJob(db, id) as StoredJob };
}

/** The SET clause and its parameters for moving a job into `to` at `at`. */
function moving(to: JobStatus, at: number): { set: string; params: SqlValue[] } {
  const parts = ["status = ?", "updated_at = ?", "finished_at = ?"];
  const params: SqlValue[] = [to, at, ENDED.includes(to) ? at : null];
  if (to !== "running") parts.push("lease_until = NULL", "lease_owner = NULL");
  if (FINAL.includes(to)) parts.push("checkpoint = NULL");
  return { set: parts.join(", "), params };
}

export interface JobTransition {
  from: JobStatus;
  to: JobStatus;
  /** Written as the job's reason; null or absent clears it. */
  reason?: string | null;
  /** When given, the row must hold this lease token. */
  leaseToken?: number;
  /** Raise the lease token, fencing out the holder of the current one. */
  raiseToken?: boolean;
  at?: Date;
}

/**
 * Moves one job along a drawn transition, if it is still in `from` (and holds
 * `leaseToken` when given). A transition not drawn is refused (RangeError) and
 * nothing changes. Returns whether the row moved. Leaving `running` drops the
 * lease; claiming is leaseNextJob's.
 */
export function transitionJob(db: SqlDriver, id: number, change: JobTransition): boolean {
  if (!isJobTransition(change.from, change.to)) {
    throw new RangeError(`no transition from ${change.from} to ${change.to}`);
  }
  if (change.to === "running") throw new RangeError("a job runs only by leaseNextJob");
  assertReason(change.reason);
  const { set, params } = moving(change.to, (change.at ?? new Date()).getTime());
  const token = change.leaseToken === undefined ? "" : " AND lease_token = ?";
  return (
    db.run(
      `UPDATE jobs SET ${set}, reason = ?${change.raiseToken ? ", lease_token = lease_token + 1" : ""}
        WHERE id = ? AND status = ?${token}`,
      [
        ...params,
        change.reason ?? null,
        id,
        change.from,
        ...(change.leaseToken === undefined ? [] : [change.leaseToken]),
      ],
    ).changes === 1
  );
}

export interface LeaseRequest {
  /** Only jobs of these kinds are claimed (the kinds a handler exists for). */
  kinds: readonly string[];
  now: Date;
  leaseMs: number;
  /** The runner's ID, new every process start (I03-R4). */
  owner?: string;
}

/**
 * Claims the oldest queued job until now + leaseMs, in an immediate transaction
 * (I03-R4). Run-at times and cancel requests are not consulted yet: nothing
 * sets them before I03-T03/T04, which pass the injected clock to registration. A running job of those kinds whose lease ran out is
 * reclaimed first (running -> queued, token raised) and so claimed again
 * (queued -> running, token and attempts raised).
 */
export function leaseNextJob(db: SqlDriver, request: LeaseRequest): StoredJob | undefined {
  if (request.kinds.length === 0) return undefined;
  const now = request.now.getTime();
  const kinds = `kind IN (${request.kinds.map(() => "?").join(", ")})`;
  return db.transaction(
    () => {
      const reclaim = moving("queued", now);
      db.run(
        `UPDATE jobs SET ${reclaim.set}, lease_token = lease_token + 1
          WHERE ${kinds} AND status = 'running' AND lease_until <= ?`,
        [...reclaim.params, ...request.kinds, now],
      );
      const id = db.all(
        `SELECT id FROM jobs
          WHERE ${kinds} AND status = 'queued' ORDER BY id LIMIT 1`,
        request.kinds,
      )[0]?.id as number | undefined;
      if (id === undefined) return undefined;
      const claim = moving("running", now);
      db.run(
        `UPDATE jobs SET ${claim.set}, lease_until = ?, lease_owner = ?, heartbeat_at = ?,
           lease_token = lease_token + 1, attempts = attempts + 1
          WHERE id = ? AND status = 'queued'`,
        [...claim.params, now + request.leaseMs, request.owner ?? null, now, id],
      );
      return readJob(db, id);
    },
    { immediate: true },
  );
}

/**
 * Extends the lease of a running job for the holder of its current token, even
 * once its lease ran out (I03-R4: the same runner awake after sleep). False
 * when the job was claimed again or closed: its holder must stop.
 */
export function heartbeatJob(
  db: SqlDriver,
  lease: Pick<StoredJob, "id" | "leaseToken">,
  request: { now: Date; leaseMs: number },
): boolean {
  const now = request.now.getTime();
  return (
    db.run(
      `UPDATE jobs SET lease_until = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ?`,
      [now + request.leaseMs, now, now, lease.id, lease.leaseToken],
    ).changes === 1
  );
}

/** The fence holds while the job's version is the source's latest and no tombstone reaches it. */
export function isFenceCurrent(db: SqlDriver, job: { sourceId: number; fenceVersion: number }) {
  const row = db.all(
    `SELECT (SELECT max(version) FROM source_versions WHERE source_id = ?) AS latest,
            (SELECT version FROM tombstones WHERE source_id = ?) AS tombstone`,
    [job.sourceId, job.sourceId],
  )[0];
  const tombstone = row?.tombstone as number | null;
  return row?.latest === job.fenceVersion && (tombstone === null || tombstone < job.fenceVersion);
}

export type JobClosing =
  | { status: "succeeded"; write: () => void }
  | { status: "held" | "dead_letter"; reason: string }
  | { status: "superseded" };

/** A locked file is transient: the job stays running and is claimed again after its lease. */
const isLockError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
};

/**
 * Closes a running job in one transaction (V02-R5) for the holder of its current
 * lease. A stale fence discards the closing, `write` included, and closes the job
 * superseded. A job that is not running under that lease (closed already, never
 * claimed, or claimed again after the lease ran out) is left as it is and nothing
 * is written. The job row is updated before `write` runs, so the transaction
 * holds the write lock first: a file locked by another process fails the close
 * (SQLITE_BUSY) before any result is written. A throwing `write` rolls back,
 * leaves the job running and surfaces as JobWriteError, unless it met a locked
 * file (SQLITE_BUSY, SQLITE_LOCKED), which stays the database's error like any
 * other. A reason that is not a code is refused (RangeError) before anything is read.
 */
export function closeJob(
  db: SqlDriver,
  lease: Pick<StoredJob, "id" | "leaseToken">,
  closing: JobClosing,
  at: Date = new Date(),
): JobClosing["status"] | "not-leased" {
  if ("reason" in closing) assertReason(closing.reason);
  return db.transaction(() => {
    const job = readJob(db, lease.id);
    if (job?.status !== "running" || job.leaseToken !== lease.leaseToken) return "not-leased";
    const { sourceId, fenceVersion } = job; // a sourceless kind has no fence
    const current =
      sourceId === null || fenceVersion === null || isFenceCurrent(db, { sourceId, fenceVersion });
    const status = current ? closing.status : "superseded";
    const reason = status === closing.status && "reason" in closing ? closing.reason : null;
    transitionJob(db, lease.id, {
      from: "running",
      to: status,
      reason,
      leaseToken: lease.leaseToken,
      at,
    });
    if (status === "succeeded" && closing.status === "succeeded") {
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

/**
 * Closes source X's open jobs (I03-R3) inside the caller's transaction (I04's
 * deletion and revocation): queued, retry, held and running jobs become
 * superseded with the code `source-closed`, their lease tokens raised, so a
 * running job's holder fails its next heartbeat and its result write. Projection
 * work (projection-remove, projection-rebuild) runs after the source is gone and
 * is left alone, as are dead letters (a manual retry meets the fence again).
 * Returns how many jobs were closed.
 */
export function supersedeOpenJobs(db: SqlDriver, sourceId: number, at: Date = new Date()): number {
  const { set, params } = moving("superseded", at.getTime());
  return db.run(
    `UPDATE jobs SET ${set}, reason = 'source-closed', lease_token = lease_token + 1
      WHERE source_id = ? AND status IN ${OPEN_SQL}
        AND kind NOT IN ('projection-remove', 'projection-rebuild')`,
    [...params, sourceId],
  ).changes;
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
export function requeueHeldJobs(
  db: SqlDriver,
  options: { keep: readonly string[]; at?: Date },
): number {
  const { set, params } = moving("queued", (options.at ?? new Date()).getTime());
  return db.run(
    `UPDATE jobs SET ${set}, reason = NULL
      WHERE status = 'held' AND reason NOT IN (SELECT value FROM json_each(?))`,
    [...params, JSON.stringify(options.keep)],
  ).changes;
}
