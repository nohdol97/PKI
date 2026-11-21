// Read-only views behind the evidence screens (V02-R14, spec "T10이 넘기는 것" 2):
// Home's active Insights, an active Insight's evidence, and the source version an
// evidence row points to. Nothing here writes. Resolved (and dirty) Insights are
// hidden: not listed, and their evidence list is not read. A source is read by
// evidence id whatever its Insight's state, while the evidence row exists.
import type { KnowledgeStatus } from "./knowledge.ts";
import type { SqlDriver, SqlRow } from "./sql-driver.ts";

export interface ActiveInsight {
  id: number;
  epistemic: "inferred";
  summary: string;
  evidenceCount: number;
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
}

export interface EvidenceSourceView {
  evidenceId: number;
  quote: string;
  /** [start, end) in code points of `sourceVersion.body`. */
  start: number;
  end: number;
  sourceVersion: {
    id: number;
    version: number;
    latestVersion: number;
    title: string;
    body: string;
  };
}

const ACTIVE_INSIGHT = `SELECT i.id, i.epistemic, i.summary,
    (SELECT count(*) FROM insight_evidence ie WHERE ie.insight_id = i.id) AS evidence_count
  FROM insights i WHERE i.state = 'active'`;

const insightOf = (row: SqlRow): ActiveInsight => ({
  id: row.id as number,
  epistemic: row.epistemic as "inferred",
  summary: row.summary as string,
  evidenceCount: row.evidence_count as number,
});

/** Active Insights, oldest first. */
export function listActiveInsights(db: SqlDriver): ActiveInsight[] {
  return db.all(`${ACTIVE_INSIGHT} ORDER BY i.id`).map(insightOf);
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
      `SELECT e.id, e.fact_id, e.quote, e.source_version_id, v.version, v.title,
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
       v.title, v.body,
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
    sourceVersion: {
      id: row.version_id as number,
      version: row.version as number,
      latestVersion: row.latest as number,
      title: row.title as string,
      body: row.body as string,
    },
  };
}
