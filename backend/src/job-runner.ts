// The job runner (V02-R4, R5, I03-R4..R6, R8..R11, R13, R14, ADR 0013 decision 9)
// inside the backend process. It claims a job with an expiring lease, runs the
// handler of its kind and closes the job with what the handler handed back, by
// the outcome table (job-outcomes.ts) and behind the three checks of storage's
// closeJob (lease, cancel request, fence), several jobs together within the
// overall limit and the limits of their concurrency groups (I03-R13; the claim
// counts them, storage job-concurrency.ts). While the handler
// runs, a heartbeat extends the lease under the job's token; once it fails (the
// job was claimed again or closed) the handler's signal is cut and its result is
// never written. A run over its kind's time limit, measured on the injected
// monotonic clock, is cut and retried without waiting for its handler; a run that
// lost its job (a failed heartbeat, a step that met a closed job) ends at once
// the same way, so a handler ignoring its signal never blocks the queue: the
// run's place in its group and in the overall limit is free again, and whatever
// the abandoned handler writes later is refused by the lease token. A job left
// running by a backend that stopped is reclaimed once its lease runs out, at
// every claim (start, poll, wake). Every stored time is the injected clock's.
// The runner never decides whether a call may run: a handler calls the Broker
// with the job and its lease token as origin, and the Broker judges the call
// background and applies the run conditions (V01-T09). A call it did not run
// comes back as the Broker's result and holds the job, its attempt unspent.
import { BUILD_KIND, type Broker } from "@pki/providers";
import {
  checkpointJob,
  closeJob,
  DEFAULT_MAX_CONCURRENT,
  heartbeatJob,
  isFenceCurrent,
  JobWriteError,
  leaseNextJob,
  readCheckpoint,
  readJob,
  readSetting,
  type Checkpoint,
  type CommitScope,
  type JobClosing,
  type SqlDriver,
  type StoredJob,
  usesVersionFence,
} from "@pki/storage";
import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "./clock.ts";
import { DEFAULT_MAX_REQUESTS, jobBroker, type JobBroker } from "./job-broker.ts";
import { classifyResult, DEFAULT_RUN_TIMEOUT_MS, failure, type JobResult } from "./job-outcomes.ts";

export type { JobResult } from "./job-outcomes.ts";

/** What a running job's handler is given besides the job. */
export interface JobRunContext {
  /** Cut once the lease is lost, the run is over its time or a step met a closed job; pass it to the Broker. */
  signal: AbortSignal;
  /**
   * The only Broker a handler may call: it counts the run's requests (limit
   * `kinds[kind].maxRequests`), blocks the one past it, and passes `signal` on.
   */
  broker: JobBroker;
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
  /** Broker requests one run may make, default DEFAULT_MAX_REQUESTS (I03-R14). */
  maxRequests?: number;
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
  /** The Broker the handlers call through their context (I03-R14); a runner of Broker-less kinds has none. */
  broker?: Pick<Broker, "call" | "budgetUsage">;
  /** Attempt limit, run-time limit and checkpoint fields by kind. */
  kinds?: Readonly<Record<string, JobKindSettings>>;
  /** Default systemClock: `now()` gives every stored time, `monotonic()` times a run. */
  clock?: Clock;
  /** How often a started runner looks for queued jobs and leases that ran out. */
  pollMs?: number;
  /** The test build's lease, poll and test kinds (testRunnerSettings); ignored by any other build. */
  testBuild?: RunnerTestBuild;
  /** The policy fingerprint a job held by the Broker is stamped with (I03-R16 ③); none: stamped empty. */
  policyFingerprint?: () => string;
  /**
   * The scope policy and its record, handed to every result and checkpoint write (I04-R11, R14:
   * storage closeJob's `scope`). None: every item passes, as under the default policy.
   */
  scope?: CommitScope;
  /** Errors the runner caught (a throwing handler or write, a failing claim). */
  onError?: (error: unknown) => void;
  /**
   * Called right after every close a run attempts, with the job and what `closeJob` answered (that can
   * be `not-leased` or `cancelled`, so a caller filters on the status it wants). Connector sync uses it to put a job back that closed held for an instance that
   * is ready by now (I06-R10). A throw is reported to `onError`.
   */
  onClosed?: (job: StoredJob, status: JobRun["status"]) => void;
}

export interface JobRunner {
  /**
   * Cuts the signal of a job this runner is running and stops waiting for its
   * handler, so the cancel the user just requested (the flag is written already)
   * takes effect now instead of at the next heartbeat (I03-R12). False when this
   * runner does not hold the job: another process's heartbeat sees the flag.
   */
  cancelRunning(jobId: number): boolean;
  /**
   * Claims one job and resolves once it closed, beside the jobs already running;
   * undefined at once when nothing is due or a limit leaves no job to claim.
   */
  runOnce(): Promise<JobRun | undefined>;
  /** Runs jobs, as many together as the limits allow, until none is due or running. */
  wake(): Promise<void>;
  /** Wakes now and on every poll. */
  start(): void;
  /** Stops claiming; resolves when every running job has closed. */
  stop(): Promise<void>;
}

/** How many jobs run together overall (I03-R13): a runtime setting, 1 to 4. */
export const JOBS_MAX_CONCURRENT_SETTING = "jobs.maxConcurrent";
const MAX_CONCURRENT_VALUES = /^[1-4]$/;

/**
 * The overall limit, read at every claim so a change applies without a restart.
 * Provisional: a value that is not a whole number from 1 to 4 is the default,
 * not the nearest allowed value.
 */
export function readMaxConcurrent(db: SqlDriver): number {
  const value = readSetting(db, JOBS_MAX_CONCURRENT_SETTING);
  return value !== undefined && MAX_CONCURRENT_VALUES.test(value)
    ? Number(value)
    : DEFAULT_MAX_CONCURRENT;
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

/** Why a run stopped waiting for its handler: over its time, or its job is no longer its own. */
type RunEnd = typeof TIMED_OUT | typeof LOST | typeof CANCELLED;
// symbols no handler can hand back: a handler's result is never taken for an ending
const TIMED_OUT = Symbol("run-timeout");
const LOST = Symbol("lost");
const CANCELLED = Symbol("cancelled");

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

  /** The jobs held in memory: each settles, never rejecting, once its run ended. */
  const held = new Map<number, Promise<void>>();
  /** Each fairness key's last turn (I03-R13): memory only, empty after a restart. */
  const lastClaimed = new Map<string, number>();
  let turn = 0;
  /** The jobs this runner is running, each with what ends its run for a cancel request. */
  const active = new Map<number, () => void>();

  /** Claims one job the limits allow and starts it; undefined when there is none. */
  function claim(): Promise<JobRun> | undefined {
    const job = leaseNextJob(db, {
      kinds,
      now, // read under the lock
      leaseMs,
      owner,
      holding: [...held.keys()], // their heartbeat keeps them, whatever the wall clock says
      maxAttempts,
      maxConcurrent: readMaxConcurrent(db),
      lastClaimed,
    });
    if (!job) return undefined;
    lastClaimed.set(job.fairnessKey, ++turn);
    const running = run(job);
    const settled = () => void held.delete(job.id);
    held.set(job.id, running.then(settled, settled));
    return running;
  }

  async function run(job: StoredJob): Promise<JobRun> {
    const cut = new AbortController();
    const started = clock.monotonic();
    const limit = kindSettings[job.kind]?.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    // Ends the run without its handler: the signal is cut and the run stops waiting.
    let end!: (why: RunEnd) => void;
    const ended = new Promise<RunEnd>((resolve) => {
      end = (why) => {
        clearInterval(beat);
        cut.abort();
        resolve(why);
      };
    });
    // The runtime's interval wakes the run (a Clock sleep cannot be cancelled once
    // the job closed); what it reads and writes is the injected clock.
    const beat = setInterval(() => {
      if (clock.monotonic() - started >= limit) return end(TIMED_OUT); // I03-R14
      try {
        // claimed again or closed: stop, and write nothing
        if (!heartbeatJob(db, job, { now: now(), leaseMs })) end(LOST);
        // a cancel request another process wrote: the close below turns the run into `cancelled`
        else if (readJob(db, job.id)?.cancelRequested) end(CANCELLED);
      } catch (error) {
        onError(error); // e.g. a locked file: the next heartbeat or the lease decides
      }
    }, heartbeatMs);
    active.set(job.id, () => end(CANCELLED));
    try {
      return await attempt(job, cut.signal, ended, end);
    } finally {
      active.delete(job.id);
      clearInterval(beat);
    }
  }

  async function attempt(
    job: StoredJob,
    signal: AbortSignal,
    ended: Promise<RunEnd>,
    end: (why: RunEnd) => void,
  ): Promise<JobRun> {
    // a hold records the policy it was judged under (I03-R16 ③)
    const stamped = (closing: JobClosing): JobClosing =>
      closing.status === "held" && options.policyFingerprint
        ? { ...closing, policyFingerprint: options.policyFingerprint() }
        : closing;
    const close = (closing: JobClosing): JobRun => {
      // a lost lease (failed heartbeat) fails closeJob's own token check: nothing is written
      const status = closeJob(db, job, stamped(closing), now(), options.scope);
      try {
        options.onClosed?.(job, status);
      } catch (error) {
        onError(error);
      }
      return { jobId: job.id, status };
    };
    const facts = () => ({ attempts: job.attempts, now: clock.now() });
    // stale already: no call is made for a version that is gone
    const { sourceId, fenceVersion } = job;
    if (
      sourceId !== null &&
      fenceVersion !== null &&
      usesVersionFence(job.kind) && // a projection job runs after its source is gone (I03-R7)
      !isFenceCurrent(db, { sourceId, fenceVersion })
    ) {
      return close({ status: "superseded" });
    }
    // what a step's checks answered when they closed the job or found the lease gone
    let closed: JobRun["status"] = "not-leased";
    const context: JobRunContext = {
      signal,
      broker: jobBroker(options.broker, {
        limit: kindSettings[job.kind]?.maxRequests ?? DEFAULT_MAX_REQUESTS,
        signal,
      }),
      lastCheckpoint: readCheckpoint(job),
      checkpoint(value, write) {
        const fields = kindSettings[job.kind]?.checkpointFields ?? [];
        const saved = checkpointJob(
          db,
          job,
          { fields, value, ...(write && { write }) },
          now(),
          options.scope,
        );
        if (saved !== "saved") {
          closed = saved;
          end(LOST);
        }
        return saved;
      },
    };
    // kinds are the handlers' keys; a handler throwing as it starts is a rejection too
    const handling = Promise.resolve().then(() => (handlers[job.kind] as JobHandler)(job, context));
    handling.catch(() => {}); // an ended run is not waited for: what its handler does later is dropped
    let result: JobResult | RunEnd;
    try {
      result = await Promise.race([handling, ended]);
    } catch (error) {
      onError(error);
      return close(failure("handler-error", facts()));
    }
    // the job is no longer this run's: nothing is written (closeJob would refuse it anyway)
    if (result === LOST) return { jobId: job.id, status: closed };
    if (result === TIMED_OUT) return close(failure("run-timeout", facts()));
    // the cancel request is in the row, so whatever closing this is, closeJob closes the job
    // cancelled (R6 ②) and writes none of it
    if (result === CANCELLED) return close(failure("cancelled", facts()));
    // a yield counts as progress only when the job's checkpoint moved during this run
    const progressed = () => readJob(db, job.id)?.checkpoint !== job.checkpoint;
    try {
      const budgetResumesAt = () => options.broker?.budgetUsage().resetsAt;
      return close(classifyResult(result, { ...facts(), progressed, budgetResumesAt }));
    } catch (error) {
      // a database error (e.g. a locked file) leaves the job running for a rerun
      if (!(error instanceof JobWriteError)) throw error;
      onError(error.cause);
      return close(failure("write-error", facts()));
    }
  }

  // A claim never runs inside its caller's stack: a caller that wakes the runner
  // from its own open transaction must not have the claim join that transaction.
  /** Settles once every runOnce asked for so far has claimed (stop waits for it). */
  let claims: Promise<unknown> = Promise.resolve();
  function runOnce(): Promise<JobRun | undefined> {
    const claimed = claims.then(() => ({ running: claim() }));
    claims = claimed.catch(() => {});
    return claimed.then(({ running }) => running);
  }

  let stopped = false;
  /** Ends the drain's wait for a running job to close: a wake claims at once. */
  let woken: (() => void) | undefined;
  let draining: Promise<void> | undefined;
  function wake(): Promise<void> {
    // stopped, the drain body would finish before `draining` is assigned and
    // leave a settled promise there, so no later wake would drain again
    if (stopped) return Promise.resolve();
    woken?.();
    draining ??= (async () => {
      try {
        await Promise.resolve(); // as runOnce: not in the caller's stack
        while (!stopped) {
          for (let running = claim(); running; running = stopped ? undefined : claim()) {
            // the job stays running and is claimed again when its lease runs out
            running.catch(onError);
          }
          if (held.size > 0) {
            // a job closed (a place may be free) or a wake (new work, a raised
            // limit, a lease to reclaim): either way, claim again
            const wakes = new Promise<void>((resolve) => (woken = resolve));
            await Promise.race([...held.values(), wakes]);
          } else break; // nothing runs, and no wake can arrive between the claim and here
        }
      } catch (error) {
        onError(error); // a failing claim, e.g. a locked file: the next wake claims again
      } finally {
        woken = undefined;
        draining = undefined;
      }
    })();
    return draining;
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    cancelRunning(jobId) {
      const cancel = active.get(jobId);
      cancel?.();
      return cancel !== undefined;
    },
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
      await claims;
      while (held.size > 0) await Promise.all(held.values());
    },
  };
}
