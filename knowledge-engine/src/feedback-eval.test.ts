// P03-C3b (R7, R13): the ranking of the Insights the user gave no feedback on, computed twice over the synthetic
// fixture: without any preference signal (before) and with the signal and `feedback.learned` on (after). The
// two metrics are printed. The fixture shows the device works by its formula; it is no evidence that
// personalization orders Insights better for a real user (P03 "미해결 질문").
import {
  insertItem,
  migrate,
  preferenceSignals,
  recordFeedback,
  saveInsight,
  userDecisions,
  type FeedbackInput,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankInsight } from "./insight-ranking.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

interface FixtureInsight {
  key: string;
  type: string;
  confidence: number;
  urgencyDate: string;
  changedAt: string;
  userInputCount: number;
  relevant: boolean | null;
}
const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/p03-personalization.json", import.meta.url), "utf8"),
) as {
  now: string;
  insights: FixtureInsight[];
  feedback: { insight: string; kind: FeedbackInput["kind"] }[];
};

let db: SqlDriver;
const ids = new Map<string, number>();
beforeEach(() => {
  db = freshDb();
  const attrs = {
    epistemic: "explicit",
    status: "verified",
    validAt: null,
    observedAt: "2026-11-21T00:00:00Z",
  } as const;
  for (const i of fixture.insights) {
    const x = insertItem(db, { type: "Project", name: `${i.key}-x`, ...attrs });
    const y = insertItem(db, { type: "Project", name: `${i.key}-y`, ...attrs });
    ids.set(
      i.key,
      saveInsight(
        db,
        { rule: i.type, xItemId: x, yItemId: y },
        { state: "active", summary: i.key, evidenceIds: [], changedAt: i.changedAt },
      ),
    );
  }
  for (const f of fixture.feedback) {
    const done = db.transaction(() =>
      recordFeedback(
        db,
        userDecisions,
        { target: { kind: "insight", id: ids.get(f.insight) as number }, kind: f.kind },
        fixture.now,
      ),
    );
    if (done.status !== "applied") throw new Error(`fixture feedback refused: ${done.reason}`);
  }
});
afterEach(() => db.close());

const given = new Set(fixture.feedback.map((f) => f.insight));
const evaluated = fixture.insights.filter((i) => !given.has(i.key));

/** Ranks the evaluated Insights; `preferences` is each one's weight or none. */
function metrics(preferences: Map<string, number> | null) {
  const ranked = evaluated
    .map((i, order) => ({
      i,
      order,
      score: rankInsight(
        {
          type: i.type,
          confidence: i.confidence,
          urgencyDate: i.urgencyDate,
          changedAt: i.changedAt,
          userInputCount: i.userInputCount,
          preference: preferences?.get(i.key) ?? null,
        },
        new Date(fixture.now),
      ).score,
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const top3 = ranked.slice(0, 3);
  const ranks = ranked.flatMap((r, at) => (r.i.relevant ? [at + 1] : []));
  return {
    relevantInTop3: top3.filter((r) => r.i.relevant).length / 3,
    meanRelevantRank: ranks.reduce((a, b) => a + b, 0) / ranks.length,
  };
}

const weights = (learned: boolean) =>
  new Map(
    evaluated.map((i) => [
      i.key,
      preferenceSignals(db, [{ kind: "insight", id: ids.get(i.key) as number }], { learned })[0]
        ?.weight ?? 0,
    ]),
  );

describe("feedback.eval: before and after personalization (P03-C3b)", () => {
  it("computes both metrics over the Insights without feedback and the after is no worse", () => {
    const before = metrics(null);
    const after = metrics(weights(true));
    console.log(
      `P03 eval before: top3 relevant ${before.relevantInTop3.toFixed(2)}, mean relevant rank ${before.meanRelevantRank.toFixed(2)}`,
    );
    console.log(
      `P03 eval after:  top3 relevant ${after.relevantInTop3.toFixed(2)}, mean relevant rank ${after.meanRelevantRank.toFixed(2)}`,
    );
    expect(after.relevantInTop3).toBeGreaterThanOrEqual(before.relevantInTop3);
    expect(after.meanRelevantRank).toBeLessThanOrEqual(before.meanRelevantRank);
  });

  it("gives no type-step value while feedback.learned is off, so the ranking is the one without signals", () => {
    const off = weights(false);
    expect([...off.values()].every((w) => w === 0)).toBe(true);
    expect(
      preferenceSignals(db, [{ kind: "insight", id: ids.get("issue-1") as number }])[0],
    ).toMatchObject({
      weight: 0,
      source: null,
    });
    expect(metrics(off)).toEqual(metrics(null));
  });
});
