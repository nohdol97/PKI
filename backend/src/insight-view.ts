// The Insight as the API shows it (P01-R13, R14, R16): the stored row's signals become a ranking at the
// request's time, the reason text is the interpretation's when there is one (D12), and the list is ordered
// by score. The gate has already judged what may be shown; nothing here reads the store.
import {
  INSIGHT_TYPE_NAMES,
  INSIGHT_TYPES,
  type InsightSummary,
  type InsightTypeName,
  type RouteResponse,
} from "@pki/contracts";
import { isAutoNotifyExcluded, rankInsight } from "@pki/knowledge-engine";
import type { ActiveInsight } from "@pki/storage";

/** One gated row as the API shows it; the ranking is computed at `now`. Built field by field: the row's item ids stay inside. */
export function insightView(row: ActiveInsight, now: Date): InsightSummary {
  const reasoningSummary = row.llmReasoningSummary ?? row.reasoningSummary;
  return {
    id: row.id,
    epistemic: row.epistemic,
    summary: row.summary,
    evidenceCount: row.evidenceCount,
    type: row.type as InsightTypeName,
    factLines: row.factLines,
    reasoningSummary,
    reasoningBy:
      row.llmReasoningSummary !== null ? "llm" : reasoningSummary !== null ? "code" : null,
    confidence: row.confidence,
    ranking: rankInsight(
      {
        type: row.type,
        confidence: row.confidence,
        urgencyDate: row.urgencyDate,
        changedAt: row.changedAt,
        userInputCount: row.userInputCount,
        impact: row.llmImpact,
        actionability: row.llmActionability,
      },
      now,
    ),
    autoNotifyExcluded: isAutoNotifyExcluded(row.confidence),
  };
}

/** Whether the stored rule is one of the 13 types; a row with any other value is not shown (it would fail the response). */
export const knownInsightType = (row: Pick<ActiveInsight, "type">): boolean =>
  (INSIGHT_TYPE_NAMES as readonly string[]).includes(row.type);

/** Views by score, then the later change first (none last), then the lower id (P01-D28). */
export function rankedInsightViews(rows: readonly ActiveInsight[], now: Date): InsightSummary[] {
  const changed = (row: ActiveInsight) =>
    row.changedAt === null ? -Infinity : Date.parse(row.changedAt);
  return rows
    .filter(knownInsightType)
    .map((row) => ({ row, view: insightView(row, now) }))
    .sort(
      (a, b) =>
        b.view.ranking.score - a.view.ranking.score ||
        changed(b.row) - changed(a.row) ||
        a.row.id - b.row.id,
    )
    .map((r) => r.view);
}

/** The 13 types as `GET /api/insights/types` answers them: the table's name, label, judge and support, not its ranking defaults. */
export function insightTypeList(): RouteResponse<"insightTypes"> {
  return {
    types: INSIGHT_TYPES.map(({ type, label, judgedBy, status, reason }) => ({
      type,
      label,
      judgedBy,
      status,
      reason,
    })),
  };
}
