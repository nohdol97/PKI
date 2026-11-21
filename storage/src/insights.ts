// Insight storage (V02-R3, R10). One row per duplicate key; resolving empties the
// summary and evidence links but keeps the row, so the same row comes back when
// the condition holds again. Deleting X or Y deletes the row (foreign key cascade).
// A rule's Insight is an inference (V02-R9), the only epistemic type written here.
import type { KnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface InsightKey {
  rule: string;
  xItemId: number;
  yItemId: number;
}

export type InsightContent =
  | { state: "active" | "dirty"; summary: string; evidenceIds: readonly number[] }
  | { state: "resolved" };

export interface StoredInsight extends InsightKey {
  id: number;
  epistemic: "inferred";
  state: InsightContent["state"];
  summary: string | null;
  evidenceIds: number[];
}

const KEY = "rule = ? AND x_item_id = ? AND y_item_id = ?";
const keyValues = (k: InsightKey) => [k.rule, k.xItemId, k.yItemId];

/** Creates or updates the key's row and replaces its evidence links; returns its id. */
export function saveInsight(db: SqlDriver, key: InsightKey, content: InsightContent): number {
  const summary = content.state === "resolved" ? null : content.summary;
  db.run(
    `INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary)
     VALUES (?, ?, ?, 'inferred', ?, ?)
     ON CONFLICT (rule, x_item_id, y_item_id) DO UPDATE SET state = excluded.state, summary = excluded.summary`,
    [...keyValues(key), content.state, summary],
  );
  const id = db.all(`SELECT id FROM insights WHERE ${KEY}`, keyValues(key))[0]?.id as number;
  db.run("DELETE FROM insight_evidence WHERE insight_id = ?", [id]);
  for (const evidenceId of content.state === "resolved" ? [] : content.evidenceIds) {
    db.run("INSERT INTO insight_evidence (insight_id, evidence_id) VALUES (?, ?)", [
      id,
      evidenceId,
    ]);
  }
  return id;
}

export function readInsight(db: SqlDriver, key: InsightKey): StoredInsight | undefined {
  const row = db.all(
    `SELECT id, epistemic, state, summary FROM insights WHERE ${KEY}`,
    keyValues(key),
  )[0];
  if (!row) return undefined;
  const id = row.id as number;
  return {
    id,
    ...key,
    epistemic: row.epistemic as "inferred",
    state: row.state as StoredInsight["state"],
    summary: row.summary as string | null,
    evidenceIds: db
      .all("SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id", [
        id,
      ])
      .map((r) => r.evidence_id as number),
  };
}

// The fixed reads a rule makes (V02-R8): single tables or depth-1 joins, never a
// recursive query or a graph walk. Which rows are valid, and any comparison of
// values, is the rule's code, not SQL (V02-R9).

const inList = (ids: readonly number[]) => ids.map(() => "?").join(", ");

/** An item's facts of one kind, oldest first. */
export function listFactsOfKind(
  db: SqlDriver,
  itemId: number,
  kind: string,
): { id: number; value: string; status: KnowledgeStatus }[] {
  return db
    .all("SELECT id, value, status FROM facts WHERE item_id = ? AND kind = ? ORDER BY id", [
      itemId,
      kind,
    ])
    .map((row) => ({
      id: row.id as number,
      value: row.value as string,
      status: row.status as KnowledgeStatus,
    }));
}

/** The relation (subject, type, object), if stored. */
export function findRelation(
  db: SqlDriver,
  subjectId: number,
  type: string,
  objectId: number,
): { id: number; status: KnowledgeStatus } | undefined {
  const row = db.all(
    "SELECT id, status FROM relations WHERE subject_id = ? AND type = ? AND object_id = ?",
    [subjectId, type, objectId],
  )[0];
  return row && { id: row.id as number, status: row.status as KnowledgeStatus };
}

/** (subject, object) of each relation of `type` that has one of `itemIds` at either end. */
export function listRelationPairs(
  db: SqlDriver,
  type: string,
  itemIds: readonly number[],
): { xItemId: number; yItemId: number }[] {
  if (itemIds.length === 0) return [];
  return db
    .all(
      `SELECT subject_id, object_id FROM relations
       WHERE type = ? AND (subject_id IN (${inList(itemIds)}) OR object_id IN (${inList(itemIds)}))
       ORDER BY id`,
      [type, ...itemIds, ...itemIds],
    )
    .map((row) => ({ xItemId: row.subject_id as number, yItemId: row.object_id as number }));
}

/** Keys of the rule's Insight rows, in any state, with one of `itemIds` as X or Y. */
export function listInsightKeys(
  db: SqlDriver,
  rule: string,
  itemIds: readonly number[],
): InsightKey[] {
  if (itemIds.length === 0) return [];
  return db
    .all(
      `SELECT x_item_id, y_item_id FROM insights
       WHERE rule = ? AND (x_item_id IN (${inList(itemIds)}) OR y_item_id IN (${inList(itemIds)}))
       ORDER BY id`,
      [rule, ...itemIds, ...itemIds],
    )
    .map((row) => ({
      rule,
      xItemId: row.x_item_id as number,
      yItemId: row.y_item_id as number,
    }));
}
