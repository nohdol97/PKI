// Reads behind the screens (V01-R3). A source is shown by its latest version, so
// an edited source appears once, under its current title, in lists and searches.
// Rows are cast to the contract types; the API checks every response against them.
import type { ProviderCall, SourceSummary } from "@pki/contracts";
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

/** Provider call attempts, newest first. */
export function listProviderCalls(db: SqlDriver, limit = 100): ProviderCall[] {
  return db.all(
    `SELECT request_id AS requestId, attempt, provider, destination, task_kind AS taskKind,
       classification, policy_version AS policyVersion, outcome, duration_ms AS durationMs,
       created_at AS createdAt
     FROM provider_calls ORDER BY id DESC LIMIT ?`,
    [limit],
  ) as unknown as ProviderCall[];
}
