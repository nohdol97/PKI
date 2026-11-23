/* eslint-disable pki/module-boundary -- the smoke test of the measurement script next to it (I02B-C27) */
// I02B-C27: the measurement script prints a p50 and a p95 that are finite positive numbers over every
// normal fixture. The parser runs in-process here (a stand-in for the host); the host's own numbers are
// the script's run, pasted in the PR.
import { describe, expect, it } from "vitest";
import { inProcessNormalizer } from "../../../backend/src/local-normalizer.test-support.ts";
import { measureLocalFiles, percentile } from "./local-files-latency.ts";

describe("local-files latency script (I02B-C27)", () => {
  it("p50 and p95 are finite positive numbers over the normal fixtures", async () => {
    const r = await measureLocalFiles({ normalizer: inProcessNormalizer() });
    expect(r.files).toBeGreaterThanOrEqual(10);
    expect(r.samplesMs).toHaveLength(r.files);
    for (const value of [r.p50Ms, r.p95Ms]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
    expect(r.p95Ms).toBeGreaterThanOrEqual(r.p50Ms);
  }, 60_000);

  it("the percentile is the nearest rank", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});
