// What the user does to a job (I03-R12): cancel, retry, discard. Storage changes
// the row (storage/src/job-actions.ts); this adds what only a process holding
// the runner can do: a running job's signal is cut at once, and a retried job wakes
// the runner. The API (I03-T11) and the invalidation's "retry" (I04-T06) call these.
import {
  cancelJob,
  discardJob,
  retryJob,
  type CancelResult,
  type RetryResult,
  type SqlDriver,
} from "@pki/storage";
import { systemClock, type Clock } from "./clock.ts";
import type { JobRunner } from "./job-runner.ts";

export interface JobActions {
  cancel(jobId: number): CancelResult;
  retry(jobId: number): RetryResult;
  discard(jobId: number): ReturnType<typeof discardJob>;
}

export function createJobActions(options: {
  db: SqlDriver;
  runner: Pick<JobRunner, "cancelRunning" | "wake">;
  clock?: Clock;
}): JobActions {
  const { db, runner } = options;
  const now = () => new Date((options.clock ?? systemClock).now());
  return {
    cancel(jobId) {
      const result = cancelJob(db, jobId, now());
      // the request is written first: whatever this runner's handler returns, the close sees it
      if (result === "requested") runner.cancelRunning(jobId);
      return result;
    },
    retry(jobId) {
      const result = retryJob(db, jobId, now());
      if (result === "queued") void runner.wake();
      return result;
    },
    discard: (jobId) => discardJob(db, jobId, now()),
  };
}
