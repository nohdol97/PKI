// The job runner (V02-R4, R5, ADR 0013 decision 9) inside the backend process.
// It claims a job with an expiring lease, runs the handler of its kind and closes
// the job through the version fence (storage closeJob), one job at a time. A job
// left running by a backend that stopped is claimed again once its lease runs out.
// The runner never decides whether a call may run: a handler calls the Broker
// with the job and its lease token as origin, and the Broker judges the call
// background and applies the run conditions (V01-T09). A call it did not run
// comes back as "held". Until I03-T04 generalizes results, a failure is final:
// the job becomes a dead letter (I03-R2's rename of V02's "failed").
import {
  closeJob,
  isFenceCurrent,
  isReasonCode,
  JobWriteError,
  leaseNextJob,
  type JobClosing,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";

/** What a handler hands back; the runner writes it only while the fence holds. */
export type JobResult = Exclude<JobClosing, { status: "superseded" }>;

/**
 * Runs one running job; calls the Broker with origin `{jobId, leaseToken}` from
 * the job (`String(job.id)`, `String(job.leaseToken)`). Throwing dead-letters the
 * job with the code "handler-error"; a reason that is not a code with "invalid-reason".
 */
export type JobHandler = (job: StoredJob) => Promise<JobResult>;

export interface JobRun {
  jobId: number;
  status: ReturnType<typeof closeJob>;
}

export interface JobRunnerOptions {
  db: SqlDriver;
  /** Handlers by job kind; jobs of other kinds are left queued. */
  handlers: Readonly<Record<string, JobHandler>>;
  now?: () => Date;
  /** Must outlast the longest job (Broker attempts, waits and time limits). */
  leaseMs?: number;
  /** How often a started runner looks for queued jobs and leases that ran out. */
  pollMs?: number;
  /** Errors the runner caught (a throwing handler or write, a failing claim). */
  onError?: (error: unknown) => void;
}

export interface JobRunner {
  /** Claims and runs at most one job; undefined when nothing is due. */
  runOnce(): Promise<JobRun | undefined>;
  /** Runs jobs until none is due. */
  wake(): Promise<void>;
  /** Wakes now and on every poll. */
  start(): void;
  /** Stops claiming; resolves when the job running, if any, has closed. */
  stop(): Promise<void>;
}

/** Provisional (V02-T03): the Broker's limits allow about seven minutes per call. */
export const DEFAULT_LEASE_MS = 10 * 60_000;
export const DEFAULT_POLL_MS = 30_000;

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { db, handlers } = options;
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const onError = options.onError ?? (() => {});
  const kinds = Object.keys(handlers);

  async function step(): Promise<JobRun | undefined> {
    const job = leaseNextJob(db, { kinds, now: now(), leaseMs });
    if (!job) return undefined;
    const close = (closing: JobClosing): JobRun => ({
      jobId: job.id,
      status: closeJob(db, job, closing, now()),
    });
    // stale already: no call is made for a version that is gone
    const { sourceId, fenceVersion } = job;
    if (
      sourceId !== null &&
      fenceVersion !== null &&
      !isFenceCurrent(db, { sourceId, fenceVersion })
    ) {
      return close({ status: "superseded" });
    }
    let result: JobResult;
    try {
      result = await (handlers[job.kind] as JobHandler)(job); // kinds are its keys
    } catch (error) {
      onError(error);
      return close({ status: "dead_letter", reason: "handler-error" });
    }
    if ("reason" in result && !isReasonCode(result.reason)) {
      return close({ status: "dead_letter", reason: "invalid-reason" });
    }
    try {
      return close(result);
    } catch (error) {
      // a database error (e.g. a locked file) leaves the job running for a rerun
      if (!(error instanceof JobWriteError)) throw error;
      onError(error.cause);
      return close({ status: "dead_letter", reason: "write-error" });
    }
  }

  // every claim goes through this chain, so one job runs at a time
  let chain: Promise<unknown> = Promise.resolve();
  function runOnce(): Promise<JobRun | undefined> {
    const next = chain.then(step);
    chain = next.catch(() => {});
    return next;
  }

  let stopped = false;
  let again = false;
  let draining: Promise<void> | undefined;
  function wake(): Promise<void> {
    // stopped, the drain body would finish before `draining` is assigned and
    // leave a settled promise there, so no later wake would drain again
    if (stopped) return Promise.resolve();
    again = true;
    draining ??= (async () => {
      try {
        while (again) {
          again = false;
          while (!stopped && (await runOnce())) {
            // one job closed; claim the next unless stopped
          }
        }
      } catch (error) {
        onError(error); // the job stays running and is claimed again when its lease runs out
      } finally {
        draining = undefined;
      }
    })();
    return draining;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    runOnce,
    wake,
    start() {
      stopped = false;
      timer ??= setInterval(() => void wake(), options.pollMs ?? DEFAULT_POLL_MS);
      void wake();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await chain;
    },
  };
}
