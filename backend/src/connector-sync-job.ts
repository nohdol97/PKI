// The `connector-sync` job kind (I03-R19) and what surrounds it: the default periods
// (R18), and the release of a held collector (R16 ②′).
//
// The handler calls the Connector manager's `sync` with the run's abort signal and turns
// what the sync ended with into a job result by I01's table (`SYNC_OUTCOMES`; that table is
// not written out again here): a row's result and attempt column choose among the
// handler's results, nothing is chosen by the code of one stop. The sync returns a result
// with `stopped` rather than throwing; only a bug in the manager is thrown, and the runner
// makes that the `handler-error` retry. The instance lock is the manager's (`tryLockInstance`
// keeps one per database handle), so this handler never takes a second lock of its own and
// the manager it is given must be the one the import path uses.
//
// A collector whose instance cannot run (`unavailable`, `not-implemented`) is held by a
// reason that is the instance's own state, never a Connector's text. Three things put it
// back: the transaction that changes the instance's settings (`releaseHeldCollector`, called
// inside that write), a start that finds the instance ready (`releaseReadyCollectors`), and
// the hourly recheck (`recheckInstances`), one health check per instance that is not ready.
import {
  INSTANCE_BUSY_RETRY_MS,
  SYNC_OUTCOMES,
  type SyncEnd,
  type SyncOutcomeRow,
} from "@pki/connector-sdk";
import type { ConnectorSummary, SyncResponse } from "@pki/contracts";
import { errorClass, log } from "@pki/providers";
import { recordResultCounts, requeueHeldTarget, type SqlDriver } from "@pki/storage";
import type { ConnectorManager, ConnectorRecheck } from "./connectors.ts";
import { COLLECTOR_HELD_REASONS, HELD_REEVALUATION_MS } from "./held-release.ts";
import type { JobResult } from "./job-outcomes.ts";
import type { JobHandler, JobRunner } from "./job-runner.ts";
import { JSONL_CONNECTOR_KIND } from "./jsonl-import.ts";
import type { Period } from "./schedule.ts";
import { MAINTENANCE_KIND, type Scheduler } from "./scheduler.ts";

export const CONNECTOR_SYNC_KIND = "connector-sync";

/** The default period of an instance that can pull (I03-R18). */
export const SYNC_PERIOD: Period = { kind: "hourly" };
/** The default period of the cleanup (I03-R18, R21): the retention would stop if it did. */
export const CLEANUP_PERIOD: Period = { kind: "daily", at: { hour: 3, minute: 0 } };

/** How long a run that met no manager yet waits (it never ran a Connector, so no attempt is spent). */
export const MANAGER_NOT_READY_RETRY_MS = 5_000;

/** The code of a job whose instance is not among the configured ones any more. */
export const INSTANCE_NOT_FOUND = "instance-not-found";

/** The part of the Connector manager the handler needs. */
export type SyncManager = Pick<ConnectorManager, "sync" | "list">;

type SyncAnswer = Awaited<ReturnType<ConnectorManager["sync"]>>;

/** What a sync that stopped (or did not) counted, as the whole numbers a job row may hold. */
function countsOf(sync: SyncResponse): Record<string, number> {
  return {
    received: sync.received,
    created: sync.created,
    unchanged: sync.unchanged,
    scopeUpdated: sync.scopeUpdated,
    stale: sync.stale,
    staleTombstone: sync.staleTombstone,
    blocked: sync.blocked,
    tombstoned: sync.tombstoned,
    rejected: sync.rejectedCount,
    rescanned: sync.rescanned ? 1 : 0,
    deletionsMayBeMissed: sync.deletionsMayBeMissed ? 1 : 0,
  };
}

/** The reason an instance that cannot run holds its job for: its state, as a code (I01-R20). */
function heldReason(summary: ConnectorSummary | undefined): string {
  if (summary?.state === "not-implemented") return "not-implemented";
  return summary?.reason ?? "connector-unavailable";
}

/** The end of a sync for I01's table: the stop code, or `completed`. */
const endOf = (sync: SyncResponse): SyncEnd => sync.stopped ?? "completed";

/** The wait of each `nextRun` that an unspent retry can have (I01-R20); only one-minute exists. */
const UNSPENT_RETRY_DELAYS: Readonly<Partial<Record<SyncOutcomeRow["nextRun"], number>>> = {
  "one-minute": INSTANCE_BUSY_RETRY_MS,
};

/**
 * The handler's result for one end, by the table row. `retry`: an attempt spent waits
 * the backoff (and what the origin asked); one that is not spent (the Connector was never
 * called) waits the row's fixed time and gives the attempt back.
 */
function resultOf(end: SyncEnd, sync: SyncResponse | undefined, reason: string): JobResult {
  const row = SYNC_OUTCOMES.find((r) => r.end === end);
  if (!row) return { status: "fail", code: "unmapped-sync-end", retryable: false };
  switch (row.result) {
    case "done":
      return { status: "succeeded", write: () => {} };
    case "held":
      return { status: "held", reason };
    case "dead_letter":
      return { status: "fail", code: end, retryable: false };
    case "retry":
      if (row.attempt === "unspent") {
        // the wait is the row's `nextRun`; a value this map does not know is not guessed
        const delayMs = UNSPENT_RETRY_DELAYS[row.nextRun];
        return delayMs === undefined
          ? { status: "fail", code: "unmapped-sync-end", retryable: false }
          : { status: "defer", code: end, delayMs };
      }
      return {
        status: "fail",
        code: end,
        retryable: true,
        ...(sync?.retryAfterMs !== undefined && { retryAfterMs: sync.retryAfterMs }),
      };
  }
}

/**
 * The `connector-sync` handler: the job's target is the Connector instance's id. `manager`
 * is read at each run: the runner is made before the manager (the manager wakes the
 * runner), so the composition hands it over late.
 */
export function createConnectorSyncHandler(options: {
  db: SqlDriver;
  /** Undefined while the composition has not handed the manager over (a wake before it is built). */
  manager: () => SyncManager | undefined;
}): JobHandler {
  const { db } = options;
  return async (job, context) => {
    const manager = options.manager();
    // not built yet: no Connector was called, so wait and give the attempt back
    if (!manager) {
      return { status: "defer", code: "manager-not-ready", delayMs: MANAGER_NOT_READY_RETRY_MS };
    }
    const answer: SyncAnswer = await manager.sync(job.target, { signal: context.signal });
    if ("error" in answer) {
      // the instance left the configuration: nothing to retry until the user fixes it
      if (answer.error === "not-found") {
        return { status: "fail", code: INSTANCE_NOT_FOUND, retryable: false };
      }
      const summary = manager.list().find((s) => s.id === job.target);
      const end = summary?.state === "not-implemented" ? "not-implemented" : "unavailable";
      return resultOf(end, undefined, heldReason(summary));
    }
    const end = endOf(answer);
    const result = resultOf(end, answer, "");
    // a sync that never reached the Connector counted nothing; one that did leaves its counts,
    // under the lease, whether it finished (the write below) or stopped after storing pages
    if (result.status === "succeeded") {
      return { ...result, write: () => recordResultCounts(db, job.id, countsOf(answer)) };
    }
    if (end !== "instance-busy") {
      recordResultCounts(db, job.id, countsOf(answer), { leaseToken: job.leaseToken });
    }
    return result;
  };
}

/** Kinds that take their records from the API, with nothing to pull (I01, `jsonl-import`). */
const API_ONLY_KINDS: readonly string[] = [JSONL_CONNECTOR_KIND];

/** An instance that can pull: ready, and not one that only takes what the API hands it (I03-R18). */
export const canPull = (summary: ConnectorSummary): boolean =>
  summary.state === "ready" && !API_ONLY_KINDS.includes(summary.kind);

/**
 * Makes the default periods that do not exist yet: an hourly sync for each instance that can
 * pull and the daily cleanup. A period that exists is left as the user set it (changed or
 * turned off). Returns the periods made, as `kind:target` (the cleanup as its kind).
 */
export function ensureDefaultSchedules(
  scheduler: Pick<Scheduler, "ensureSchedule">,
  summaries: readonly ConnectorSummary[],
): string[] {
  const made: string[] = [];
  for (const summary of summaries.filter(canPull)) {
    const { created } = scheduler.ensureSchedule({
      kind: CONNECTOR_SYNC_KIND,
      target: summary.id,
      period: SYNC_PERIOD,
    });
    if (created) made.push(`${CONNECTOR_SYNC_KIND}:${summary.id}`);
  }
  if (scheduler.ensureSchedule({ kind: MAINTENANCE_KIND, period: CLEANUP_PERIOD }).created) {
    made.push(MAINTENANCE_KIND);
  }
  return made;
}

/**
 * Puts back the held jobs of one instance. Call it inside the transaction that writes the
 * instance's settings, so a stop between the write and the release loses nothing (R16 ①).
 * Returns how many went back; the next claim runs them (and holds them again, their attempt
 * unspent, if the instance still cannot run).
 */
export function releaseHeldCollector(db: SqlDriver, instanceId: string, at?: Date): number {
  return requeueHeldTarget(db, {
    kind: CONNECTOR_SYNC_KIND,
    target: instanceId,
    reasons: COLLECTOR_HELD_REASONS,
    ...(at && { at }),
  });
}

/**
 * At a start: the held collector jobs of the instances that initialized ready go back. An
 * app update that makes a site collector work, and a settings file fixed while the backend
 * was off, both end here. Returns the instances whose held jobs were put back.
 */
export function releaseReadyCollectors(
  db: SqlDriver,
  summaries: readonly ConnectorSummary[],
  at?: Date,
): string[] {
  const released: string[] = [];
  for (const summary of summaries) {
    if (summary.state === "ready" && releaseHeldCollector(db, summary.id, at) > 0) {
      released.push(summary.id);
    }
  }
  return released;
}

/** The longest `stop` waits for a pass under way. */
export const STOP_GRACE_MS = 1_000;

/** How long one instance's recheck may take before the pass goes on without it. */
export const RECHECK_TIMEOUT_MS = 60_000;

export interface RecheckOptions {
  db: SqlDriver;
  manager: Pick<ConnectorManager, "list"> & ConnectorRecheck;
  runner: Pick<JobRunner, "wake">;
  /** Called with each instance that became ready (the composition makes its default period). */
  onUsable?: (summary: ConnectorSummary) => void;
  at?: () => Date;
  /** Default RECHECK_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Aborted by `stop`: the pass ends at once and writes nothing more. */
  signal?: AbortSignal;
  /** The instances whose recheck has not settled: kept across passes so a hung one is not started again. */
  inFlight?: Set<string>;
}

/** The instance's state after its recheck, or undefined when it did not settle in time. */
async function boundedRecheck(
  manager: ConnectorRecheck,
  id: string,
  timeoutMs: number,
  inFlight: Set<string>,
  signal?: AbortSignal,
): Promise<ConnectorSummary["state"] | undefined> {
  const settled = manager.recheck(id);
  inFlight.add(id);
  const done = () => void inFlight.delete(id);
  settled.then(done, done);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<undefined>(
        (resolve) => (timer = setTimeout(() => resolve(undefined), timeoutMs)),
      ),
      new Promise<undefined>((resolve) =>
        signal?.addEventListener("abort", () => resolve(undefined)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hourly recheck (R16 ②′): each instance that is not ready is initialized again and
 * asked for its health once, at most `timeoutMs` each and never while an earlier recheck of it
 * is still pending; one that is ok has its held jobs put back and is reported usable. Every
 * ready instance also has its held collector jobs put back: a job that closed held after the
 * instance became ready (its sync met the old state, the recheck found it ready while the job
 * was still running) would otherwise wait for a restart. Returns the ids that became ready.
 */
export async function recheckInstances(options: RecheckOptions): Promise<string[]> {
  const { db, manager } = options;
  const inFlight = options.inFlight ?? new Set<string>();
  const timeoutMs = options.timeoutMs ?? RECHECK_TIMEOUT_MS;
  const usable: string[] = [];
  for (const { id } of manager.list().filter((s) => s.state !== "ready" && !inFlight.has(s.id))) {
    const state = await boundedRecheck(manager, id, timeoutMs, inFlight, options.signal);
    if (options.signal?.aborted) return usable; // stopped: the database may be closed
    if (state !== "ready") continue;
    usable.push(id);
    const summary = manager.list().find((s) => s.id === id);
    if (summary) options.onUsable?.(summary);
  }
  const released = releaseReadyCollectors(db, manager.list(), options.at?.());
  if (usable.length > 0 || released.length > 0) void options.runner.wake();
  return usable;
}

/**
 * Starts the upkeep of collectors at boot: makes the default periods, puts back the held
 * collectors of the instances that are ready, and rechecks the ones that are not now and every
 * `HELD_REEVALUATION_MS` (one hour, the same clock as the Broker-held jobs' re-evaluation).
 * The timer is unref'd and `stop` clears it.
 */
export function startCollectorUpkeep(options: {
  db: SqlDriver;
  manager: Pick<ConnectorManager, "list"> & ConnectorRecheck;
  scheduler: Pick<Scheduler, "ensureSchedule">;
  runner: Pick<JobRunner, "wake">;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): { stop(): Promise<void> } {
  const { db, manager, scheduler, runner } = options;
  const onError =
    options.onError ?? ((e) => log("collector-upkeep-error", { error: errorClass(e) }));
  const guarded = (work: () => void) => {
    try {
      work();
    } catch (error) {
      onError(error);
    }
  };
  guarded(() => {
    ensureDefaultSchedules(scheduler, manager.list());
    if (releaseReadyCollectors(db, manager.list()).length > 0) void runner.wake();
  });
  const inFlight = new Set<string>();
  const stopping = new AbortController();
  let current: Promise<void> | undefined; // a pass still running is not started again
  const run = async () => {
    try {
      await recheckInstances({
        db,
        manager,
        runner,
        inFlight,
        signal: stopping.signal,
        onUsable: () => guarded(() => ensureDefaultSchedules(scheduler, manager.list())),
      });
    } catch (error) {
      onError(error);
    } finally {
      current = undefined;
    }
  };
  const pass = async () => {
    if (current || stopping.signal.aborted) return;
    current = run();
    await current;
  };
  void pass();
  const timer = setInterval(() => void pass(), options.intervalMs ?? HELD_REEVALUATION_MS);
  timer.unref();
  return {
    // the timer is cleared and a pass under way ends without another write; resolves once it has
    stop: async () => {
      clearInterval(timer);
      stopping.abort();
      // a pass ends at once on the abort; the grace bounds even a pass that does not, so quitting
      // never waits on a Connector (its late result is dropped: the abort flag blocks every write)
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        current,
        new Promise((resolve) => (grace = setTimeout(resolve, STOP_GRACE_MS))),
      ]);
      clearTimeout(grace);
    },
  };
}
