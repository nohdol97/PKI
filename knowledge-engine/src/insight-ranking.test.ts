// P01-R4 (C2b): the six axes and the score, a pure function of the stored signals and the time.
import { describe, expect, it } from "vitest";
import { rankInsight, type RankingSignals } from "./insight-ranking.ts";

const NOW = new Date("2026-11-23T00:00:00.000Z");
const base: RankingSignals = {
  type: "dependency_delay",
  confidence: 90,
  urgencyDate: "2026-11-28",
  changedAt: "2026-11-22T12:00:00.000Z",
  userInputCount: 0,
};

describe("rankInsight", () => {
  it("returns six axes in 0..100 and the same values for the same input and time", () => {
    const a = rankInsight(base, NOW);
    expect(rankInsight(base, NOW)).toEqual(a);
    for (const axis of [
      "relevance",
      "impact",
      "urgency",
      "novelty",
      "confidence",
      "actionability",
    ] as const) {
      expect(Number.isInteger(a[axis])).toBe(true);
      expect(a[axis]).toBeGreaterThanOrEqual(0);
      expect(a[axis]).toBeLessThanOrEqual(100);
    }
    expect(a).toMatchObject({ urgency: 100, novelty: 100, confidence: 90, relevance: 50 });
    expect(rankInsight({ ...base, userInputCount: 1 }, NOW).relevance).toBe(100);
  });

  it("ranks a nearer date as more urgent and a lower confidence as a lower score", () => {
    const near = rankInsight({ ...base, urgencyDate: "2026-11-28" }, NOW);
    const far = rankInsight({ ...base, urgencyDate: "2027-02-01" }, NOW);
    expect(near.urgency).toBeGreaterThan(far.urgency);
    expect(rankInsight({ ...base, confidence: 30 }, NOW).score).toBeLessThan(
      rankInsight({ ...base, confidence: 90 }, NOW).score,
    );
  });

  it("takes an interpretation's impact and actionability over the type's defaults (P01-R4, D12)", () => {
    const plain = rankInsight(base, NOW);
    const read = rankInsight({ ...base, impact: 10, actionability: 90 }, NOW);
    expect([read.impact, read.actionability]).toEqual([10, 90]);
    expect(read.score).not.toBe(plain.score);
    expect(rankInsight({ ...base, impact: null, actionability: null }, NOW)).toEqual(plain);
  });

  it("moves relevance by half the preference weight, clamped to 0..100, and is unchanged without one (P03-R8)", () => {
    const plain = rankInsight(base, NOW);
    for (const preference of [null, 0]) {
      const same = rankInsight({ ...base, preference }, NOW);
      expect(same.relevance).toBe(plain.relevance);
      expect(same.score).toBe(plain.score);
    }
    const liked = rankInsight({ ...base, preference: 50 }, NOW);
    expect(liked).toMatchObject({ relevance: 75, preference: 50 });
    // relevance carries weight 0.15: +25 relevance is +3.75 of the sum, rounded with the rest
    expect(liked.score - plain.score).toBeGreaterThanOrEqual(3);
    expect(liked.score - plain.score).toBeLessThanOrEqual(4);
    expect(rankInsight({ ...base, preference: -100 }, NOW).relevance).toBe(0);
    expect(rankInsight({ ...base, userInputCount: 1, preference: 100 }, NOW).relevance).toBe(100);
    expect(plain.preference).toBe(0);
  });
});
