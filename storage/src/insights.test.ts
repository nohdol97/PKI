// V02-R3/R10 Insight storage: one row per duplicate key (rule, X, Y), kept when it is
// resolved so it can come back as the same row, and deleted with its X or Y item.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  listRelationsBetween,
  listFactsOfKind,
  listInsightKeys,
  listRelationPairs,
  readInsight,
  saveInsight,
  type InsightKey,
} from "./insights.ts";
import {
  addEvidence,
  insertItem,
  saveFact,
  saveRelation,
  type KnowledgeAttributes,
} from "./knowledge.ts";
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

beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "abc" });
  const x = insertItem(db, { type: "project", name: "A", ...attrs });
  const y = insertItem(db, { type: "system", name: "B", ...attrs });
  const factId = saveFact(db, { itemId: x, kind: "k", value: "v", ...attrs }).id;
  evidence = ["a", "b", "c"].map((quote, start) =>
    addEvidence(db, { target: { factId }, sourceVersionId: 1, start, end: start + 1, quote }),
  );
  key = { rule: "dependency-delay", xItemId: x, yItemId: y };
});

afterEach(() => {
  db.close();
});

describe("saveInsight", () => {
  it("stores an active inference with its summary and evidence", () => {
    const id = saveInsight(db, key, { state: "active", summary: "A 위험", evidenceIds: evidence });
    expect(readInsight(db, key)).toEqual({
      id,
      ...key,
      epistemic: "inferred",
      state: "active",
      summary: "A 위험",
      evidenceIds: evidence,
      userInputs: [],
      linkIds: [],
      factLines: [],
      reasoningSummary: null,
      confidence: null,
      urgencyDate: null,
      changedAt: null,
      interpretation: null,
    });
  });

  it("stores the user-input rows an Insight used, replaces them on an update and drops them on resolve (S01-R15)", () => {
    const fact = db.all("SELECT id FROM facts")[0]?.id as number;
    const relation = saveRelation(db, {
      subjectId: key.xItemId,
      type: "DEPENDS_ON",
      objectId: key.yItemId,
      ...attrs,
    }).id;
    const id = saveInsight(db, key, {
      state: "active",
      summary: "s",
      evidenceIds: [],
      userInputs: [
        { kind: "relation", id: relation },
        { kind: "fact", id: fact },
      ],
    });
    expect(readInsight(db, key)?.userInputs).toEqual([
      { kind: "fact", id: fact },
      { kind: "relation", id: relation },
    ]);
    saveInsight(db, key, { state: "active", summary: "s", evidenceIds: [] });
    expect(readInsight(db, key)?.userInputs).toEqual([]);
    saveInsight(db, key, {
      state: "active",
      summary: "s",
      evidenceIds: [],
      userInputs: [{ kind: "fact", id: fact }],
    });
    saveInsight(db, key, { state: "resolved" });
    expect(readInsight(db, key)).toMatchObject({ id, state: "resolved", userInputs: [] });
    expect(db.all("SELECT count(*) AS n FROM insight_user_inputs")).toEqual([{ n: 0 }]);
  });

  it("updates the same row for the same key, replacing its evidence", () => {
    const id = saveInsight(db, key, { state: "active", summary: "s1", evidenceIds: evidence });
    expect(
      saveInsight(db, key, { state: "active", summary: "s2", evidenceIds: evidence.slice(1) }),
    ).toBe(id);
    expect(readInsight(db, key)).toMatchObject({
      id,
      summary: "s2",
      evidenceIds: evidence.slice(1),
    });
    expect(db.all("SELECT count(*) AS n FROM insights")).toEqual([{ n: 1 }]);
  });

  it("resolves to an empty row with no evidence and revives the same row", () => {
    const id = saveInsight(db, key, { state: "active", summary: "s", evidenceIds: evidence });
    expect(saveInsight(db, key, { state: "resolved" })).toBe(id);
    expect(readInsight(db, key)).toEqual({
      id,
      ...key,
      epistemic: "inferred",
      state: "resolved",
      summary: null,
      evidenceIds: [],
      userInputs: [],
      linkIds: [],
      factLines: [],
      reasoningSummary: null,
      confidence: null,
      urgencyDate: null,
      changedAt: null,
      interpretation: null,
    });
    expect(saveInsight(db, key, { state: "active", summary: "s", evidenceIds: evidence })).toBe(id);
    expect(db.all("SELECT count(*) AS n FROM insights")).toEqual([{ n: 1 }]);
  });

  it("lets a resolved row hold no summary and a shown row not lack one", () => {
    expect(() =>
      db.run(
        `INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary)
         VALUES ('r', ?, ?, 'inferred', 'resolved', 'leftover')`,
        [key.xItemId, key.yItemId],
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary)
         VALUES ('r', ?, ?, 'inferred', 'active', NULL)`,
        [key.xItemId, key.yItemId],
      ),
    ).toThrow(/CHECK/);
  });

  it.each(["xItemId", "yItemId"] as const)("is deleted with its %s item", (side) => {
    saveInsight(db, key, { state: "active", summary: "s", evidenceIds: evidence });
    // X holds the fact; its evidence and the fact go first, as V02-R12 deletes them
    db.run("DELETE FROM facts");
    db.run("DELETE FROM items WHERE id = ?", [key[side]]);
    expect(readInsight(db, key)).toBeUndefined();
    expect(db.all("SELECT count(*) AS n FROM insight_evidence")).toEqual([{ n: 0 }]);
  });

  it("loses its evidence and links when the source versions are deleted", () => {
    saveInsight(db, key, { state: "active", summary: "s", evidenceIds: evidence });
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    expect(db.all("SELECT count(*) AS n FROM evidence")).toEqual([{ n: 0 }]);
    expect(readInsight(db, key)?.evidenceIds).toEqual([]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("loses an evidence link when that evidence is deleted", () => {
    saveInsight(db, key, { state: "active", summary: "s", evidenceIds: evidence });
    db.run("DELETE FROM evidence WHERE id = ?", [evidence[0] as number]);
    expect(readInsight(db, key)?.evidenceIds).toEqual(evidence.slice(1));
  });

  it("returns undefined for an absent key", () => {
    expect(readInsight(db, { ...key, rule: "other" })).toBeUndefined();
  });
});

describe("rule reads (V02-R8: depth-1 queries)", () => {
  it("lists an item's facts of one kind with their status", () => {
    const other = saveFact(db, { itemId: key.xItemId, kind: "k", value: "w", ...attrs }).id;
    saveFact(db, { itemId: key.xItemId, kind: "other", value: "v", ...attrs });
    expect(listFactsOfKind(db, key.xItemId, "k")).toEqual([
      { id: 1, value: "v", status: "candidate" },
      { id: other, value: "w", status: "candidate" },
    ]);
    expect(listFactsOfKind(db, key.yItemId, "k")).toEqual([]);
  });

  it("lists the relations of one type from any of the subjects to any of the objects, by id", () => {
    const z = insertItem(db, { type: "system", name: "C", ...attrs });
    const first = saveRelation(db, {
      subjectId: key.xItemId,
      type: "DEPENDS_ON",
      objectId: key.yItemId,
      ...attrs,
    }).id;
    const second = saveRelation(db, {
      subjectId: z,
      type: "DEPENDS_ON",
      objectId: key.yItemId,
      ...attrs,
    }).id;
    saveRelation(db, {
      subjectId: key.xItemId,
      type: "RELATED_TO",
      objectId: key.yItemId,
      ...attrs,
    });
    expect(listRelationsBetween(db, "DEPENDS_ON", [key.xItemId], [key.yItemId])).toEqual([
      { id: first, status: "candidate" },
    ]);
    expect(
      listRelationsBetween(db, "DEPENDS_ON", [z, key.xItemId], [key.yItemId]).map((r) => r.id),
    ).toEqual([first, second]);
    expect(listRelationsBetween(db, "DEPENDS_ON", [key.yItemId], [key.xItemId])).toEqual([]);
    expect(listRelationsBetween(db, "OWNS", [key.xItemId], [key.yItemId])).toEqual([]);
    expect(listRelationsBetween(db, "DEPENDS_ON", [], [key.yItemId])).toEqual([]);
  });

  it("lists the pairs an item takes part in, through relations or Insight rows", () => {
    const z = insertItem(db, { type: "system", name: "C", ...attrs });
    saveRelation(db, { subjectId: key.xItemId, type: "DEPENDS_ON", objectId: z, ...attrs });
    saveRelation(db, { subjectId: z, type: "RELATED_TO", objectId: key.yItemId, ...attrs });
    saveInsight(db, key, { state: "resolved" });
    expect(listRelationPairs(db, "DEPENDS_ON", [z])).toEqual([
      { xItemId: key.xItemId, yItemId: z },
    ]);
    expect(listRelationPairs(db, "DEPENDS_ON", [key.yItemId])).toEqual([]);
    expect(listRelationPairs(db, "DEPENDS_ON", [])).toEqual([]);
    expect(listInsightKeys(db, key.rule, [key.yItemId])).toEqual([key]);
    expect(listInsightKeys(db, "other", [key.yItemId])).toEqual([]);
    expect(listInsightKeys(db, key.rule, [])).toEqual([]);
  });
});

describe("the P01 columns (P01-R2, R3, R5)", () => {
  const rich = {
    state: "active" as const,
    summary: "s",
    evidenceIds: [] as number[],
    factLines: ["목표일 2026-12-05", "완료일 2026-12-10"],
    reasoningSummary: "두 날짜를 코드가 비교했습니다.",
    confidence: 80,
    urgencyDate: "2026-12-05",
    changedAt: "2026-11-23T00:00:00.000Z",
  };

  it("round-trips the five fields and keeps changed_at when an update omits it", () => {
    saveInsight(db, key, { ...rich, evidenceIds: evidence });
    expect(readInsight(db, key)).toMatchObject({
      factLines: rich.factLines,
      reasoningSummary: rich.reasoningSummary,
      confidence: 80,
      urgencyDate: "2026-12-05",
      changedAt: rich.changedAt,
    });
    const { changedAt, ...withoutChange } = rich;
    saveInsight(db, key, { ...withoutChange, evidenceIds: evidence, confidence: 30 });
    expect(readInsight(db, key)).toMatchObject({ confidence: 30, changedAt });
  });

  it("empties all five on resolve: the text columns hold source-derived values", () => {
    saveInsight(db, key, { ...rich, evidenceIds: evidence });
    saveInsight(db, key, { state: "resolved" });
    expect(readInsight(db, key)).toMatchObject({
      state: "resolved",
      summary: null,
      factLines: [],
      reasoningSummary: null,
      confidence: null,
      urgencyDate: null,
      changedAt: null,
      interpretation: null,
    });
  });

  it("refuses a reasoning summary of more than 500 characters", () => {
    expect(() =>
      saveInsight(db, key, { ...rich, evidenceIds: evidence, reasoningSummary: "가".repeat(501) }),
    ).toThrow();
    saveInsight(db, key, { ...rich, evidenceIds: evidence, reasoningSummary: "가".repeat(500) });
    expect(readInsight(db, key)?.reasoningSummary).toHaveLength(500);
  });
});
