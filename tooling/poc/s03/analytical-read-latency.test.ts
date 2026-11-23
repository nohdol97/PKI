/* eslint-disable pki/module-boundary -- the smoke test of the measurement script next to it (S03 decision 35 ⑥) */
// The measurement script runs end to end on a small world: every list has its items, nothing is truncated, and the
// median and the maximum are finite positive numbers. The real number (200 of each) is the script's own run.
import { describe, expect, it } from "vitest";
import { measureAnalyticalRead } from "./analytical-read-latency.ts";

describe("analytical read latency script (S03 decision 35 ⑥)", () => {
  it("answers a median and a maximum over a small seeded world, with every item listed", async () => {
    const r = await measureAnalyticalRead({ items: 3, runs: 3 });
    expect(r.items).toBe(3);
    expect(r.samplesMs).toHaveLength(3);
    for (const value of [r.medianMs, r.maxMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(r.maxMs).toBeGreaterThanOrEqual(r.medianMs);
    expect(r.responseBytes).toBeGreaterThan(0);
  }, 60_000);
});
