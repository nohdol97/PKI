// The Broker a job's handler is given (I03-R14, "작업 문맥"): one run's view of the
// Broker. It counts the run's requests and blocks the one past the kind's limit
// before the Broker is asked (so no Provider call, no history row), and it hands
// the run's signal to every request, so a lost lease, a time limit or a cancel
// stops a request wherever the Broker has it, between retries included. The
// handler never holds the Broker itself.
import type { Broker, BrokerResult } from "@pki/providers";
import { JOB_BUDGET_EXHAUSTED } from "./job-outcomes.ts";

/**
 * Broker requests one run of a kind makes when it names no limit. An extraction
 * is two: V02-R6's one and its one repeat for an answer that did not match the
 * schema. One request is up to three Provider attempts.
 */
export const DEFAULT_MAX_REQUESTS = 2;

export interface JobBroker {
  call(raw: unknown): Promise<BrokerResult>;
}

/**
 * `limit` requests may go through; the next ones are blocked with
 * `job-budget-exhausted` (their `requestId` is empty: no request was made). With
 * no `broker` a call is a code error and throws (the handler fails, I03-R9).
 */
export function jobBroker(
  broker: Pick<Broker, "call"> | undefined,
  run: { limit: number; signal: AbortSignal },
): JobBroker {
  let requests = 0;
  return {
    async call(raw) {
      if (!broker) throw new Error("this runner was given no Broker");
      if (requests >= run.limit) {
        return { status: "blocked", requestId: "", reason: JOB_BUDGET_EXHAUSTED };
      }
      requests++;
      return broker.call(raw, run.signal);
    },
  };
}
