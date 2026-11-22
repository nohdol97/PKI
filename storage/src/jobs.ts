// Job records (V01-R6, V02-R3..R5, I03-R1..R5). The Broker reads a job to treat a
// call as background (V01-R8), and only from the current lease holder. A job
// names its source and the version it was registered for, its fence, so it
// outlives the deletion of that version; Connector syncs, projection rebuilds
// and cleanup have no source. A job is registered once per duplicate key,
// claimed with a lease that runs out and is reclaimed (each claim and reclaim
// raises its lease token), and leaves `running` for the current token only. Only the functions here change a
// status, and only along JOB_TRANSITIONS. The runner is backend/src/job-runner.ts.
// A result and a checkpoint are written behind I03-R6's three checks (closeJob,
// checkpointJob); the fence among them is commitDerived, here in the provisional
// body I04-T06 replaces.
import type { CommitDerived, DerivedItem } from "./derivatives.ts";
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

/** The attempt limit of a kind that names none (I03-R11). */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** One limit for every kind, or limits by kind (a kind not named has the default). */
export type AttemptLimits = number | Readonly<Record<string, number>>;

/** The SQL value of a job row's attempt limit, and its parameters. */
function attemptLimit(max: AttemptLimits | undefined): { sql: string; params: SqlValue[] } {
  const byKind = typeof max === "object" ? Object.entries(max) : [];
  if (byKind.length === 0) {
    return { sql: "?", params: [typeof max === "number" ? max : DEFAULT_MAX_ATTEMPTS] };
  }
  return {
    sql: `CASE kind ${byKind.map(() => "WHEN ? THEN ?").join(" ")} ELSE ? END`,
    params: [...byKind.flat(), DEFAULT_MAX_ATTEMPTS],
  };
}

export interface LeaseRequest {
  /** Only jobs of these kinds are claimed (the kinds a handler exists for). */
  kinds: readonly string[];
  /**
   * The wall clock. A function is read once the write lock is held, so a lease
   * another backend extended while this one waited for the lock is not seen ahead
   * of a `now` taken before (review RA-1).
   */
  now: Date | (() => Date);
  leaseMs: number;
  /** The runner's ID, new every process start (I03-R4). */
  owner?: string;
  /** Jobs the runner holds in memory: its heartbeat keeps them, no reclaim (I03-R5). */
  holding?: readonly number[];
  /** Default DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: AttemptLimits;
}

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");
const readNow = (now: LeaseRequest["now"]): Date => (typeof now === "function" ? now() : now);

/**
 * A lease ending further ahead than this many lease lengths is a wall clock that
 * went back (I03-R5 ②). Two, not one, so a heartbeat written a moment later by
 * another backend (I03-A3) is not taken for a regression (review RA-1; settled by I03-T04).
 */
export const CLOCK_REGRESSION_LEASES = 2;

/**
 * Reclaims the leases of `kinds` that ran out, or that end further ahead than
 * CLOCK_REGRESSION_LEASES lease lengths (the wall clock went back), except the jobs the runner holds
 * (I03-R5). Each reclaim raises the lease token, so the old holder's heartbeat,
 * Broker calls and result write fail. A job with a cancel request becomes
 * cancelled, one with attempts left queued, one out of attempts retry with the
 * code `lease-expired` (releaseRetryJobs then gives it up). A run that died keeps
 * its attempt (R11), so a job that kills its process every time ends. A running
 * row with no lease end is reclaimed too, along the same three branches (no one
 * would claim it again otherwise). Returns how many were reclaimed.
 */
export function reclaimLeases(db: SqlDriver, request: Omit<LeaseRequest, "owner">): number {
  if (request.kinds.length === 0) return 0;
  const holding = request.holding ?? [];
  const limit = attemptLimit(request.maxAttempts);
  const where = `kind IN (${placeholders(request.kinds)}) AND status = 'running'
      AND (lease_until IS NULL OR lease_until <= ? OR lease_until > ?)
      AND id NOT IN (${placeholders(holding)})`;
  return db.transaction(
    () => {
      const now = readNow(request.now).getTime(); // under the write lock
      const ahead = now + CLOCK_REGRESSION_LEASES * request.leaseMs;
      const params: SqlValue[] = [...request.kinds, now, ahead, ...holding];
      let reclaimed = 0;
      // in this order: a cancel request first, then the attempts left
      const branches: [JobStatus, string, string][] = [
        ["cancelled", "cancel_requested = 1", "NULL"],
        ["retry", `attempts >= ${limit.sql}`, "'lease-expired'"],
        ["queued", "1", "NULL"],
      ];
      for (const [to, condition, reason] of branches) {
        const { set, params: setParams } = moving(to, now);
        reclaimed += db.run(
          `UPDATE jobs SET ${set}, reason = ${reason}, lease_token = lease_token + 1
            WHERE ${where} AND ${condition}`,
          [...setParams, ...params, ...(to === "retry" ? limit.params : [])],
        ).changes;
      }
      return reclaimed;
    },
    { immediate: true },
  );
}

/**
 * The one exit from retry (I03-R11): a job of `kinds` out of its kind's attempts
 * becomes a dead letter at once, its code kept; one with attempts left is queued
 * once its run-at time came (the backoff closeJob wrote), its code cleared. Runs
 * in the caller's transaction. Returns how many left retry.
 */
export function releaseRetryJobs(
  db: SqlDriver,
  request: { kinds: readonly string[]; now: Date; maxAttempts?: AttemptLimits },
): number {
  if (request.kinds.length === 0) return 0;
  const now = request.now.getTime();
  const limit = attemptLimit(request.maxAttempts);
  const kinds = `kind IN (${placeholders(request.kinds)}) AND status = 'retry'`;
  const dead = moving("dead_letter", now);
  const queued = moving("queued", now);
  return (
    db.run(`UPDATE jobs SET ${dead.set} WHERE ${kinds} AND attempts >= ${limit.sql}`, [
      ...dead.params,
      ...request.kinds,
      ...limit.params,
    ]).changes +
    db.run(`UPDATE jobs SET ${queued.set}, reason = NULL WHERE ${kinds} AND run_after <= ?`, [
      ...queued.params,
      ...request.kinds,
      now,
    ]).changes
  );
}

/**
 * Claims a job of `kinds` until now + leaseMs, in one immediate transaction
 * (I03-R4): first the leases that ran out are reclaimed (reclaimLeases) and retry
 * jobs released (releaseRetryJobs); queued jobs with a cancel request are closed
 * cancelled, never claimed; then the queued job with the lowest ID whose run-at
 * time came and that has no cancel request is claimed: token and attempts raised,
 * lease end, heartbeat and owner written. A `now` function is read once, after the
 * lock is held. Priority and fairness order are T05's.
 */
export function leaseNextJob(db: SqlDriver, request: LeaseRequest): StoredJob | undefined {
  if (request.kinds.length === 0) return undefined;
  const kinds = `kind IN (${placeholders(request.kinds)})`;
  // cancel-requested jobs were closed just before, in the same transaction
  const due = `status = 'queued' AND run_after <= ?`;
  return db.transaction(
    () => {
      const at = readNow(request.now); // under the write lock (BEGIN IMMEDIATE)
      const now = at.getTime();
      reclaimLeases(db, { ...request, now: at });
      releaseRetryJobs(db, { ...request, now: at });
      const cancel = moving("cancelled", now);
      db.run(
        `UPDATE jobs SET ${cancel.set}, reason = NULL
          WHERE ${kinds} AND status = 'queued' AND cancel_requested = 1`,
        [...cancel.params, ...request.kinds],
      );
      const id = db.all(`SELECT id FROM jobs WHERE ${kinds} AND ${due} ORDER BY id LIMIT 1`, [
        ...request.kinds,
        now,
      ])[0]?.id as number | undefined;
      if (id === undefined) return undefined;
      const claim = moving("running", now);
      db.run(
        `UPDATE jobs SET ${claim.set}, lease_until = ?, lease_owner = ?, heartbeat_at = ?,
           lease_token = lease_token + 1, attempts = attempts + 1
          WHERE id = ? AND ${due}`,
        [...claim.params, now + request.leaseMs, request.owner ?? null, now, id, now],
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

/**
 * How a run leaves `running` (I03-R9, "실행 결과가 가는 곳"). A held job, a yield
 * with progress (`queued`) and a `retry` with `refund` made no outside call: the
 * attempt the claim raised is given back (I03-R11).
 */
export type JobClosing =
  | { status: "succeeded"; write: () => void }
  | { status: "succeeded"; items: readonly DerivedItem[] }
  | { status: "held" | "dead_letter"; reason: string }
  | { status: "superseded" }
  /** `runAfter`: when it may run again, UTC milliseconds (the backoff). */
  | { status: "retry"; reason: string; runAfter: number; refund?: boolean }
  | { status: "queued"; runAfter: number };

/** A locked file is transient: the job stays running and is claimed again after its lease. */
const isLockError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
};

/**
 * The fence of a result written from a source version (I03-R6 ③, I04-R11), in the
 * provisional body I03-T04 ships: V02's fence alone. A stale source writes
 * nothing. Its cause is `not-latest` when a newer version exists, asked first: a
 * tombstone row below the job's version (a lifted cover, I04-T05) is not why it
 * is stale; else `covered` under a tombstone, else the version is `missing`. A
 * current source, or none, writes every item. I04-T06 replaces this body with
 * assertFresh, assertLineage and combinable; its callers stay as they are.
 */
export const commitDerived: CommitDerived = (tx, input) => {
  const { source } = input;
  if (source && !isFenceCurrent(tx, { sourceId: source.sourceId, fenceVersion: source.version })) {
    const row = tx.all(
      `SELECT EXISTS (SELECT 1 FROM source_versions WHERE source_id = ? AND version > ?) AS newer,
              EXISTS (SELECT 1 FROM tombstones WHERE source_id = ?) AS tombstone`,
      [source.sourceId, source.version, source.sourceId],
    )[0];
    return {
      status: "stale",
      cause: row?.newer === 1 ? "not-latest" : row?.tombstone === 1 ? "covered" : "missing",
    };
  }
  for (const item of input.items) item.write(tx);
  return { status: "committed", written: input.items.length, dropped: [] };
};

type Lease = Pick<StoredJob, "id" | "leaseToken">;

/**
 * I03-R6's three checks, in their order, inside the caller's immediate
 * transaction: ① the job is running under this lease, else nothing is written
 * ("not-leased"); ② no cancel request, else the job closes cancelled; ③ the fence
 * (commitDerived, which writes `result` once it holds), else the job closes
 * superseded. Returns the job when all three passed. A lone write function is
 * one derived item of the job's source version (provisional: I04-T06 has handlers
 * hand over their items). A throwing write surfaces as JobWriteError, unless it
 * met a locked file.
 */
function checkedWrite(
  db: SqlDriver,
  lease: Lease,
  result: readonly DerivedItem[] | (() => void),
  at: Date,
): StoredJob | "not-leased" | "cancelled" | "superseded" {
  const job = readJob(db, lease.id);
  if (job?.status !== "running" || job.leaseToken !== lease.leaseToken) return "not-leased";
  const close = (to: "cancelled" | "superseded") => {
    transitionJob(db, lease.id, { from: "running", to, leaseToken: lease.leaseToken, at });
    return to;
  };
  if (job.cancelRequested) return close("cancelled");
  const { sourceId, fenceVersion } = job; // a sourceless kind has no fence
  const source =
    sourceId === null || fenceVersion === null ? null : { sourceId, version: fenceVersion };
  const items: readonly DerivedItem[] =
    typeof result === "function"
      ? [
          {
            kind: job.kind,
            itemKey: `job:${job.id}`,
            lineage: source ? [source] : [],
            write: result,
          },
        ]
      : result;
  const committed = commitDerived(db, {
    source,
    items: items.map((item) => ({
      ...item,
      write: (tx: SqlDriver) => {
        try {
          item.write(tx);
        } catch (error) {
          if (isLockError(error)) throw error;
          throw new JobWriteError(error);
        }
      },
    })),
  });
  return committed.status === "stale" ? close("superseded") : job;
}

/**
 * Closes a running job in one immediate transaction (I03-R6) for the holder of
 * its current lease, behind the three checks of checkedWrite: a job not running
 * under that lease (closed already, never claimed, or claimed again) is left as it
 * is and nothing is written; a cancel request discards the closing, whatever it
 * is, and closes the job cancelled; a stale fence discards it and closes the job
 * superseded. Otherwise the closing is applied: the result is written with
 * `succeeded`; `held`, a yield (`queued`) and a refunded `retry` give the claim's
 * attempt back; `retry` and `queued` set when the job may run again. A file
 * locked by another process fails the close (SQLITE_BUSY) before any result is
 * written. A throwing `write` rolls back, leaves the job running and surfaces as
 * JobWriteError, unless it met a locked file (SQLITE_BUSY, SQLITE_LOCKED), which
 * stays the database's error like any other. A reason that is not a code is
 * refused (RangeError) before anything is read.
 */
export function closeJob(
  db: SqlDriver,
  lease: Lease,
  closing: JobClosing,
  at: Date = new Date(),
): JobClosing["status"] | "cancelled" | "not-leased" {
  if ("reason" in closing) assertReason(closing.reason);
  if ("runAfter" in closing && !Number.isSafeInteger(closing.runAfter)) {
    throw new RangeError("a run-at time is a whole number of milliseconds");
  }
  // immediate: a deferred close would read, then meet another connection's
  // write lock with SQLITE_BUSY at once, skipping the busy wait (review B-W1)
  return db.transaction(
    () => {
      const result =
        closing.status !== "succeeded" ? [] : "items" in closing ? closing.items : closing.write;
      const job = checkedWrite(db, lease, result, at);
      if (typeof job === "string") return job;
      transitionJob(db, lease.id, {
        from: "running",
        to: closing.status,
        reason: "reason" in closing ? closing.reason : null,
        leaseToken: lease.leaseToken,
        at,
      });
      const refund =
        closing.status === "held" ||
        closing.status === "queued" ||
        (closing.status === "retry" && closing.refund === true);
      db.run(
        "UPDATE jobs SET run_after = coalesce(?, run_after), attempts = max(attempts - ?, 0) WHERE id = ?",
        ["runAfter" in closing ? closing.runAfter : null, refund ? 1 : 0, lease.id],
      );
      return closing.status;
    },
    { immediate: true },
  );
}

/** A checkpoint's size limit in UTF-8 bytes (I03-R8). */
export const CHECKPOINT_MAX_BYTES = 4096;

/** A checkpoint: the fields its kind declared, each a count, a number or a row ID. */
export type Checkpoint = Readonly<Record<string, number>>;

/**
 * A checkpoint as stored: JSON with sorted keys. Only the kind's declared fields,
 * only whole numbers from 0 (IDs, numbers, counts: no text can be carried, I03-R8),
 * at most CHECKPOINT_MAX_BYTES; anything else is refused (RangeError).
 */
export function encodeCheckpoint(fields: readonly string[], value: Checkpoint): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("a checkpoint is an object of its kind's fields");
  }
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(value).sort()) {
    const n: unknown = value[key];
    if (!fields.includes(key)) throw new RangeError("a checkpoint holds its kind's fields only");
    if (!Number.isSafeInteger(n) || (n as number) < 0) {
      throw new RangeError("a checkpoint field is a whole number from 0");
    }
    sorted[key] = n as number;
  }
  const encoded = JSON.stringify(sorted);
  if (new TextEncoder().encode(encoded).length > CHECKPOINT_MAX_BYTES) {
    throw new RangeError(`a checkpoint is at most ${CHECKPOINT_MAX_BYTES} bytes`);
  }
  return encoded;
}

/** The checkpoint a claimed job resumes from; null when it has none. */
export function readCheckpoint(job: Pick<StoredJob, "checkpoint">): Checkpoint | null {
  return job.checkpoint === null ? null : (JSON.parse(job.checkpoint) as Checkpoint);
}

/**
 * Writes one step of a running job and its checkpoint in one immediate
 * transaction (I03-R8), behind the same three checks as closeJob: "saved", or
 * what the checks answered ("cancelled" and "superseded" closed the job). A
 * checkpoint encodeCheckpoint refuses is refused before anything is read, the
 * stored one staying as it is.
 */
export function checkpointJob(
  db: SqlDriver,
  lease: Lease,
  step: { fields: readonly string[]; value: Checkpoint; write?: () => void },
  at: Date = new Date(),
): "saved" | "cancelled" | "superseded" | "not-leased" {
  const encoded = encodeCheckpoint(step.fields, step.value);
  return db.transaction(
    () => {
      const job = checkedWrite(db, lease, step.write ?? [], at);
      if (typeof job === "string") return job;
      db.run("UPDATE jobs SET checkpoint = ?, updated_at = ? WHERE id = ?", [
        encoded,
        at.getTime(),
        lease.id,
      ]);
      return "saved";
    },
    { immediate: true },
  );
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
