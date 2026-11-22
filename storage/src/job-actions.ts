// What the user does to a job and what a changed condition does to held jobs
// (I03-R12, R16). Cancelling, discarding and retrying change a job by hand;
// requeueing puts held jobs back in the queue in their own rows, without calling
// the Broker and without spending an attempt: whether the Broker now lets them
// run is judged at the next claim (R11 gives the attempt back if it does not).
// Each function runs in the caller's transaction when there is one, so a setting's
// write and the release it causes commit together.
import { PROJECTION_REMOVE_KIND } from "./job-kinds.ts";
import { moving, OPEN_JOB_STATUSES, readJob, transitionJob, type StoredJob } from "./jobs.ts";
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

/**
 * A removal that is not finished or was given up is the stored mark that its projection may
 * still hold deleted content (I03-R7 "표식"): the user cannot close it by hand. Only the rebuild
 * that covers it closes it (`closeCoveredRemoves`); trying it again keeps the mark.
 */
const isMarkingRemoval = (job: StoredJob): boolean =>
  job.kind === PROJECTION_REMOVE_KIND &&
  (job.status === "dead_letter" || (OPEN_JOB_STATUSES as readonly string[]).includes(job.status));

/** "requested": a running job's request was written, the holder closes it. "not-allowed": a removal's mark (see `isMarkingRemoval`). */
export type CancelResult =
  "cancelled" | "requested" | "finished" | "not-cancellable" | "not-allowed" | "not-found";

/**
 * Cancels a job (I03-R12 ③). Queued, retrying and held jobs are cancelled now. A
 * running job gets a cancel request that every way out of `running` looks at (R6 ②,
 * R5, the heartbeat); the holder's signal is cut by the runner, not here. A job
 * that is already over is "finished" and left as it is; a dead letter is not
 * cancelled but discarded (`discardJob`).
 */
export function cancelJob(db: SqlDriver, id: number, at: Date = new Date()): CancelResult {
  return db.transaction(
    () => {
      const job = readJob(db, id);
      if (!job) return "not-found";
      if (isMarkingRemoval(job)) return "not-allowed";
      switch (job.status) {
        case "queued":
        case "retry":
        case "held":
          transitionJob(db, id, { from: job.status, to: "cancelled", at });
          return "cancelled";
        case "running":
          db.run("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?", [
            at.getTime(),
            id,
          ]);
          return "requested";
        case "dead_letter":
          return "not-cancellable";
        default:
          return "finished";
      }
    },
    { immediate: true },
  );
}

/** Discards a dead letter: cancelled (I03-R12 ②). */
export function discardJob(
  db: SqlDriver,
  id: number,
  at: Date = new Date(),
): "discarded" | "not-dead-letter" | "not-allowed" | "not-found" {
  const job = readJob(db, id);
  if (!job) return "not-found";
  if (isMarkingRemoval(job)) return "not-allowed";
  return transitionJob(db, id, { from: "dead_letter", to: "cancelled", at })
    ? "discarded"
    : "not-dead-letter";
}

export type RetryResult = "queued" | "not-retryable" | "duplicate-open" | "not-found";

/**
 * Tries a dead letter or a held job again (I03-R12 ①): no attempts used, no cancel
 * request, user priority, due now, queued. The checkpoint stays so the run goes on
 * from it. The fence is not touched: the run meets it again when it is claimed
 * (R6 ③). "duplicate-open" when an open job already holds the key the job would
 * take (a kind with one open job per target).
 */
export function retryJob(db: SqlDriver, id: number, at: Date = new Date()): RetryResult {
  return db.transaction(
    () => {
      const job = readJob(db, id);
      if (!job) return "not-found";
      if (job.status !== "dead_letter" && job.status !== "held") return "not-retryable";
      try {
        transitionJob(db, id, { from: job.status, to: "queued", at });
      } catch (error) {
        if (
          (error as { code?: unknown } | null)?.code?.toString().startsWith("SQLITE_CONSTRAINT")
        ) {
          return "duplicate-open";
        }
        throw error;
      }
      db.run(
        `UPDATE jobs SET attempts = 0, cancel_requested = 0, priority = 'user', run_after = ?,
           policy_fingerprint = NULL WHERE id = ?`,
        [at.getTime(), id],
      );
      // a dead letter of a schedule taken up again: its next end is news to the
      // schedule's pause, even if no check saw it open in between (I03-R20)
      if (job.status === "dead_letter" && job.scheduleId !== null) {
        db.run("UPDATE schedules SET revived_job = ?, updated_at = ? WHERE id = ?", [
          id,
          at.getTime(),
          job.scheduleId,
        ]);
      }
      return "queued";
    },
    { immediate: true },
  );
}

const inList = (values: readonly unknown[]) => values.map(() => "?").join(", ");

function requeue(db: SqlDriver, where: string, params: readonly SqlValue[], at: Date): number {
  const { set, params: moved } = moving("queued", at.getTime());
  return db.run(`UPDATE jobs SET ${set}, reason = NULL WHERE status = 'held' AND (${where})`, [
    ...moved,
    ...params,
  ]).changes;
}

/**
 * Held jobs of one reason and kind, counted: what the periodic re-evaluation
 * judges once per group instead of once per job (I03-R16 ②).
 */
export function heldGroups(db: SqlDriver): { reason: string; kind: string; count: number }[] {
  return db
    .all(
      `SELECT reason, kind, count(*) AS count FROM jobs
        WHERE status = 'held' AND reason IS NOT NULL GROUP BY reason, kind ORDER BY reason, kind`,
    )
    .map((r) => ({ reason: r.reason as string, kind: r.kind as string, count: r.count as number }));
}

/**
 * Puts the held jobs of one kind and target (a Connector instance) for these reasons back in
 * the queue: a collector held for what its instance's state said (I03-R16 ②′).
 */
export function requeueHeldTarget(
  db: SqlDriver,
  options: { kind: string; target: string; reasons: readonly string[]; at?: Date },
): number {
  if (options.reasons.length === 0) return 0;
  return requeue(
    db,
    `kind = ? AND target = ? AND reason IN (${inList(options.reasons)})`,
    [options.kind, options.target, ...options.reasons],
    options.at ?? new Date(),
  );
}

/** Puts the held jobs of these reasons (of one kind, if given) back in the queue. */
export function requeueHeldReasons(
  db: SqlDriver,
  options: { reasons: readonly string[]; kind?: string; at?: Date },
): number {
  if (options.reasons.length === 0) return 0;
  const kind = options.kind === undefined ? "" : " AND kind = ?";
  return requeue(
    db,
    `reason IN (${inList(options.reasons)})${kind}`,
    [...options.reasons, ...(options.kind === undefined ? [] : [options.kind])],
    options.at ?? new Date(),
  );
}

/**
 * At start (I03-R16 ③): held jobs judged under another policy than `fingerprint`
 * go back. A job with no fingerprint (a migrated one, or a hold that wrote none)
 * counts as changed for every reason in `reasons`; a job with another fingerprint
 * goes back only for the reasons the fingerprint's inputs can change
 * (`changedReasons`). Any other reason stays.
 */
export function requeueHeldOnFingerprint(
  db: SqlDriver,
  options: {
    fingerprint: string;
    reasons: readonly string[];
    changedReasons: readonly string[];
    at?: Date;
  },
): number {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (options.reasons.length > 0) {
    clauses.push(`(policy_fingerprint IS NULL AND reason IN (${inList(options.reasons)}))`);
    params.push(...options.reasons);
  }
  if (options.changedReasons.length > 0) {
    clauses.push(`(policy_fingerprint <> ? AND reason IN (${inList(options.changedReasons)}))`);
    params.push(options.fingerprint, ...options.changedReasons);
  }
  if (clauses.length === 0) return 0;
  return requeue(db, clauses.join(" OR "), params, options.at ?? new Date());
}
