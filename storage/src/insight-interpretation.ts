// The LLM interpretation of an Insight (P01-R7, D12-D15). It lives in three columns of its own, beside the
// code-written ones, and is stored only by `writeInsightInterpretation`: while the Insight is active and still
// has the content (the basis) the job was asked at. Every `saveInsight` empties it. A job's target is
// `<insight id>#<basis>`: ids and a hash, the mark of the attempt, as the Wiki summary's is (K01-D13).
import { createHash } from "node:crypto";
import { readInsight, type InsightInterpretation, type StoredInsight } from "./insights.ts";
import { INSIGHT_INTERPRET_KIND } from "./job-kinds.ts";
import { registerJob } from "./jobs.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

export { INSIGHT_INTERPRET_KIND } from "./job-kinds.ts";

/** The user's switch for the interpretation (P01-R7); anything but `on` is OFF (root 13-5, D15). */
export const INSIGHT_INTERPRET_SETTING = "insight.interpret";
/** Provisional (D15): interpretation jobs one request queues. */
export const INSIGHT_INTERPRET_BATCH = 50;
/** The rule of the Insight the interpretation itself proposes (D18): such a row is never interpreted. */
export const OPPORTUNITY_RULE = "opportunity";

export const readInsightInterpret = (db: SqlDriver): boolean =>
  readSetting(db, INSIGHT_INTERPRET_SETTING) === "on";

/** An Insight by id, whatever its state. */
export function readInsightById(db: SqlDriver, id: number): StoredInsight | undefined {
  const row = db.all("SELECT rule, x_item_id, y_item_id FROM insights WHERE id = ?", [id])[0];
  return row
    ? readInsight(db, {
        rule: row.rule as string,
        xItemId: row.x_item_id as number,
        yItemId: row.y_item_id as number,
      })
    : undefined;
}

/** SHA-256 of what the Insight holds that a code write can change (not `changed_at`); the interpretation's basis. */
export function insightBasis(insight: StoredInsight): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        insight.rule,
        insight.summary,
        insight.factLines,
        insight.reasoningSummary,
        insight.confidence,
        insight.urgencyDate,
        insight.evidenceIds,
        insight.userInputs,
        insight.linkIds,
      ]),
    )
    .digest("hex");
}

/**
 * Stores the interpretation, only while the Insight is active and its basis still equals `basis` (the one the
 * job was asked at); otherwise the row is untouched and this returns false. Runs in the caller's transaction.
 */
export function writeInsightInterpretation(
  tx: SqlDriver,
  insightId: number,
  basis: string,
  interpretation: InsightInterpretation,
): boolean {
  const current = readInsightById(tx, insightId);
  if (!current || current.state !== "active" || insightBasis(current) !== basis) return false;
  return (
    tx.run(
      `UPDATE insights SET llm_reasoning_summary = ?, llm_impact = ?, llm_actionability = ?
       WHERE id = ? AND state = 'active'`,
      [
        interpretation.reasoningSummary,
        interpretation.impact,
        interpretation.actionability,
        insightId,
      ],
    ).changes === 1
  );
}

/**
 * Queues one `insight-interpret` job per active Insight a rule judged (not an `opportunity`), at most
 * INSIGHT_INTERPRET_BATCH, and returns how many. An Insight is left out when it has an open job already or was
 * tried at this basis (any status). Nothing is queued while the setting is off.
 */
export function requestInsightInterpretations(db: SqlDriver, at: Date = new Date()): number {
  if (!readInsightInterpret(db)) return 0;
  return db.transaction(() => {
    const open = db.all(
      `SELECT id, rule, x_item_id, y_item_id FROM insights
        WHERE state = 'active' AND rule <> ? AND llm_reasoning_summary IS NULL
          AND NOT EXISTS (SELECT 1 FROM jobs j
                           WHERE j.kind = ? AND j.status IN ('queued', 'running', 'retry', 'held')
                             AND substr(j.target, 1, length(insights.id) + 1) = insights.id || '#')
        ORDER BY id`,
      [OPPORTUNITY_RULE, INSIGHT_INTERPRET_KIND],
    );
    let queued = 0;
    for (const row of open) {
      if (queued >= INSIGHT_INTERPRET_BATCH) break;
      const insight = readInsightById(db, row.id as number);
      if (!insight) continue;
      const registered = registerJob(db, {
        kind: INSIGHT_INTERPRET_KIND,
        target: `${insight.id}#${insightBasis(insight)}`,
        priority: "maintenance",
        at,
      });
      if (registered.registered) queued++;
    }
    return queued;
  });
}

/** Stores the switch. From OFF to ON it queues the jobs in the same transaction; ON to ON and OFF queue nothing. */
export function setInsightInterpret(db: SqlDriver, on: boolean, at: Date): number {
  return db.transaction(() => {
    const was = readInsightInterpret(db);
    writeSetting(db, INSIGHT_INTERPRET_SETTING, on ? "on" : "off");
    return on && !was ? requestInsightInterpretations(db, at) : 0;
  });
}
