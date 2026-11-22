// Projection jobs in storage (I03-R7): which projections the marks of a removal
// point at, the rebuild's cover of removals up to the change sequence it read, the
// latest version a stale removal is re-sent with, and a job's numeric result counts.
// What a removal removes and how errors are classified are backend's
// (projection-jobs.ts); the marks and the cover are rows, so they are judged here.
import { PROJECTION_REBUILD_KIND, PROJECTION_REMOVE_KIND } from "./job-kinds.ts";
import { moving, OPEN_JOB_STATUSES } from "./jobs.ts";
import { nextSourceVersion } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** A removal open this long past its registration is blocked, not retrying (I03-R7 "표식"). */
export const REMOVE_BLOCKED_AFTER_MS = 60 * 60_000;

/** The code of a job whose projection has no port bound (backend UNKNOWN_PROJECTION). */
export const UNKNOWN_PROJECTION_CODE = "unknown-projection";

/** The code a rebuild closes the removals it covered with. */
export const COVERED_BY_REBUILD = "covered-by-rebuild";

const statuses = (list: readonly string[]) => `(${list.map((s) => `'${s}'`).join(", ")})`;
const OPEN_SQL = statuses(OPEN_JOB_STATUSES);
/** Not finished or given up: the removals a mark or a cover looks at. */
const OPEN_OR_DEAD_SQL = statuses([...OPEN_JOB_STATUSES, "dead_letter"]);

/**
 * What a check looks at. At start: any removal not finished or given up. At a
 * scheduler check: a given-up one, or one open for more than an hour since it
 * was registered (a fresh one is still retrying; counting it would rebuild a
 * projection for every ordinary deletion).
 */
export type MarkerCheck = { phase: "start" } | { phase: "check"; now: number };

/** The projections (targets) some removal marks as possibly holding what was deleted. */
export function markedProjections(db: SqlDriver, check: MarkerCheck): string[] {
  const rows =
    check.phase === "start"
      ? db.all(
          `SELECT DISTINCT target FROM jobs
            WHERE kind = ? AND status IN ${OPEN_OR_DEAD_SQL}
            ORDER BY target`,
          [PROJECTION_REMOVE_KIND],
        )
      : db.all(
          // a target whose latest rebuild died of `unknown-projection` (no port bound) and that
          // has no removal registered since is not marked again: another rebuild would die the same
          `SELECT DISTINCT j.target FROM jobs j
            WHERE j.kind = ? AND (j.status = 'dead_letter'
                                OR (j.status IN ${OPEN_SQL} AND j.created_at < ?))
              AND NOT EXISTS (
                SELECT 1 FROM jobs r
                 WHERE r.kind = ? AND r.target = j.target AND r.status = 'dead_letter'
                   AND r.reason = ?
                   AND r.id = (SELECT max(id) FROM jobs WHERE kind = ? AND target = j.target)
                   AND r.id > (SELECT max(id) FROM jobs WHERE kind = ? AND target = j.target))
            ORDER BY j.target`,
          [
            PROJECTION_REMOVE_KIND,
            check.now - REMOVE_BLOCKED_AFTER_MS,
            PROJECTION_REBUILD_KIND,
            UNKNOWN_PROJECTION_CODE,
            PROJECTION_REBUILD_KIND,
            PROJECTION_REMOVE_KIND,
          ],
        );
  return rows.map((r) => r.target as string);
}

/**
 * A finished rebuild covers the target's removals registered at or before the
 * change sequence it read: open ones and given-up ones become superseded
 * (`covered-by-rebuild`), a running one losing its lease. A removal registered
 * later (a deletion that committed while the rebuild ran) is left to run after it.
 * Inside the caller's transaction (the rebuild's own result write). Returns how
 * many it closed.
 */
export function closeCoveredRemoves(
  db: SqlDriver,
  target: string,
  readSeq: number,
  at: Date,
): number {
  const { set, params } = moving("superseded", at.getTime());
  return db.run(
    `UPDATE jobs SET ${set}, reason = ?, lease_token = lease_token + 1
      WHERE kind = ? AND target = ? AND registered_change_seq <= ?
        AND status IN ${OPEN_OR_DEAD_SQL}`,
    [...params, COVERED_BY_REBUILD, PROJECTION_REMOVE_KIND, target, readSeq],
  ).changes;
}

/**
 * The highest version number the source ever reached: its latest stored version, or
 * its tombstone's cover once every version is purged. A removal stale because the
 * projection took a newer notice is re-sent with this as its fence (ADR 0013, I04-R12).
 */
export function latestCanonicalVersion(db: SqlDriver, sourceId: number): number {
  return nextSourceVersion(db, sourceId) - 1;
}

/**
 * A job's result counts: names and whole numbers from 0 only, never text (I03-R2). With
 * `lease`, only the run that still holds the job writes them (a run whose lease was lost
 * writes nothing); without it the caller is inside the transaction that closes the job.
 */
export function recordResultCounts(
  db: SqlDriver,
  jobId: number,
  counts: Readonly<Record<string, number>>,
  lease?: { leaseToken: number },
): void {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort()) {
    const n = counts[key];
    if (!Number.isSafeInteger(n) || (n as number) < 0) {
      throw new RangeError("a result count is a whole number from 0");
    }
    sorted[key] = n as number;
  }
  db.run(
    `UPDATE jobs SET result_counts = ? WHERE id = ?${
      lease ? " AND status = 'running' AND lease_token = ?" : ""
    }`,
    [JSON.stringify(sorted), jobId, ...(lease ? [lease.leaseToken] : [])],
  );
}
