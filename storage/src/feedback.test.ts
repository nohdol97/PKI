// P03-T1: the feedback record, its undo and the preference signal (P03-R1..R7). C1a (kinds and targets),
// C1b (undo), C2a (a preference never touches knowledge; a correction goes through the user's entry), C2b
// (the signal and the mute).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryDbTemplate } from "@pki/testkit";
import {
  FEEDBACK_KINDS,
  feedbackClass,
  type FeedbackKind,
  type FeedbackTarget,
} from "@pki/contracts";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  feedbackLearned,
  listFeedback,
  preferenceSignals,
  recordFeedback,
  undoFeedback,
  type PreferenceSignal,
} from "./feedback.ts";
import {
  dataset,
  fact as makeFact,
  item as makeItem,
  line,
  relation as makeRelation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import { saveInsight } from "./insights.ts";
import { insertItem, saveFact, saveRelation, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { readRow } from "./semantic-lifecycle.ts";
import { userDecisions } from "./semantic-user.ts";
import { writeSetting } from "./settings.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
const NEUTRAL: PreferenceSignal = { weight: 0, source: null, hidden: false, muted: false };
const attrs = (status: "candidate" | "verified"): KnowledgeAttributes => ({
  epistemic: "explicit",
  status,
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
});

let db: SqlDriver;
let x: number;
let y: number;
let z: number;
let fact: number;
let candidateFact: number;
let relation: number;
let insight: number;
let sibling: number;

beforeEach(() => {
  db = freshDb();
  x = insertItem(db, { type: "project", name: "A", ...attrs("verified") });
  y = insertItem(db, { type: "system", name: "B", ...attrs("verified") });
  z = insertItem(db, { type: "system", name: "C", ...attrs("verified") });
  fact = saveFact(db, { itemId: x, kind: "k", value: "v1", ...attrs("verified") }).id;
  candidateFact = saveFact(db, { itemId: x, kind: "k", value: "v2", ...attrs("candidate") }).id;
  relation = saveRelation(db, { subjectId: x, type: "T", objectId: y, ...attrs("verified") }).id;
  const save = (rule: string, a: number, b: number, changedAt: string) =>
    saveInsight(
      db,
      { rule, xItemId: a, yItemId: b },
      {
        state: "active",
        summary: `${rule} ${a}-${b}`,
        evidenceIds: [],
        changedAt,
      },
    );
  insight = save("dependency_delay", x, y, "2026-11-22T00:00:00.000Z");
  sibling = save("dependency_delay", z, y, "2026-11-22T00:00:00.000Z");
});
afterEach(() => db.close());

const at = (n: number) => `2026-11-23T00:00:${String(n).padStart(2, "0")}.000Z`;
const record = (target: FeedbackTarget, kind: FeedbackKind, time = at(1)) =>
  db.transaction(() => recordFeedback(db, userDecisions, { target, kind }, time));
const undo = (id: number, time = at(30)) =>
  db.transaction(() => undoFeedback(db, userDecisions, id, time));
const signal = (target: FeedbackTarget, options = {}) =>
  preferenceSignals(db, [target], options)[0];
const live = () => db.all("SELECT id FROM feedback WHERE undone_at IS NULL").length;
const statusOf = (kind: "fact" | "relation" | "item", id: number) =>
  readRow(db, { kind, id })?.status;
const ledgerFact = (metric: number, versionId: number) => {
  const calc = makeFact(
    db,
    metric,
    "metric.calculation",
    '{"aggregation":"sum","column":"a"}',
    "candidate",
  );
  line(db, calc, "schema", versionId);
  line(db, calc, "aggregation", versionId);
  return calc;
};
const applied = (r: ReturnType<typeof record>) => {
  if (r.status !== "applied") throw new Error(`refused: ${r.reason}`);
  return r;
};

describe("feedback.kinds-and-targets (P03-C1a)", () => {
  it("records each of the eight kinds on an allowed target, once per kind and target", () => {
    const target = (kind: FeedbackKind): FeedbackTarget =>
      kind === "wrong_info"
        ? { kind: "fact", id: fact }
        : kind === "wrong_relation"
          ? { kind: "relation", id: relation }
          : { kind: "insight", id: insight };
    for (const kind of FEEDBACK_KINDS) applied(record(target(kind), kind));
    expect(live()).toBe(8);
    const again = applied(record({ kind: "insight", id: insight }, "useful", at(9)));
    expect(again.created).toBe(false);
    expect(live()).toBe(8);
  });

  it("a correction asked again answers the same line and goes through the entry once", () => {
    const first = applied(record({ kind: "fact", id: fact }, "wrong_info"));
    const lines = () => db.all("SELECT seq FROM fact_history WHERE fact_id = ?", [fact]).length;
    const before = lines();
    const second = applied(record({ kind: "fact", id: fact }, "wrong_info", at(9)));
    expect(second).toMatchObject({ created: false, feedback: { id: first.feedback.id } });
    expect(lines()).toBe(before);
  });

  it("refuses a combination the table does not have, and an absent target", () => {
    expect(feedbackClass("useful", "relation")).toBeUndefined();
    expect(record({ kind: "relation", id: relation }, "useful")).toEqual({
      status: "refused",
      reason: "bad-request",
    });
    expect(record({ kind: "insight", id: insight }, "wrong_info")).toMatchObject({
      reason: "bad-request",
    });
    expect(record({ kind: "insight", id: 9999 }, "useful")).toEqual({
      status: "refused",
      reason: "not-found",
    });
    expect(live()).toBe(0);
  });
});

describe("feedback.undo (P03-C1b)", () => {
  it("a preference undo restores the signal to what it was before the record", () => {
    const target: FeedbackTarget = { kind: "insight", id: insight };
    expect(signal(target)).toEqual(NEUTRAL);
    const { feedback } = applied(record(target, "important"));
    expect(signal(target).weight).toBe(100);
    expect(undo(feedback.id)).toMatchObject({ status: "applied" });
    expect(signal(target)).toEqual(NEUTRAL);
    // the line stays in the table, only its effect is gone
    expect(db.all("SELECT undone_at FROM feedback")).toEqual([{ undone_at: at(30) }]);
    expect(undo(feedback.id)).toEqual({ status: "refused", reason: "nothing-to-undo" });
  });

  it("a correction undo takes back its own change", () => {
    const { feedback } = applied(record({ kind: "fact", id: fact }, "wrong_info"));
    expect(statusOf("fact", fact)).toBe("disputed");
    expect(undo(feedback.id)).toMatchObject({ status: "applied" });
    expect(statusOf("fact", fact)).toBe("verified");
  });

  it("refuses with not-latest when another user action came after, and changes nothing", () => {
    const { feedback } = applied(record({ kind: "fact", id: fact }, "wrong_info"));
    db.transaction(() => userDecisions.decide(db, { kind: "fact", id: fact }, "approve", at(5)));
    expect(statusOf("fact", fact)).toBe("verified");
    expect(undo(feedback.id)).toEqual({ status: "refused", reason: "not-latest" });
    expect(statusOf("fact", fact)).toBe("verified");
    expect(db.all("SELECT undone_at FROM feedback")).toEqual([{ undone_at: null }]);
  });
});

describe("feedback.correction (P03-C2a)", () => {
  const snapshot = () =>
    [
      "items",
      "facts",
      "relations",
      "item_history",
      "fact_history",
      "relation_history",
      "insights",
    ].map((t) => db.all(`SELECT * FROM ${t} ORDER BY 1`));

  it("irrelevant leaves every knowledge row and Insight as it was", () => {
    const before = snapshot();
    applied(record({ kind: "insight", id: insight }, "irrelevant"));
    applied(record({ kind: "item", id: x }, "irrelevant"));
    expect(snapshot()).toEqual(before);
  });

  it("wrong_info disputes a verified fact with one history line and gives no preference", () => {
    const lines = () => db.all("SELECT seq FROM fact_history WHERE fact_id = ?", [fact]).length;
    const before = lines();
    const done = applied(record({ kind: "fact", id: fact }, "wrong_info"));
    expect(statusOf("fact", fact)).toBe("disputed");
    expect(lines()).toBe(before + 1);
    expect(done.touched).toEqual({ kind: "fact", id: fact });
    expect(signal({ kind: "item", id: x })).toEqual(NEUTRAL);
  });

  it("wrong_info rejects a candidate and confirmed approves one", () => {
    applied(record({ kind: "fact", id: candidateFact }, "wrong_info"));
    expect(statusOf("fact", candidateFact)).toBe("rejected");
    applied(record({ kind: "fact", id: candidateFact }, "confirmed"));
    expect(statusOf("fact", candidateFact)).toBe("verified");
  });

  it("an approval the entry refuses writes no feedback line and answers the reason", () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const table = storeVersion(db, "t1");
    const metric = makeItem(db, "Metric", "m");
    makeRelation(db, metric, "MEASURED_ON", dataset(db, "d", table.sourceId));
    const calc = ledgerFact(metric, table.versionId);
    storeVersion(db, "t1"); // a newer table version the check lines did not read
    expect(record({ kind: "fact", id: calc }, "confirmed")).toMatchObject({
      status: "refused",
      reason: "data-check-unmet",
    });
    expect(live()).toBe(0);
    expect(statusOf("fact", calc)).toBe("candidate");
  });

  it("a correction on an already disputed row writes the feedback line and no history", () => {
    db.transaction(() => userDecisions.decide(db, { kind: "fact", id: fact }, "dispute", at(2)));
    const lines = () => db.all("SELECT seq FROM fact_history WHERE fact_id = ?", [fact]).length;
    const before = lines();
    const done = applied(record({ kind: "fact", id: fact }, "wrong_info", at(3)));
    expect(lines()).toBe(before);
    expect(done.touched).toBeNull();
    expect(db.all("SELECT applied_seq FROM feedback")).toEqual([{ applied_seq: null }]);
  });
});

describe("feedback.signal (P03-C2b)", () => {
  const insightTarget = (id = insight): FeedbackTarget => ({ kind: "insight", id });

  it("hides an irrelevant Insight and its undo brings it back", () => {
    const { feedback } = applied(record(insightTarget(), "irrelevant"));
    expect(signal(insightTarget())).toEqual({
      weight: -100,
      source: "direct",
      hidden: true,
      muted: true,
    });
    undo(feedback.id);
    expect(signal(insightTarget())).toEqual(NEUTRAL);
  });

  it("already_known hides only until the Insight's content changes", () => {
    applied(record(insightTarget(), "already_known", "2026-11-21T12:00:00.000Z"));
    expect(signal(insightTarget()).hidden).toBe(false);
    applied(record(insightTarget(sibling), "already_known", "2026-11-23T00:00:00.000Z"));
    expect(signal(insightTarget(sibling)).hidden).toBe(true);
    saveInsight(
      db,
      { rule: "dependency_delay", xItemId: z, yItemId: y },
      {
        state: "active",
        summary: "changed",
        evidenceIds: [],
        changedAt: "2026-11-24T00:00:00.000Z",
      },
    );
    expect(signal(insightTarget(sibling)).hidden).toBe(false);
  });

  it("a mute on an item mutes the Insights of its X-Y bundle and only that", () => {
    applied(record({ kind: "item", id: y }, "mute"));
    expect(signal(insightTarget())).toEqual({ ...NEUTRAL, muted: true });
    expect(signal(insightTarget(sibling)).muted).toBe(true);
    const lone = insertItem(db, { type: "system", name: "D", ...attrs("verified") });
    const other = saveInsight(
      db,
      { rule: "conflict", xItemId: lone, yItemId: lone },
      {
        state: "active",
        summary: "s",
        evidenceIds: [],
      },
    );
    expect(signal(insightTarget(other)).muted).toBe(false);
  });

  it("an item's weight reaches its Insight when the Insight has none of its own", () => {
    applied(record({ kind: "item", id: x }, "useful"));
    applied(record({ kind: "item", id: y }, "irrelevant"));
    // the largest absolute value wins; an item's irrelevant lowers the weight and hides nothing
    expect(signal(insightTarget())).toEqual({
      weight: -100,
      source: "item",
      hidden: false,
      muted: false,
    });
    applied(record(insightTarget(), "useful", at(5)));
    expect(signal(insightTarget())).toMatchObject({ weight: 50, source: "direct" });
  });

  it("the newest like-or-dislike line wins, and cancelling it brings the earlier one back", () => {
    applied(record(insightTarget(), "important", at(1)));
    const newest = applied(record(insightTarget(), "irrelevant", at(2)));
    expect(signal(insightTarget()).weight).toBe(-100);
    undo(newest.feedback.id);
    expect(signal(insightTarget()).weight).toBe(100);
  });

  it("the type step stays silent unless feedback.learned is on, then reads sibling lines", () => {
    applied(record(insightTarget(sibling), "useful", at(1)));
    expect(feedbackLearned(db)).toBe(false);
    expect(signal(insightTarget())).toEqual(NEUTRAL);
    writeSetting(db, "feedback.learned", "on");
    expect(feedbackLearned(db)).toBe(true);
    // round(100 * (1 - 0) / (1 + 0 + 3)) = 25
    expect(signal(insightTarget())).toMatchObject({ weight: 25, source: "type" });
    writeSetting(db, "feedback.learned", "yes");
    expect(signal(insightTarget())).toEqual(NEUTRAL);
  });

  it("a target the caller refuses contributes no line to any step", () => {
    applied(record(insightTarget(), "irrelevant"));
    applied(record({ kind: "item", id: x }, "useful"));
    const usable = (t: FeedbackTarget) => !(t.kind === "insight" && t.id === insight);
    expect(signal(insightTarget(), { usable })).toMatchObject({
      weight: 50,
      source: "item",
      hidden: false,
    });
    const noItems = (t: FeedbackTarget) => t.kind !== "item" && usable(t);
    expect(signal(insightTarget(), { usable: noItems })).toEqual(NEUTRAL);
  });

  it("lists the live lines newest first, only the usable ones, up to the limit", () => {
    applied(record(insightTarget(), "useful", at(1)));
    const gone = applied(record({ kind: "item", id: x }, "useful", at(2)));
    applied(record({ kind: "item", id: y }, "mute", at(3)));
    undo(gone.feedback.id);
    expect(listFeedback(db, 10).map((f) => f.kind)).toEqual(["mute", "useful"]);
    expect(listFeedback(db, 1)).toHaveLength(1);
    expect(listFeedback(db, 10, (t) => t.kind !== "item")).toHaveLength(1);
  });
});
