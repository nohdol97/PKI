// What the Activity screen reads of the job table (I03-R23): the count per status, the
// newest rows, and per projection the removals and the rebuild state of R7. Rows hold
// codes, ids and counts only, so nothing here can carry source or Provider text.
import { PROJECTION_REBUILD_KIND, PROJECTION_REMOVE_KIND } from "./job-kinds.ts";
import {
  JOB_STATUSES,
  OPEN_JOB_STATUSES,
  readJob,
  type JobStatus,
  type StoredJob,
} from "./jobs.ts";
import type { SqlDriver } from "./sql-driver.ts";

const list = (statuses: readonly string[]) => `(${statuses.map((s) => `'${s}'`).join(", ")})`;
const OPEN = list(OPEN_JOB_STATUSES);
/** A rebuild that ended without doing the work leaves no repeat behind it. */
const SETTLED = list(["succeeded", "superseded", "cancelled"]);

/** Every status with its row count, zero included. */
export function countJobsByStatus(db: SqlDriver): Record<JobStatus, number> {
  const counts = Object.fromEntries(JOB_STATUSES.map((s) => [s, 0])) as Record<JobStatus, number>;
  for (const row of db.all("SELECT status, count(*) AS n FROM jobs GROUP BY status")) {
    counts[row.status as JobStatus] = row.n as number;
  }
  return counts;
}

/** The newest `limit` rows (highest ids), and whether older ones exist. */
export function listRecentJobs(
  db: SqlDriver,
  limit: number,
): { jobs: StoredJob[]; truncated: boolean } {
  const ids = db.all("SELECT id FROM jobs ORDER BY id DESC LIMIT ?", [limit + 1]);
  const jobs = ids.slice(0, limit).flatMap((row) => readJob(db, row.id as number) ?? []);
  return { jobs, truncated: ids.length > limit };
}

export interface ProjectionActivity {
  name: string;
  /** Removals not finished (queued, running, retrying, held). */
  openRemoves: number;
  /** Removals given up: each marks the projection until a rebuild covers it. */
  deadRemoves: number;
  /**
   * `pending`: a rebuild is open or waits for the next check to be registered again.
   * `repeating`: rebuilds given up since the last settled one keep being registered
   * again (I03-R7 "재구축 반복 중"): the projection stays unusable.
   */
  rebuild: "none" | "pending" | "repeating";
}

/**
 * The projections with something to show. The rebuild state counts the given-up
 * rebuilds of the projection after its last settled (succeeded, superseded or cancelled) one.
 */
export function projectionActivity(db: SqlDriver): ProjectionActivity[] {
  const rows = db.all(
    `SELECT t.target AS name,
       (SELECT count(*) FROM jobs j WHERE j.kind = ? AND j.target = t.target AND j.status IN ${OPEN}) AS open_removes,
       (SELECT count(*) FROM jobs j WHERE j.kind = ? AND j.target = t.target AND j.status = 'dead_letter') AS dead_removes,
       (SELECT count(*) FROM jobs j WHERE j.kind = ? AND j.target = t.target AND j.status IN ${OPEN}) AS open_rebuilds,
       (SELECT count(*) FROM jobs j WHERE j.kind = ? AND j.target = t.target AND j.status = 'dead_letter'
          AND j.id > COALESCE((SELECT max(s.id) FROM jobs s WHERE s.kind = ? AND s.target = t.target AND s.status IN ${SETTLED}), 0)) AS dead_rebuilds
     FROM (SELECT DISTINCT target FROM jobs WHERE kind IN (?, ?)) t
     ORDER BY t.target`,
    [
      PROJECTION_REMOVE_KIND,
      PROJECTION_REMOVE_KIND,
      PROJECTION_REBUILD_KIND,
      PROJECTION_REBUILD_KIND,
      PROJECTION_REBUILD_KIND,
      PROJECTION_REMOVE_KIND,
      PROJECTION_REBUILD_KIND,
    ],
  );
  return rows.flatMap((r) => {
    const openRebuilds = r.open_rebuilds as number;
    const deadRebuilds = r.dead_rebuilds as number;
    const rebuild: ProjectionActivity["rebuild"] =
      deadRebuilds > 0 && (openRebuilds > 0 || deadRebuilds > 1)
        ? "repeating"
        : openRebuilds > 0 || deadRebuilds > 0
          ? "pending"
          : "none";
    const openRemoves = r.open_removes as number;
    const deadRemoves = r.dead_removes as number;
    return rebuild === "none" && openRemoves === 0 && deadRemoves === 0
      ? []
      : [{ name: r.name as string, openRemoves, deadRemoves, rebuild }];
  });
}
