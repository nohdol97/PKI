// Insight storage (V02-R3, R10). One row per duplicate key; resolving empties the
// summary and evidence links but keeps the row, so the same row comes back when
// the condition holds again. Deleting X or Y deletes the row (foreign key cascade).
// A rule's Insight is an inference (V02-R9), the only epistemic type written here.
import type { SourceVersionRef } from "./derivatives.ts";
import type { KnowledgeStatus } from "./knowledge.ts";
import type { EntryRef } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface InsightKey {
  rule: string;
  xItemId: number;
  yItemId: number;
}

/**
 * The facts and relations the Insight used that the user wrote or approved with no current evidence
 * (S01-R15): they have no evidence of their own to cite, so `insight_user_inputs` ties them to it.
 */
export type UserInputRef = EntryRef & { kind: "fact" | "relation" };

export type InsightContent =
  | {
      state: "active" | "dirty";
      summary: string;
      evidenceIds: readonly number[];
      userInputs?: readonly UserInputRef[];
    }
  | { state: "resolved" };

export interface StoredInsight extends InsightKey {
  id: number;
  epistemic: "inferred";
  state: InsightContent["state"];
  summary: string | null;
  evidenceIds: number[];
  userInputs: UserInputRef[];
}

const KEY = "rule = ? AND x_item_id = ? AND y_item_id = ?";
const keyValues = (k: InsightKey) => [k.rule, k.xItemId, k.yItemId];

/** Creates or updates the key's row and replaces its evidence and user-input links; returns its id. */
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
  db.run("DELETE FROM insight_user_inputs WHERE insight_id = ?", [id]);
  for (const input of content.state === "resolved" ? [] : (content.userInputs ?? [])) {
    db.run(
      `INSERT INTO insight_user_inputs (insight_id, ${input.kind === "fact" ? "fact_id" : "relation_id"})
       VALUES (?, ?)`,
      [id, input.id],
    );
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
    userInputs: userInputsOf(db, id),
  };
}

/** The rows an Insight used that the user wrote or approved with no current evidence, facts before relations. */
export function userInputsOf(db: SqlDriver, insightId: number): UserInputRef[] {
  return db
    .all(
      `SELECT fact_id, relation_id FROM insight_user_inputs WHERE insight_id = ?
       ORDER BY relation_id IS NOT NULL, fact_id, relation_id`,
      [insightId],
    )
    .map((r) =>
      r.fact_id === null
        ? { kind: "relation" as const, id: r.relation_id as number }
        : { kind: "fact" as const, id: r.fact_id as number },
    );
}

// The fixed reads a rule makes (V02-R8): single tables or depth-1 joins, never a
// recursive query or a graph walk. Which rows are valid, and any comparison of
// values, is the rule's code, not SQL (V02-R9).

// An id list is bound as one JSON parameter, so its length meets no SQL variable limit.
const IDS = "(SELECT value FROM json_each(?))";

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
       WHERE type = ? AND (subject_id IN ${IDS} OR object_id IN ${IDS})
       ORDER BY id`,
      [type, JSON.stringify(itemIds), JSON.stringify(itemIds)],
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
       WHERE rule = ? AND (x_item_id IN ${IDS} OR y_item_id IN ${IDS})
       ORDER BY id`,
      [rule, JSON.stringify(itemIds), JSON.stringify(itemIds)],
    )
    .map((row) => ({
      rule,
      xItemId: row.x_item_id as number,
      yItemId: row.y_item_id as number,
    }));
}

/** The source versions the evidence rows quote, ascending: the lineage of whatever cites them (I04-R14). */
export function listEvidenceVersions(
  db: SqlDriver,
  evidenceIds: readonly number[],
): SourceVersionRef[] {
  if (evidenceIds.length === 0) return [];
  return db
    .all(
      `SELECT DISTINCT v.source_id, v.version FROM evidence e
         JOIN source_versions v ON v.id = e.source_version_id
       WHERE e.id IN ${IDS} ORDER BY v.source_id, v.version`,
      [JSON.stringify(evidenceIds)],
    )
    .map((row) => ({ sourceId: row.source_id as number, version: row.version as number }));
}
