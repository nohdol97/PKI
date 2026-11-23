// P01-R6, R9, R10 (C2a, C3c, C3d): the rule runner. Run with the dependency-delay rule: the runner is
// what that rule moved onto. All data is synthetic.
import {
  addEvidence,
  insertItem,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type KnowledgeAttributes,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { setStatusForTest } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  dependencyDelayRule,
} from "./dependency-delay.ts";
import { isAutoNotifyExcluded, runInsightRules, type InsightRule } from "./insight-rules.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const T1 = "2026-11-23T00:00:00.000Z";
const T2 = "2026-11-24T00:00:00.000Z";

let db: SqlDriver;
let x: number;
let y: number;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  x = insertItem(db, { type: "Project", name: "미리내 프로젝트", ...attrs });
  y = insertItem(db, { type: "System", name: "물결 API", ...attrs });
});
afterEach(() => db.close());

let n = 0;
function quote(target: { factId: number } | { relationId: number }, body: string) {
  saveSourceRecord(db, "c1", { externalId: `s${++n}`, title: "t", body });
  const sourceVersionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  addEvidence(db, { target, sourceVersionId, start: 0, end: body.length, quote: body });
}
function fact(itemId: number, kind: string, value: string, confidence?: number) {
  const id = saveFact(db, {
    itemId,
    kind,
    value,
    ...attrs,
    ...(confidence === undefined ? {} : { confidence }),
  }).id;
  quote({ factId: id }, `${kind} ${value}`);
  return id;
}
function scenario(confidence?: number) {
  const target = fact(x, TARGET_DATE, "2026-12-05", confidence);
  const id = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
  quote({ relationId: id }, "depends");
  const completion = fact(y, COMPLETION_DATE, "2026-12-10");
  return { target, completion };
}
const key = () => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const run = (at = T1) => runInsightRules(db, [x], [dependencyDelayRule], { at });

describe("runInsightRules — an active Insight (P01-R2, C2a)", () => {
  it("holds fact lines, a reasoning summary, an integer confidence and evidence, all from code", () => {
    scenario();
    expect(run()).toEqual([{ key: key(), outcome: "created" }]);
    const insight = readInsight(db, key());
    expect(insight?.factLines.length).toBeGreaterThanOrEqual(1);
    expect(insight?.reasoningSummary).toBeTruthy();
    expect(Number.isInteger(insight?.confidence)).toBe(true);
    expect(insight?.evidenceIds.length).toBeGreaterThanOrEqual(1);
    expect(insight).toMatchObject({ urgencyDate: "2026-12-05", changedAt: T1 });
  });

  it("makes no Insight for a rule whose type the table does not support (P01-R1)", () => {
    scenario();
    const unsupported: InsightRule = { ...dependencyDelayRule, type: "similar_resolution" };
    expect(runInsightRules(db, [x], [unsupported], { at: T1 })).toEqual([]);
    expect(db.all("SELECT count(*) AS n FROM insights")).toEqual([{ n: 0 }]);
  });
});

describe("runInsightRules — life of a row (P01-R9, C3c)", () => {
  it("updates the same row on a changed row, resolves a broken condition and revives the same id", () => {
    const { completion } = scenario();
    run();
    const id = readInsight(db, key())?.id;
    expect(run()).toEqual([{ key: key(), outcome: "unchanged" }]);

    fact(y, COMPLETION_DATE, "2026-12-20");
    expect(run(T2)).toEqual([{ key: key(), outcome: "updated" }]);
    expect(readInsight(db, key())).toMatchObject({ id, changedAt: T2 });

    for (const f of db.all("SELECT id FROM facts WHERE kind = 'completion_date'")) {
      setStatusForTest(db, "fact", f.id as number, "rejected");
    }
    expect(run(T2)).toEqual([{ key: key(), outcome: "resolved" }]);
    expect(readInsight(db, key())).toMatchObject({
      id,
      state: "resolved",
      summary: null,
      factLines: [],
      reasoningSummary: null,
      confidence: null,
      urgencyDate: null,
      evidenceIds: [],
    });

    setStatusForTest(db, "fact", completion, "candidate");
    expect(run(T2)).toEqual([{ key: key(), outcome: "revived" }]);
    expect(readInsight(db, key())).toMatchObject({ id, state: "active" });
  });

  it("resolves a pair the scope will not put together", () => {
    scenario();
    run();
    runInsightRules(db, [x], [dependencyDelayRule], { scope: { combinable: () => false } });
    expect(readInsight(db, key())?.state).toBe("resolved");
  });
});

describe("runInsightRules — confidence (P01-R10, C3d)", () => {
  it("is the lowest of the rows used, excluded from auto-notification under 50, and lifts when the row is approved", () => {
    const { target } = scenario(0.3);
    run();
    expect(readInsight(db, key())?.confidence).toBe(30);
    expect(isAutoNotifyExcluded(30)).toBe(true);

    setStatusForTest(db, "fact", target, "verified");
    expect(run(T2)).toEqual([{ key: key(), outcome: "updated" }]);
    const after = readInsight(db, key());
    expect(isAutoNotifyExcluded(after?.confidence ?? null)).toBe(false);
    // only the confidence differs: the text is the same, so changed_at stays
    expect(after?.changedAt).toBe(T1);
    expect(isAutoNotifyExcluded(null)).toBe(false);
  });
});
