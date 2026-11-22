// History writer (V01-R13, T07 handoff 3): the Broker's CallRecorder over
// provider_calls, one row per attempt. Each column is picked by name from the
// record, so nothing else an entry carries reaches the DB, and a value that is not
// one of the known codes is stored as a code saying so, never as given.
import { DATA_CLASSES, PROVIDER_IDS, TASK_KINDS } from "@pki/contracts";
import {
  finishProviderCall,
  insertProviderCall,
  interruptStartedCalls,
  listAttemptTimes,
  type SqlDriver,
} from "@pki/storage";
import type { CallOutcome, CallRecord, CallRecorder } from "./broker.ts";

const OUTCOMES: ReadonlySet<CallOutcome> = new Set<CallOutcome>([
  "ok",
  "timeout",
  "rate-limited",
  "provider-error",
  "invalid-output",
  "blocked",
  "budget-exhausted",
  "started",
  "interrupted",
  "cancelled",
]);
const CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CODE = 64;

const known = (set: readonly string[] | ReadonlySet<string>, value: string) =>
  (Array.isArray(set) ? set.includes(value) : (set as ReadonlySet<string>).has(value))
    ? value
    : "unrecognized";

/** A reason must look like a code; Provider or gate text never passes. */
const reasonCode = (reason: string) =>
  reason.length <= MAX_CODE && CODE.test(reason) ? reason : "unrecognized-reason";

export function createCallRecorder(
  db: SqlDriver,
  now: () => Date = () => new Date(),
): CallRecorder {
  const write = (entry: CallRecord) =>
    insertProviderCall(db, {
      requestId: entry.requestId,
      attempt: entry.attempt,
      provider: known(PROVIDER_IDS, entry.providerId),
      destination: entry.destination ?? null,
      taskKind: known(TASK_KINDS, entry.taskKind),
      classification: known(DATA_CLASSES, entry.classification),
      policyVersion: entry.policyVersion ?? null,
      outcome: known(OUTCOMES, entry.outcome),
      reason: entry.reason === undefined ? null : reasonCode(entry.reason),
      durationMs: entry.durationMs ?? null,
      createdAt: now().toISOString(),
    });
  return {
    record(entry) {
      write(entry);
    },
    begin(entry) {
      const id = write({ ...entry, outcome: "started" });
      return ({ outcome, durationMs }) =>
        finishProviderCall(db, id, { outcome: known(OUTCOMES, outcome), durationMs });
    },
    attemptTimes: (afterMs) => listAttemptTimes(db, afterMs),
    interruptStarted: () => interruptStartedCalls(db),
  };
}
