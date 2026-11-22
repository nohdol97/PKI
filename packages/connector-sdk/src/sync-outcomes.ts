// The table of I01-R20: what each end of one sync becomes in I03's `connector-sync`
// job. The spec holds the table; this constant is the same table for I03's handler
// to read, and the `sync.outcome-map` test fails when the two differ.
import type { SyncStopCode } from "@pki/contracts";

/** The instance states and the end without a stop that have a row besides the stop codes. */
export type SyncEnd = SyncStopCode | "completed" | "unavailable" | "not-implemented";

export interface SyncOutcomeRow {
  end: SyncEnd;
  /** What the job's handler answers; `done` closes as I03's `succeeded`. */
  result: "retry" | "held" | "dead_letter" | "done";
  /** Whether the run uses one of the job's attempts: only a run that called the Connector does. */
  attempt: "spent" | "unspent" | "n/a";
  /** What a `retry` becomes when the attempts run out. */
  exhaustedResult?: "dead_letter";
  /** When it runs again; I03's own backoff floors (a rate limit's 5-minute floor) still apply. */
  nextRun:
    | "next-period"
    | "backoff"
    | "backoff-or-retry-after"
    | "one-minute"
    | "none"
    | "settings-change-or-hourly-recheck";
}

/** `nextRun: "one-minute"`, in milliseconds. */
export const INSTANCE_BUSY_RETRY_MS = 60_000;

export const SYNC_OUTCOMES: readonly SyncOutcomeRow[] = [
  { end: "completed", result: "done", attempt: "n/a", nextRun: "next-period" },
  { end: "rate-limited", result: "retry", attempt: "spent", nextRun: "backoff-or-retry-after" },
  { end: "connector-error", result: "retry", attempt: "spent", nextRun: "backoff" },
  { end: "instance-busy", result: "retry", attempt: "unspent", nextRun: "one-minute" },
  { end: "aborted", result: "retry", attempt: "spent", nextRun: "backoff" },
  { end: "connector-failed", result: "dead_letter", attempt: "n/a", nextRun: "none" },
  { end: "invalid-page", result: "dead_letter", attempt: "n/a", nextRun: "none" },
  { end: "no-progress", result: "dead_letter", attempt: "n/a", nextRun: "none" },
  { end: "cursor-expired", result: "dead_letter", attempt: "n/a", nextRun: "none" },
  {
    end: "storage-failed",
    result: "retry",
    attempt: "spent",
    exhaustedResult: "dead_letter",
    nextRun: "backoff",
  },
  {
    end: "unavailable",
    result: "held",
    attempt: "unspent",
    nextRun: "settings-change-or-hourly-recheck",
  },
  {
    end: "not-implemented",
    result: "held",
    attempt: "unspent",
    nextRun: "settings-change-or-hourly-recheck",
  },
];
