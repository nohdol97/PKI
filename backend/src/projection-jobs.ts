// The projection jobs' executing side (I03-R7): the handlers of `projection-remove`
// and `projection-rebuild`, the marks that force a rebuild, and the request for one.
// What a removal removes (the versions up to the tombstone's cover, never a newer
// version's item) and the engine and vector projections themselves are I04-T04's: it
// binds each registered projection kind as a ProjectionPort. Here are the parts of a
// run that do not depend on what a projection is: how an error is classified, the
// re-send after a stale fence, the rebuild's change sequence and what it covers.
//
// A removal's errors (R7):
//   - AdapterUnavailableError is a skip (succeeded, code `adapter-unavailable`) only
//     from a projection whose registered kind says `permanentlyAbsent` (the null
//     engine, the empty vector index), a fixed capability and never judged from the
//     error. From any other (a stopped sidecar, say) it is a retryable failure: the
//     removal stays open as a mark, and a skip would erase the mark the rebuild is
//     forced by.
//   - StaleFenceError says the projection took a newer notice meanwhile, not that the
//     job is stale: the removal is sent again with the source's latest canonical
//     version as its fence, still covering only versions up to its own cover.
//   - Any other error is a retryable failure, a code and never the error's text.
//
// A rebuild reads the change sequence `S` (before it reads the canonical store), hands
// it to the projection and, in the transaction that closes it, supersedes the removals
// registered at or before `S`. A deletion that committed while it ran has a higher
// sequence (its tombstone raised it before the removal was registered) and runs after.
import { AdapterUnavailableError, StaleFenceError } from "@pki/contracts";
import {
  closeCoveredRemoves,
  latestCanonicalVersion,
  markedProjections,
  PROJECTION_REBUILD_KIND,
  PROJECTION_REMOVE_KIND,
  readChangeSeq,
  recordResultCounts,
  UNKNOWN_PROJECTION_CODE,
  registerJob,
  type DerivativeKind,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import type { JobHandler, JobKindSettings } from "./job-runner.ts";
import type { JobResult } from "./job-outcomes.ts";

/** No port is bound for the job's projection: retried with the backoff, and a rebuild that dies of it is not registered again by a check (storage markedProjections). */
export const UNKNOWN_PROJECTION = UNKNOWN_PROJECTION_CODE;

/** The code of a skipped removal or rebuild (ARCHITECTURE 5.4). */
export const ADAPTER_UNAVAILABLE = "adapter-unavailable";

/** A removal sent again after StaleFenceError, at most this often in one run; then it is a retryable failure. */
export const MAX_STALE_RESENDS = 2;

/** One removal call: the projection removes what versions up to `coversVersion` of the source produced. */
export interface ProjectionRemoveRequest {
  readonly sourceId: number;
  /** The tombstone's cover. Never widened by a re-send: a newer version's item stays. */
  readonly coversVersion: number;
  /** The fence the call carries: the cover at first; the source's latest canonical version after a stale fence. */
  readonly fenceVersion: number;
  /** The change sequence of the registration (the deletion's), for the projection's ordering. */
  readonly changeSeq: number;
  readonly signal: AbortSignal;
}

export interface ProjectionRebuildRequest {
  /** The change sequence read before the canonical store: the projection reports it as applied. */
  readonly readSeq: number;
  readonly signal: AbortSignal;
}

/**
 * What a registered projection kind (I04-T04) hands the handlers. Errors thrown are the
 * contracts' (AdapterUnavailableError, StaleFenceError) or any other.
 */
export interface ProjectionPort {
  /** The registered kind's mark; only a mark skips, never an error seen at run time. */
  readonly registered: Pick<DerivativeKind, "permanentlyAbsent">;
  remove(request: ProjectionRemoveRequest): Promise<void>;
  /** Empties the projection and rebuilds it from the canonical store (V02-R13). */
  rebuild(request: ProjectionRebuildRequest): Promise<void>;
}

/** The ports by target (the projection's name in a job row). */
export type ProjectionPorts = Readonly<Record<string, ProjectionPort>>;

/**
 * Provisional: a rebuild's cost grows with the corpus and is not measured (ADR 0013
 * consequences), so its run limit is six times the default; a removal keeps the default.
 */
export const PROJECTION_KIND_SETTINGS: Readonly<Record<string, JobKindSettings>> = {
  [PROJECTION_REMOVE_KIND]: {},
  [PROJECTION_REBUILD_KIND]: { runTimeoutMs: 60 * 60_000 },
};

export interface ProjectionHandlerOptions {
  db: SqlDriver;
  ports: ProjectionPorts;
  /** The time a covered removal's close is dated with; default the system's. */
  now?: () => Date;
  /** An error a projection raised, for a log that keeps its class only. */
  onError?: (error: unknown) => void;
}

const fail = (code: string, retryable = true): JobResult => ({ status: "fail", code, retryable });
const skipped = (): JobResult => ({
  status: "succeeded",
  write: () => {},
  code: ADAPTER_UNAVAILABLE,
});

export function projectionHandlers(options: ProjectionHandlerOptions): Record<string, JobHandler> {
  const { db, ports } = options;
  const now = options.now ?? (() => new Date());
  const absent = (port: ProjectionPort) => port.registered.permanentlyAbsent === true;

  /** What an error of a projection call does to its job (R7); the skip is the mark's alone. */
  function classify(error: unknown, port: ProjectionPort): JobResult {
    if (error instanceof AdapterUnavailableError) {
      return absent(port) ? skipped() : fail("projection-unavailable");
    }
    options.onError?.(error);
    return fail(error instanceof StaleFenceError ? "stale-fence" : "projection-error");
  }

  const remove: JobHandler = async (job, context) => {
    const port = ports[job.target];
    if (!port) return fail(UNKNOWN_PROJECTION);
    // the removal names its source and its cover by the row (source_id, fence_version)
    const sourceId = job.sourceId as number;
    const coversVersion = job.fenceVersion as number;
    let fenceVersion = coversVersion;
    for (let resends = 0; ; resends++) {
      try {
        await port.remove({
          sourceId,
          coversVersion,
          fenceVersion,
          changeSeq: job.registeredChangeSeq,
          signal: context.signal,
        });
        return { status: "succeeded", write: () => {} };
      } catch (error) {
        if (!(error instanceof StaleFenceError) || resends >= MAX_STALE_RESENDS) {
          return classify(error, port);
        }
        // the projection took a newer notice: send again with the source's latest version
        fenceVersion = latestCanonicalVersion(db, sourceId);
      }
    }
  };

  const rebuild: JobHandler = async (job, context) => {
    const port = ports[job.target];
    if (!port) return fail(UNKNOWN_PROJECTION);
    const readSeq = readChangeSeq(db); // before the projection reads the canonical store
    let code: string | undefined;
    try {
      await port.rebuild({ readSeq, signal: context.signal });
    } catch (error) {
      const result = classify(error, port);
      if (result.status !== "succeeded") return result;
      code = ADAPTER_UNAVAILABLE; // nothing to rebuild; the removals up to `readSeq` have nothing to remove either
    }
    return {
      status: "succeeded",
      ...(code && { code }),
      write: () => {
        const covered = closeCoveredRemoves(db, job.target, readSeq, now());
        recordResultCounts(db, job.id, { covered, readSeq });
      },
    };
  };

  return { [PROJECTION_REMOVE_KIND]: remove, [PROJECTION_REBUILD_KIND]: rebuild };
}

/**
 * Registers a forced rebuild of one projection (user priority), whatever its applied
 * change sequence says. Only one is open per projection: a second request returns the
 * open one. The caller wakes the runner for a new one.
 */
export function requestProjectionRebuild(
  db: SqlDriver,
  target: string,
  options: { at?: Date } = {},
): { registered: true; job: StoredJob } | { registered: false; job: StoredJob } {
  if (target === "") throw new RangeError("a projection is named");
  const result = registerJob(db, {
    kind: PROJECTION_REBUILD_KIND,
    target,
    priority: "user",
    ...(options.at && { at: options.at }),
  });
  return result.registered
    ? { registered: true, job: result.job }
    : { registered: false, job: result.existing };
}

/**
 * The marks (R7 "표식"): a projection that some unfinished or given-up removal may still
 * hold deleted content for gets a rebuild, whatever its applied sequence says. At start,
 * any unfinished or given-up removal marks; at a check, a given-up one or one open more
 * than an hour since registered. Returns the rebuilds newly registered, for the caller to
 * wake the runner with; a projection that already has an open rebuild adds none.
 */
export function checkProjectionMarkers(
  db: SqlDriver,
  check: { phase: "start" | "check"; now: number },
): StoredJob[] {
  const registered: StoredJob[] = [];
  const marks = check.phase === "start" ? { phase: "start" as const } : check;
  for (const target of markedProjections(db, marks)) {
    const request = requestProjectionRebuild(db, target, { at: new Date(check.now) });
    if (request.registered) registered.push(request.job);
  }
  return registered;
}
