// Where a run's result goes (I03-R9..R11, "실행 결과가 가는 곳"): one function
// from what a handler hands back to what storage's closeJob stores (the next
// status, whether the attempt is spent, the code, when the job may run again),
// and the backoff. No kind has a branch here: a Connector sync's stop codes and a
// projection's errors are turned into these results by their own handlers.
import type { BrokerResult } from "@pki/providers";
import { isReasonCode, type DerivedItem, type JobClosing } from "@pki/storage";
import { BACKOFF_MAX_MS } from "./schedule.ts";

/** The first retry's wait; each later attempt doubles it up to BACKOFF_MAX_MS (I03-R10). */
export const BACKOFF_BASE_MS = 30_000;
/** A rate-limited call waits at least this long. */
export const RATE_LIMIT_MIN_MS = 5 * 60_000;
/** A yield that made progress runs again after this, its attempt unspent (I03-R14). */
export const YIELD_DELAY_MS = 60_000;
/** One run's time limit for a kind that names none (I03-R14). */
export const DEFAULT_RUN_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a retryable failure waits: 30 s × 2^(attempt − 1), at most an hour; a
 * rate limit at least five minutes. `attempt` counts the run that failed (the
 * first is 1). No jitter: one user, and tests are deterministic (I03-R10).
 */
export function backoffMs(attempt: number, code?: string): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("an attempt is a whole number from 1");
  }
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return code === "rate-limited" ? Math.max(wait, RATE_LIMIT_MIN_MS) : wait;
}

/**
 * What a handler hands back: its result to write (the runner writes it behind
 * I03-R6's checks), a job it found stale, a yield, a hold for a reason it knows
 * without an outside call, a failure, or a Broker result that was not an answer,
 * as the Broker gave it.
 */
export type JobResult =
  | { status: "succeeded"; write: () => void }
  | { status: "succeeded"; items: readonly DerivedItem[] }
  | { status: "superseded" }
  | { status: "yield" }
  | { status: "held"; reason: string }
  | { status: "fail"; code: string; retryable: boolean }
  | Exclude<BrokerResult, { status: "ok" }>;

/** The run a result came from: its attempt (raised by the claim) and the wall clock. */
export interface RunFacts {
  attempts: number;
  now: number;
}

/** A retryable failure: retry after the backoff of the run's attempt, the attempt spent. */
export function failure(code: string, run: RunFacts): JobClosing {
  return { status: "retry", reason: code, runAfter: run.now + backoffMs(run.attempts, code) };
}

/**
 * The run of a result: `progressed` is asked only for a yield, `budgetResumesAt`
 * only for a spent window budget (the Broker's `budgetUsage().resetsAt`; none
 * known gives the longest wait).
 */
export type ClassifiedRun = RunFacts & {
  progressed: () => boolean;
  budgetResumesAt?: () => number | null | undefined;
};

/** The block the context's wrapped Broker gives a run past its request budget (I03-R14). */
export const JOB_BUDGET_EXHAUSTED = "job-budget-exhausted";

/** A yield: it ran again later, its attempt unspent, only when the checkpoint moved. */
function yielded(run: ClassifiedRun): JobClosing {
  return run.progressed()
    ? { status: "queued", runAfter: run.now + YIELD_DELAY_MS }
    : failure("yield-no-progress", run);
}

/** The closing of a declared result; undefined for anything else. */
function closing(result: JobResult, run: ClassifiedRun): JobClosing | undefined {
  // a handler is untyped at run time: read what it handed back defensively
  if (typeof result !== "object" || result === null) return undefined;
  switch (result.status) {
    case "succeeded":
      return ("write" in result && typeof result.write === "function") ||
        ("items" in result && Array.isArray(result.items))
        ? result
        : undefined;
    case "superseded":
      return { status: "superseded" };
    case "held":
      return { status: "held", reason: result.reason };
    case "yield":
      return yielded(run);
    case "fail":
      if (typeof result.retryable !== "boolean") return undefined;
      return result.retryable
        ? failure(result.code, run)
        : { status: "dead_letter", reason: result.code };
    case "blocked":
      // the Broker made no call: the attempt is given back either way (I03-R11)
      if (result.reason === JOB_BUDGET_EXHAUSTED) return yielded(run); // a handler that did not yield itself
      return result.reason === "budget-exhausted"
        ? {
            status: "retry",
            reason: result.reason,
            // when the oldest attempt leaves the window, due now at the earliest and one hour at the latest
            runAfter: Math.min(
              Math.max(run.budgetResumesAt?.() ?? Number.POSITIVE_INFINITY, run.now),
              run.now + BACKOFF_MAX_MS,
            ),
            refund: true,
          }
        : { status: "held", reason: result.reason };
    case "cancelled":
      // a cancel request closes the job cancelled whatever this says (closeJob, I03-R12);
      // without one it is a failure to retry (the run was cut by its time limit or a lost lease)
      return failure("cancelled", run);
    case "rejected":
      // a source gone is the fence's answer; any other rejection is the code's fault
      return result.reason === "missing-source"
        ? { status: "superseded" }
        : { status: "dead_letter", reason: result.reason };
    case "failed":
      // V02-R6 asked again once already: the same source is not asked a third time
      return result.error === "invalid-output"
        ? { status: "dead_letter", reason: result.error }
        : failure(result.error, run);
    default:
      return undefined;
  }
}

/**
 * The row of the outcome table `result` falls in. `progressed`: the job's
 * checkpoint moved during the run (a yield without it is a failure, so it cannot
 * repeat forever). A result that is none of the declared ones is the retryable
 * failure `handler-error`, like a handler that threw (I03-R9). A reason that is
 * missing or not a code is never stored: a missing one is such a result, text
 * gives the job up with a fixed code.
 */
export function classifyResult(result: JobResult, run: ClassifiedRun): JobClosing {
  const to = closing(result, run);
  if (to === undefined) return failure("handler-error", run);
  if (!("reason" in to)) return to;
  if (typeof to.reason !== "string") return failure("handler-error", run);
  return isReasonCode(to.reason) ? to : { status: "dead_letter", reason: "invalid-reason" };
}
