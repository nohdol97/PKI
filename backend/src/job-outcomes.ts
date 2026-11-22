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

function closing(result: JobResult, run: RunFacts & { progressed: boolean }): JobClosing {
  switch (result.status) {
    case "succeeded":
    case "superseded":
      return result;
    case "held":
      return { status: "held", reason: result.reason };
    case "yield":
      return run.progressed
        ? { status: "queued", runAfter: run.now + YIELD_DELAY_MS }
        : failure("yield-no-progress", run);
    case "fail":
      return result.retryable
        ? failure(result.code, run)
        : { status: "dead_letter", reason: result.code };
    case "blocked":
      // the Broker made no call: the attempt is given back either way (I03-R11).
      // Provisional: a spent budget waits the whole window; T06 asks budgetUsage()
      return result.reason === "budget-exhausted"
        ? {
            status: "retry",
            reason: result.reason,
            runAfter: run.now + BACKOFF_MAX_MS,
            refund: true,
          }
        : { status: "held", reason: result.reason };
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
  }
}

/**
 * The row of the outcome table `result` falls in. `progressed`: the job's
 * checkpoint moved during the run (a yield without it is a failure, so it cannot
 * repeat forever). A reason that is not a code is never stored: the job is given
 * up with a fixed one.
 */
export function classifyResult(
  result: JobResult,
  run: RunFacts & { progressed: boolean },
): JobClosing {
  const to = closing(result, run);
  return "reason" in to && !isReasonCode(to.reason)
    ? { status: "dead_letter", reason: "invalid-reason" }
    : to;
}
