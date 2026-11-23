// Read-only views behind the evidence screens (V02-R14, spec "T10이 넘기는 것" 2):
// Home's active Insights, an active Insight's evidence, and the source version an
// evidence row points to. Nothing here writes. Resolved (and dirty) Insights are
// hidden: not listed, and their evidence list is not read. A source is read by
// evidence id whatever its Insight's state, while the evidence row exists.
import type { Block, NativeLocator } from "@pki/contracts";
import type { KnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export interface ActiveInsight {
  id: number;
  epistemic: "inferred";
  summary: string;
  evidenceCount: number;
  /** `insights.rule` (P01-R13) */
  type: string;
  xItemId: number;
  yItemId: number;
  /** `fact_lines`; a legacy row (NULL) gives [] */
  factLines: string[];
  /** the code's reason */
  reasoningSummary: string | null;
  /** the interpretation's reason, impact and actionability (P01-D12), null without one */
  llmReasoningSummary: string | null;
  llmImpact: number | null;
  llmActionability: number | null;
  confidence: number | null;
  urgencyDate: string | null;
  changedAt: string | null;
  userInputCount: number;
}

export interface InsightEvidenceRow {
  id: number;
  target: "fact" | "relation";
  status: KnowledgeStatus;
  quote: string;
  sourceTitle: string;
  sourceVersionId: number;
  version: number;
  current: boolean;
  /** I01-R29: the locator of the block of that version holding the span's start, else null. */
  locator: NativeLocator | null;
}

/**
 * A fact or relation an Insight used that the user wrote or approved with no current evidence (S01-R15):
 * shown as "사용자 입력" in place of a source span. An id, a target and a status; no text.
 */
export interface InsightUserInputRow {
  target: "fact" | "relation";
  id: number;
  status: KnowledgeStatus;
}

export interface EvidenceSourceView {
  evidenceId: number;
  quote: string;
  /** [start, end) in code points of `sourceVersion.body`. */
  start: number;
  end: number;
  /** I01-R29: computed on read from the blocks of `sourceVersion`, never stored on the evidence. */
  locator: NativeLocator | null;
  sourceVersion: {
    id: number;
    version: number;
    latestVersion: number;
    title: string;
    body: string;
  };
}

/** The locator of the block holding code point `start`; null for no blocks or a gap (I01-R29). */
function locatorAt(blocksJson: unknown, start: number): NativeLocator | null {
  if (typeof blocksJson !== "string") return null;
  const blocks = JSON.parse(blocksJson) as Block[];
  return blocks.find((b) => b.start <= start && start < b.end)?.locator ?? null;
}

const ACTIVE_INSIGHT = `SELECT i.id, i.epistemic, i.summary, i.rule, i.x_item_id, i.y_item_id, i.fact_lines,
    i.reasoning_summary, i.llm_reasoning_summary, i.llm_impact, i.llm_actionability, i.confidence,
    i.urgency_date, i.changed_at,
    (SELECT count(*) FROM insight_user_inputs u WHERE u.insight_id = i.id) AS user_input_count,
    (SELECT count(*) FROM insight_evidence ie WHERE ie.insight_id = i.id)
      + (SELECT count(*) FROM insight_user_inputs u WHERE u.insight_id = i.id) AS evidence_count
  FROM insights i WHERE i.state = 'active'`;

const insightOf = (row: SqlRow): ActiveInsight => ({
  id: row.id as number,
  epistemic: row.epistemic as "inferred",
  summary: row.summary as string,
  evidenceCount: row.evidence_count as number,
  type: row.rule as string,
  xItemId: row.x_item_id as number,
  yItemId: row.y_item_id as number,
  factLines: row.fact_lines === null ? [] : (JSON.parse(row.fact_lines as string) as string[]),
  reasoningSummary: row.reasoning_summary as string | null,
  llmReasoningSummary: row.llm_reasoning_summary as string | null,
  llmImpact: row.llm_impact as number | null,
  llmActionability: row.llm_actionability as number | null,
  confidence: row.confidence as number | null,
  urgencyDate: row.urgency_date as string | null,
  changedAt: row.changed_at as string | null,
  userInputCount: row.user_input_count as number,
});

/** Active Insights, oldest first. */
export function listActiveInsights(db: SqlDriver): ActiveInsight[] {
  return db.all(`${ACTIVE_INSIGHT} ORDER BY i.id`).map(insightOf);
}

/** The ids of the evidence an Insight cites, in evidence order (the read gate judges them one by one). */
export function listInsightEvidenceIds(db: SqlDriver, insightId: number): number[] {
  return db
    .all("SELECT evidence_id FROM insight_evidence WHERE insight_id = ? ORDER BY evidence_id", [
      insightId,
    ])
    .map((r) => r.evidence_id as number);
}

/** The user-input rows an Insight used, facts before relations (the read gate judges them one by one). */
export function listInsightUserInputs(db: SqlDriver, insightId: number): InsightUserInputRow[] {
  return db
    .all(
      `SELECT u.fact_id, u.relation_id, coalesce(f.status, r.status) AS status
       FROM insight_user_inputs u
       LEFT JOIN facts f ON f.id = u.fact_id
       LEFT JOIN relations r ON r.id = u.relation_id
       WHERE u.insight_id = ? ORDER BY u.fact_id IS NULL, u.fact_id, u.relation_id`,
      [insightId],
    )
    .map((u) => ({
      target: u.fact_id === null ? ("relation" as const) : ("fact" as const),
      id: (u.fact_id ?? u.relation_id) as number,
      status: u.status as KnowledgeStatus,
    }));
}

/** An active Insight and its evidence in evidence order; undefined if absent or not active. */
export function readInsightEvidence(
  db: SqlDriver,
  insightId: number,
): { insight: ActiveInsight; evidence: InsightEvidenceRow[] } | undefined {
  const row = db.all(`${ACTIVE_INSIGHT} AND i.id = ?`, [insightId])[0];
  if (!row) return undefined;
  const evidence = db
    .all(
      `SELECT e.id, e.fact_id, e.quote, e.source_version_id, e.start_offset, v.version, v.title, v.blocks,
         coalesce(f.status, r.status) AS status,
         v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id) AS current
       FROM insight_evidence ie
       JOIN evidence e ON e.id = ie.evidence_id
       JOIN source_versions v ON v.id = e.source_version_id
       LEFT JOIN facts f ON f.id = e.fact_id
       LEFT JOIN relations r ON r.id = e.relation_id
       WHERE ie.insight_id = ? ORDER BY e.id`,
      [insightId],
    )
    .map((e) => ({
      id: e.id as number,
      target: e.fact_id === null ? ("relation" as const) : ("fact" as const),
      status: e.status as KnowledgeStatus,
      quote: e.quote as string,
      sourceTitle: e.title as string,
      sourceVersionId: e.source_version_id as number,
      version: e.version as number,
      current: e.current === 1,
      locator: locatorAt(e.blocks, e.start_offset as number),
    }));
  return { insight: insightOf(row), evidence };
}

/** The version evidence `evidenceId` points to (by its version id), with the span; undefined if absent. */
export function readEvidenceSource(
  db: SqlDriver,
  evidenceId: number,
): EvidenceSourceView | undefined {
  const row = db.all(
    `SELECT e.id, e.quote, e.start_offset, e.end_offset, v.id AS version_id, v.version,
       v.title, v.body, v.blocks,
       (SELECT max(version) FROM source_versions WHERE source_id = v.source_id) AS latest
     FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
     WHERE e.id = ?`,
    [evidenceId],
  )[0];
  if (!row) return undefined;
  return {
    evidenceId: row.id as number,
    quote: row.quote as string,
    start: row.start_offset as number,
    end: row.end_offset as number,
    locator: locatorAt(row.blocks, row.start_offset as number),
    sourceVersion: {
      id: row.version_id as number,
      version: row.version as number,
      latestVersion: row.latest as number,
      title: row.title as string,
      body: row.body as string,
    },
  };
}
