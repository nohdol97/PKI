// The job runner (V02-R4, R5, I03-R4..R6, R8..R11, R14, ADR 0013 decision 9)
// inside the backend process. It claims a job with an expiring lease, runs the
// handler of its kind and closes the job with what the handler handed back, by
// the outcome table (job-outcomes.ts) and behind the three checks of storage's
// closeJob (lease, cancel request, fence), one job at a time. While the handler
// runs, a heartbeat extends the lease under the job's token; once it fails (the
// job was claimed again or closed) the handler's signal is cut and its result is
// never written. A run over its kind's time limit, measured on the injected
// monotonic clock, is cut and retried without waiting for its handler. A job left
// running by a backend that stopped is reclaimed once its lease runs out, at
// every claim (start, poll, wake). Every stored time is the injected clock's.
// The runner never decides whether a call may run: a handler calls the Broker
// with the job and its lease token as origin, and the Broker judges the call
// background and applies the run conditions (V01-T09). A call it did not run
// comes back as the Broker's result and holds the job, its attempt unspent.
import { BUILD_KIND } from "@pki/providers";
import {
  checkpointJob,
  closeJob,
  heartbeatJob,
  isFenceCurrent,
  JobWriteError,
  leaseNextJob,
  readCheckpoint,
  readJob,
  type Checkpoint,
  type JobClosing,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";
import { classifyResult, DEFAULT_RUN_TIMEOUT_MS, failure, type JobResult } from "./job-outcomes.ts";

export type { JobResult } from "./job-outcomes.ts";

/** What a running job's handler is given besides the job. */
export interface JobRunContext {
  /** Cut once the lease is lost, the run is over its time or a step met a closed job; pass it to the Broker. */
  signal: AbortSignal;
  /** The checkpoint the job was claimed with: where a job claimed again goes on (I03-R8). */
  lastCheckpoint: Checkpoint | null;
  /**
   * Writes one step's result and its checkpoint in one transaction, behind the
   * checks a result passes (storage checkpointJob). Anything but "saved" closed
   * the run: stop. A value the kind's fields do not allow throws (RangeError).
   */
  checkpoint(value: Checkpoint, write?: () => void): ReturnType<typeof checkpointJob>;
}

/**
 * Runs one running job; calls the Broker with origin `{jobId, leaseToken}` from
 * the job (`String(job.id)`, `String(job.leaseToken)`). Throwing is the retryable
 * failure "handler-error"; a reason that is not a code gives the job up with
 * "invalid-reason".
 */
export type JobHandler = (job: StoredJob, context: JobRunContext) => Promise<JobResult>;

/** What a kind sets for itself; a kind naming nothing has the defaults. */
export interface JobKindSettings {
  /** Default DEFAULT_MAX_ATTEMPTS (I03-R11). */
  maxAttempts?: number;
  /** Default DEFAULT_RUN_TIMEOUT_MS (I03-R14). */
  runTimeoutMs?: number;
  /** The fields its checkpoint may hold; none declared, no checkpoint (I03-R8). */
  checkpointFields?: readonly string[];
}

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
  /** Attempt limit, run-time limit and checkpoint fields by kind. */
  kinds?: Readonly<Record<string, JobKindSettings>>;
  /** Default systemClock: `now()` gives every stored time, `monotonic()` times a run. */
  clock?: Clock;
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
  const clock = options.clock ?? systemClock;
  const now = () => new Date(clock.now());
  const onError = options.onError ?? (() => {});
  const kinds = Object.keys(handlers);
  const owner = randomUUID(); // new every start: one runner per backend process (I03-R4)
  const pollMs = settings.pollMs ?? options.pollMs ?? DEFAULT_POLL_MS;
  const kindSettings = options.kinds ?? {};
  const maxAttempts = Object.fromEntries(
    Object.entries(kindSettings).flatMap(([kind, { maxAttempts: max }]) =>
      max === undefined ? [] : [[kind, max]],
    ),
  );

  // one job at a time: no job is held while claiming, so none is passed as holding
  async function step(): Promise<JobRun | undefined> {
    const job = leaseNextJob(db, { kinds, now, leaseMs, owner, maxAttempts }); // read under the lock
    return job && run(job);
  }

  async function run(job: StoredJob): Promise<JobRun> {
    const cut = new AbortController();
    const started = clock.monotonic();
    const limit = kindSettings[job.kind]?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    let timeOut!: () => void;
    const timedOut = new Promise<"run-timeout">((resolve) => {
      timeOut = () => resolve("run-timeout");
    });
    // The runtime's interval wakes the run (a Clock sleep cannot be cancelled once
    // the job closed); what it reads and writes is the injected clock.
    const beat = setInterval(() => {
      if (clock.monotonic() - started >= limit) {
        clearInterval(beat);
        cut.abort(); // over its time (I03-R14): stop the handler and its Broker call
        timeOut();
        return;
      }
      try {
        if (!heartbeatJob(db, job, { now: now(), leaseMs })) {
          clearInterval(beat);
          cut.abort(); // claimed again or closed: stop, and write nothing
        }
      } catch (error) {
        onError(error); // e.g. a locked file: the next heartbeat or the lease decides
      }
    }, heartbeatMs);
    try {
      return await attempt(job, cut, timedOut);
    } finally {
      clearInterval(beat);
    }
  }

  async function attempt(
    job: StoredJob,
    cut: AbortController,
    timedOut: Promise<"run-timeout">,
  ): Promise<JobRun> {
    const close = (closing: JobClosing): JobRun => ({
      jobId: job.id,
      // a lost lease (failed heartbeat) fails closeJob's own token check: nothing is written
      status: closeJob(db, job, closing, now()),
    });
    const facts = () => ({ attempts: job.attempts, now: clock.now() });
    // stale already: no call is made for a version that is gone
    const { sourceId, fenceVersion } = job;
    if (
      sourceId !== null &&
      fenceVersion !== null &&
      !isFenceCurrent(db, { sourceId, fenceVersion })
    ) {
      return close({ status: "superseded" });
    }
    // set once a step's checks closed the job (cancelled, superseded) or found the lease gone
    let closed: JobRun["status"] | undefined;
    const context: JobRunContext = {
      signal: cut.signal,
      lastCheckpoint: readCheckpoint(job),
      checkpoint(value, write) {
        const fields = kindSettings[job.kind]?.checkpointFields ?? [];
        const saved = checkpointJob(db, job, { fields, value, ...(write && { write }) }, now());
        if (saved !== "saved") {
          closed = saved;
          cut.abort();
        }
        return saved;
      },
    };
    // kinds are the handlers' keys; a handler throwing as it starts is a rejection too
    const handling = Promise.resolve().then(() => (handlers[job.kind] as JobHandler)(job, context));
    handling.catch(() => {}); // a run that timed out is not waited for: what it does later is dropped
    let result: JobResult | "run-timeout";
    try {
      result = await Promise.race([handling, timedOut]);
    } catch (error) {
      onError(error);
      return closed ? { jobId: job.id, status: closed } : close(failure("handler-error", facts()));
    }
    if (closed) return { jobId: job.id, status: closed };
    if (result === "run-timeout") return close(failure("run-timeout", facts()));
    // a yield counts as progress only when the job's checkpoint moved during this run
    const progressed =
      result.status === "yield" && readJob(db, job.id)?.checkpoint !== job.checkpoint;
    try {
      return close(classifyResult(result, { ...facts(), progressed }));
    } catch (error) {
      // a database error (e.g. a locked file) leaves the job running for a rerun
      if (!(error instanceof JobWriteError)) throw error;
      onError(error.cause);
      return close(failure("write-error", facts()));
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
