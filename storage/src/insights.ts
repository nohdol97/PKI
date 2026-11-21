// Insight storage (V02-R3, R10). One row per duplicate key; resolving empties the
// summary and evidence links but keeps the row, so the same row comes back when
// the condition holds again. Deleting X or Y deletes the row (foreign key cascade).
// A rule's Insight is an inference (V02-R9), the only epistemic type written here.
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
