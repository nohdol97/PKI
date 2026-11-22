// The one clock the job runner and the scheduler read (I03 design "시계"). It is
// the clock the Broker already takes (`BrokerDeps.clock`: `now`, `sleep`) plus a
// monotonic reading, so the same object is handed to the Broker too. `now()` is the
// wall clock in UTC milliseconds and gives every stored time; `monotonic()` times
// run limits and heartbeat intervals. Tests inject a fake clock to stand in for
// sleep (the wall clock jumps with no check in between), clock regression and
// daylight saving time.
import type { BrokerDeps } from "@pki/providers";

/** The Broker's clock shape. */
export type BrokerClock = NonNullable<BrokerDeps["clock"]>;

export interface Clock extends BrokerClock {
  /** Milliseconds from an arbitrary origin; never goes back within a process. */
  monotonic(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true }); // a cut signal ends the wait early
    }),
  monotonic: () => performance.now(),
};

/**
 * The time zone daily and weekly slots are computed in, read at every check so a
 * change made while running is seen (I03-R22; whether the runtime sees it is I03-A5).
 */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
