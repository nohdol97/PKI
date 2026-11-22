// The job runner (V02-R4, R5, I03-R4, R5, ADR 0013 decision 9) inside the backend
// process. It claims a job with an expiring lease, runs the handler of its kind
// and closes the job through the version fence (storage closeJob), one job at a
// time. While the handler runs, a heartbeat extends the lease under the job's
// token; once it fails (the job was claimed again or closed) the handler's signal
// is cut and its result is never written. A job left running by a backend that
// stopped is reclaimed once its lease runs out, at every claim (start, poll, wake).
// The runner never decides whether a call may run: a handler calls the Broker
// with the job and its lease token as origin, and the Broker judges the call
// background and applies the run conditions (V01-T09). A call it did not run
// comes back as "held". Until I03-T04 generalizes results, a failure is final:
// the job becomes a dead letter (I03-R2's rename of V02's "failed").
import { BUILD_KIND } from "@pki/providers";
import {
  closeJob,
  heartbeatJob,
  isFenceCurrent,
  isReasonCode,
  JobWriteError,
  leaseNextJob,
  type JobClosing,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { randomUUID } from "node:crypto";

/** What a handler hands back; the runner writes it only while the fence holds. */
export type JobResult = Exclude<JobClosing, { status: "superseded" }>;

/** What a running job's handler is given besides the job (I03-T04 widens it). */
export interface JobRunContext {
  /** Cut once the lease is lost (a failed heartbeat); pass it to the Broker. */
  signal: AbortSignal;
}

/**
 * Runs one running job; calls the Broker with origin `{jobId, leaseToken}` from
 * the job (`String(job.id)`, `String(job.leaseToken)`). Throwing dead-letters the
 * job with the code "handler-error"; a reason that is not a code with "invalid-reason".
 */
export type JobHandler = (job: StoredJob, context: JobRunContext) => Promise<JobResult>;

export interface JobRun {
  jobId: number;
  status: ReturnType<typeof closeJob>;
}

/**
 * Honoured in a test build only (I03-R24): a short lease so a kill test does not
 * wait two minutes, a short poll, and handlers of test kinds (`test-effect`),
 * made from the runner's database.
 */
export interface RunnerTestBuild {
  leaseMs?: number;
  pollMs?: number;
  handlers?: (db: SqlDriver) => Readonly<Record<string, JobHandler>>;
}

export interface JobRunnerOptions {
  db: SqlDriver;
  /** Handlers by job kind; jobs of other kinds are left queued. */
  handlers: Readonly<Record<string, JobHandler>>;
  now?: () => Date;
  /** How often a started runner looks for queued jobs and leases that ran out. */
  pollMs?: number;
  /** The test build's lease, poll and test kinds (testRunnerSettings); ignored by any other build. */
  testBuild?: RunnerTestBuild;
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

/** The job defaults (I03 "기본값"): the heartbeat keeps a long run's lease. */
export const DEFAULT_LEASE_MS = 2 * 60_000;
/** A quarter of the lease (I03-R4). */
export const DEFAULT_HEARTBEAT_MS = DEFAULT_LEASE_MS / 4;
export const DEFAULT_POLL_MS = 30_000;

export interface RunnerSettings {
  leaseMs: number;
  heartbeatMs: number;
  pollMs?: number;
  handlers?: RunnerTestBuild["handlers"];
}

const DEFAULT_SETTINGS: RunnerSettings = {
  leaseMs: DEFAULT_LEASE_MS,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
};

/**
 * What a test build runs with (I03-R24): what it asked for, the heartbeat at a
 * quarter of its lease. createJobRunner enters it only when the build kind is
 * "test", which the bundler folds away from any other build (V01-T15): there the
 * defaults hold, whatever test options were handed in.
 */
export function testRunnerSettings(testBuild: RunnerTestBuild | undefined): RunnerSettings {
  if (testBuild === undefined) return DEFAULT_SETTINGS;
  const { leaseMs = DEFAULT_LEASE_MS, pollMs, handlers } = testBuild;
  if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError("a lease is a positive whole number of milliseconds");
  }
  return {
    leaseMs,
    heartbeatMs: Math.max(1, Math.floor(leaseMs / 4)),
    ...(pollMs === undefined ? {} : { pollMs }),
    ...(handlers === undefined ? {} : { handlers }),
  };
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { db } = options;
  const settings = BUILD_KIND === "test" ? testRunnerSettings(options.testBuild) : DEFAULT_SETTINGS;
  const { leaseMs, heartbeatMs } = settings;
  const handlers = { ...options.handlers, ...settings.handlers?.(db) };
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  const kinds = Object.keys(handlers);
  const owner = randomUUID(); // new every start: one runner per backend process (I03-R4)
  const pollMs = settings.pollMs ?? options.pollMs ?? DEFAULT_POLL_MS;

  // one job at a time: no job is held while claiming, so none is passed as holding
  async function step(): Promise<JobRun | undefined> {
    const job = leaseNextJob(db, { kinds, now, leaseMs, owner }); // read under the lock
    return job && run(job);
  }

  async function run(job: StoredJob): Promise<JobRun> {
    const lost = new AbortController();
    const beat = setInterval(() => {
      try {
        if (!heartbeatJob(db, job, { now: now(), leaseMs })) {
          clearInterval(beat);
          lost.abort(); // claimed again or closed: stop, and write nothing
        }
      } catch (error) {
        onError(error); // e.g. a locked file: the next heartbeat or the lease decides
      }
    }, heartbeatMs);
    try {
      return await attempt(job, lost.signal);
    } finally {
      clearInterval(beat);
    }
  }

  async function attempt(job: StoredJob, signal: AbortSignal): Promise<JobRun> {
    const close = (closing: JobClosing): JobRun => ({
      jobId: job.id,
      // a lost lease (failed heartbeat) fails closeJob's own token check: nothing is written
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
      result = await (handlers[job.kind] as JobHandler)(job, { signal }); // kinds are its keys
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
      timer ??= setInterval(() => void wake(), pollMs);
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
