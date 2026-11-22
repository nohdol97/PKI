// The injected clock (I03 design "시계"): the Broker's clock shape plus a
// monotonic reading, so one clock serves the Broker, the runner and the scheduler.
import type { BrokerDeps } from "@pki/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { systemClock, systemTimeZone, type Clock } from "./clock.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("clock.injected", () => {
  it("is accepted wherever the Broker takes its clock", () => {
    const fake: Clock = { now: () => 0, sleep: async () => undefined, monotonic: () => 0 };
    const brokerClock: BrokerDeps["clock"] = fake;
    expect(brokerClock).toBe(fake);
  });

  it("reads the wall clock, sleeps and reads a monotonic clock that never goes back", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-01-15T12:00:00Z") });
    expect(systemClock.now()).toBe(Date.parse("2026-01-15T12:00:00Z"));
    let woke = false;
    const sleeping = systemClock.sleep(1_000).then(() => (woke = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(woke).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(woke).toBe(true);
    vi.useRealTimers();
    const first = systemClock.monotonic();
    expect(systemClock.monotonic()).toBeGreaterThanOrEqual(first);
  });

  it("reads the time zone the runtime resolves", () => {
    expect(systemTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
