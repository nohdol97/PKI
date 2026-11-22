// The cleanup job (`maintenance`, I03-R21): once a day it deletes the job rows that ended
// more than the retention ago (storage purgeEndedJobs keeps the given-up projection
// removals a rebuild has not closed). The deletion is the job's result write, so it runs
// behind the same lease, cancel and fence checks as any result and commits with the close.
import { purgeEndedJobs, recordResultCounts, type SqlDriver } from "@pki/storage";
import { systemClock, type Clock } from "./clock.ts";
import type { JobHandler } from "./job-runner.ts";

/** Ended jobs are kept this long (I03-R21). */
export const RETENTION_MS = 30 * 24 * 60 * 60_000;

export function createMaintenanceHandler(options: {
  db: SqlDriver;
  clock?: Pick<Clock, "now">;
}): JobHandler {
  const { db } = options;
  const clock = options.clock ?? systemClock;
  return async (job) => ({
    status: "succeeded",
    write: () => {
      const purged = purgeEndedJobs(db, clock.now() - RETENTION_MS);
      recordResultCounts(db, job.id, { purged });
    },
  });
}
