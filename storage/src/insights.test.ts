// V02-R3/R10 Insight storage: one row per duplicate key (rule, X, Y), kept when it is
// resolved so it can come back as the same row, and deleted with its X or Y item.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  findRelation,
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
  db = openBetterSqlite3(":memory:");
  migrate(db);
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
    });
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

  it("finds a relation by subject, type and object", () => {
    const id = saveRelation(db, {
      subjectId: key.xItemId,
      type: "DEPENDS_ON",
      objectId: key.yItemId,
      ...attrs,
    }).id;
    expect(findRelation(db, key.xItemId, "DEPENDS_ON", key.yItemId)).toEqual({
      id,
      status: "candidate",
    });
    expect(findRelation(db, key.yItemId, "DEPENDS_ON", key.xItemId)).toBeUndefined();
    const related = saveRelation(db, {
      subjectId: key.xItemId,
      type: "RELATED_TO",
      objectId: key.yItemId,
      ...attrs,
    }).id;
    expect(findRelation(db, key.xItemId, "RELATED_TO", key.yItemId)?.id).toBe(related);
    expect(findRelation(db, key.xItemId, "DEPENDS_ON", key.yItemId)?.id).toBe(id);
    expect(findRelation(db, key.xItemId, "OWNS", key.yItemId)).toBeUndefined();
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
