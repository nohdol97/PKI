// Reads behind the screens (V01-R3). A source is shown by its latest version, so
// an edited source appears once, under its current title, in lists and searches.
// Rows are cast to the contract types; the API checks every response against them.
import type { ProviderCall, SourceSummary } from "@pki/contracts";
import { searchKeyword } from "./keyword-search.ts";
import type { SqlDriver } from "./sql-driver.ts";

const LATEST_SOURCES = `
  SELECT v.id, s.connector_instance_id AS connectorId, s.external_id AS externalId, v.title
  FROM source_versions v JOIN sources s ON s.id = v.source_id
  WHERE v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)`;

export function listSources(db: SqlDriver, limit = 100): SourceSummary[] {
  return db.all(`${LATEST_SOURCES} ORDER BY v.id DESC LIMIT ?`, [
    limit,
  ]) as unknown as SourceSummary[];
}

/** Keyword search (best match first) over the sources' latest versions. */
export function findSources(db: SqlDriver, query: string, limit = 50): SourceSummary[] {
  const ids = searchKeyword(db, query, limit);
  if (ids.length === 0) return [];
  const rows = db.all(`${LATEST_SOURCES} AND v.id IN (${ids.map(() => "?").join(",")})`, ids);
  const byId = new Map(rows.map((row) => [row.id, row as unknown as SourceSummary]));
  return ids.flatMap((id) => byId.get(id) ?? []);
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
