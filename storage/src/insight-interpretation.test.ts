// P01-C3a (R7, D12-D15): an Insight's interpretation sits in three columns of its own. It is written only
// while the Insight is active and still has the content the job was asked at (the basis), every code write of
// the row empties it, and the queue asks only for an active, code-judged Insight not yet tried at its basis.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  insightBasis,
  readInsightById,
  requestInsightInterpretations,
  setInsightInterpret,
  writeInsightInterpretation,
} from "./insight-interpretation.ts";
import { INSIGHT_INTERPRET_KIND } from "./job-kinds.ts";
import { saveInsight, type InsightKey, type StoredInsight } from "./insights.ts";
import { addEvidence, insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
let key: InsightKey;
let evidence: number[];

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const interpretation = { reasoningSummary: "합성 해석", impact: 70, actionability: 30 };
const active = (summary: string) =>
  ({ state: "active", summary, evidenceIds: evidence, factLines: ["줄"] }) as const;

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "abc" });
  const x = insertItem(db, { type: "project", name: "A", ...attrs });
  const y = insertItem(db, { type: "system", name: "B", ...attrs });
  const factId = saveFact(db, { itemId: x, kind: "k", value: "v", ...attrs }).id;
  evidence = [
    addEvidence(db, { target: { factId }, sourceVersionId: 1, start: 0, end: 1, quote: "a" }),
  ];
  key = { rule: "dependency-delay", xItemId: x, yItemId: y };
});

afterEach(() => {
  db.close();
});

const stored = (id: number) => readInsightById(db, id);
const basisOf = (id: number) => insightBasis(stored(id) as StoredInsight);

describe("writeInsightInterpretation (the guard)", () => {
  it("writes only while the Insight is active and still has the basis the job was asked at", () => {
    const id = saveInsight(db, key, active("A 위험"));
    const basis = basisOf(id);
    expect(writeInsightInterpretation(db, id, basis, interpretation)).toBe(true);
    expect(stored(id)?.interpretation).toEqual(interpretation);

    saveInsight(db, key, active("A 위험 변경"));
    const before = stored(id);
    expect(writeInsightInterpretation(db, id, basis, interpretation)).toBe(false);
    expect(stored(id)).toEqual(before);
  });

  it("refuses a resolved Insight", () => {
    const id = saveInsight(db, key, active("A 위험"));
    const basis = basisOf(id);
    saveInsight(db, key, { state: "resolved" });
    expect(writeInsightInterpretation(db, id, basis, interpretation)).toBe(false);
    expect(stored(id)?.interpretation).toBeNull();
  });
});

describe("saveInsight clears the interpretation (D13)", () => {
  it("empties the three columns on an update and on resolving", () => {
    const id = saveInsight(db, key, active("A 위험"));
    writeInsightInterpretation(db, id, basisOf(id), interpretation);
    saveInsight(db, key, active("A 위험 변경"));
    expect(stored(id)?.interpretation).toBeNull();

    writeInsightInterpretation(db, id, basisOf(id), interpretation);
    saveInsight(db, key, { state: "resolved" });
    expect(
      db.all("SELECT llm_reasoning_summary, llm_impact, llm_actionability FROM insights"),
    ).toEqual([{ llm_reasoning_summary: null, llm_impact: null, llm_actionability: null }]);
  });
});

describe("requestInsightInterpretations (D14, D15)", () => {
  const jobs = () => db.all("SELECT target FROM jobs WHERE kind = ?", [INSIGHT_INTERPRET_KIND]);

  it("queues nothing while the setting is off", () => {
    saveInsight(db, key, active("A 위험"));
    expect(requestInsightInterpretations(db)).toBe(0);
    expect(jobs()).toEqual([]);
  });

  it("queues one job per active code-type Insight and none for one already tried at this basis", () => {
    const id = saveInsight(db, key, active("A 위험"));
    saveInsight(db, { ...key, rule: "opportunity" }, active("기회"));
    expect(setInsightInterpret(db, true, new Date())).toBe(1);
    expect(jobs()).toEqual([{ target: `${id}#${basisOf(id)}` }]);
    expect(requestInsightInterpretations(db)).toBe(0);
  });

  it("does not queue a basis again once a job for it has closed without an interpretation (D14)", () => {
    saveInsight(db, key, active("A 위험"));
    expect(setInsightInterpret(db, true, new Date())).toBe(1);
    db.run("UPDATE jobs SET status = 'succeeded' WHERE kind = ?", [INSIGHT_INTERPRET_KIND]);
    expect(requestInsightInterpretations(db)).toBe(0);
    expect(jobs()).toHaveLength(1);
  });
});
