// Retention of ended jobs (I03-R21). The cleanup job deletes the rows that ended more than
// the retention ago. The one row it keeps is a given-up `projection-remove`: it is the
// mark that the projection may still hold deleted content, and only the rebuild that
// covers it closes it (superseded), after which it is an ended row like any other.
import { PROJECTION_REMOVE_KIND } from "./job-kinds.ts";
import type { SqlDriver } from "./sql-driver.ts";

/**
 * Deletes the `succeeded`, `superseded`, `cancelled` and `dead_letter` rows that ended
 * before `before` (UTC milliseconds), never an unfinished job and never a given-up
 * projection removal. The newest row (highest id) is spared: `jobs.id` is an INTEGER PRIMARY KEY
 * without AUTOINCREMENT, so deleting the highest id would let the next job reuse it, and
 * ids that are meant to only grow (a schedule's dead-letter marker, the activity API) would repeat;
 * the next pass takes it once a newer job exists. Returns how many rows went. A row with no end time is never deleted.
 */
export function purgeEndedJobs(db: SqlDriver, before: number): number {
  return db.run(
    `DELETE FROM jobs
      WHERE status IN ('succeeded', 'superseded', 'cancelled', 'dead_letter')
        AND finished_at < ?
        AND NOT (status = 'dead_letter' AND kind = ?)
        AND id < (SELECT max(id) FROM jobs)`,
    [before, PROJECTION_REMOVE_KIND],
  ).changes;
}
