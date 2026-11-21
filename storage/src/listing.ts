// Reads behind the screens (V01-R3). A source is shown by its latest version, so
// an edited source appears once, under its current title, in lists and searches.
// Rows are cast to the contract types; the API checks every response against them.
import { providerEgress, type ProviderCall, type SourceSummary } from "@pki/contracts";
import { matchExpression } from "./keyword-search.ts";
import type { SqlDriver } from "./sql-driver.ts";

const COLUMNS =
  "v.id, s.connector_instance_id AS connectorId, s.external_id AS externalId, v.title";
const IS_LATEST = "v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)";

export function listSources(db: SqlDriver, limit = 100): SourceSummary[] {
  return db.all(
    `SELECT ${COLUMNS} FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE ${IS_LATEST} ORDER BY v.id DESC LIMIT ?`,
    [limit],
  ) as unknown as SourceSummary[];
}

/**
 * Keyword search (best match first) over the sources' latest versions. The latest-version
 * filter runs inside the query, before LIMIT, so old versions cannot use up the limit.
 */
export function findSources(db: SqlDriver, query: string, limit = 50): SourceSummary[] {
  const match = matchExpression(query);
  if (match === undefined) return [];
  return db.all(
    `SELECT ${COLUMNS} FROM keyword_index k
       JOIN source_versions v ON v.id = k.rowid JOIN sources s ON s.id = v.source_id
     WHERE keyword_index MATCH ? AND ${IS_LATEST} ORDER BY k.rank LIMIT ?`,
    [match, limit],
  ) as unknown as SourceSummary[];
}

/** Provider call attempts, newest first, each labelled external or local (ADR 0014). */
export function listProviderCalls(db: SqlDriver, limit = 100): ProviderCall[] {
  const rows = db.all(
    `SELECT request_id AS requestId, attempt, provider, destination, task_kind AS taskKind,
       classification, policy_version AS policyVersion, outcome, reason,
       duration_ms AS durationMs, created_at AS createdAt
     FROM provider_calls ORDER BY id DESC LIMIT ?`,
    [limit],
  ) as unknown as Omit<ProviderCall, "egress">[];
  return rows.map(({ requestId, attempt, provider, ...rest }) => ({
    requestId,
    attempt,
    provider,
    egress: providerEgress(provider),
    ...rest,
  }));
}

export interface ProviderCallRow {
  requestId: string;
  attempt: number;
  provider: string;
  destination: string | null;
  taskKind: string;
  classification: string;
  policyVersion: string | null;
  outcome: string;
  reason: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** Appends one attempt to history; the columns hold no body, prompt, response or secret. */
export function insertProviderCall(db: SqlDriver, row: ProviderCallRow): void {
  db.run(
    `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
       classification, policy_version, outcome, reason, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.requestId,
      row.attempt,
      row.provider,
      row.destination,
      row.taskKind,
      row.classification,
      row.policyVersion,
      row.outcome,
      row.reason,
      row.durationMs,
      row.createdAt,
    ],
  );
}
