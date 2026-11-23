// Reads behind the screens (V01-R3). A source is shown by its latest version, so
// an edited source appears once, under its current title, in lists and searches.
// Rows are cast to the contract types; the API checks every response against them.
import { providerEgress, type ProviderCall, type SourceSummary } from "@pki/contracts";
import { matchExpression } from "./keyword-search.ts";
import type { SqlDriver } from "./sql-driver.ts";

const COLUMNS =
  "v.id, s.connector_instance_id AS connectorId, s.namespace, s.external_id AS externalId, v.title";
const IS_LATEST = "v.id = (SELECT max(id) FROM source_versions WHERE source_id = v.source_id)";

/** The newest `limit` sources; with `before`, only those whose latest version id is below it (X02B-R4). */
export function listSources(db: SqlDriver, limit = 100, before?: number): SourceSummary[] {
  return db.all(
    `SELECT ${COLUMNS} FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE ${IS_LATEST} ${before === undefined ? "" : "AND v.id < ?"} ORDER BY v.id DESC LIMIT ?`,
    [...(before === undefined ? [] : [before]), limit],
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

const CALL_COLUMNS = `id, request_id AS requestId, attempt, provider, destination, task_kind AS taskKind,
       classification, policy_version AS policyVersion, outcome, reason,
       duration_ms AS durationMs, created_at AS createdAt`;

const callOf = (r: Record<string, unknown>): ProviderCall => ({
  requestId: r.requestId as string,
  attempt: r.attempt as number,
  provider: r.provider as string,
  egress: providerEgress(r.provider as string),
  destination: r.destination as string | null,
  taskKind: r.taskKind as string,
  classification: r.classification as string,
  policyVersion: r.policyVersion as string | null,
  outcome: r.outcome as string,
  reason: r.reason as string | null,
  durationMs: r.durationMs as number | null,
  createdAt: r.createdAt as string,
});

/** Provider call attempts, newest first, each labelled external or local (ADR 0014). */
export function listProviderCalls(db: SqlDriver, limit = 100): ProviderCall[] {
  return db
    .all(`SELECT ${CALL_COLUMNS} FROM provider_calls ORDER BY id DESC LIMIT ?`, [limit])
    .map(callOf);
}

/** One page of the attempts, newest first; `next` is the row number to pass as `before`, null at the end (X02B-R4). */
export function listProviderCallPage(
  db: SqlDriver,
  options: { before?: number | undefined; limit: number },
): { calls: ProviderCall[]; next: number | null } {
  const rows = db.all(
    `SELECT ${CALL_COLUMNS} FROM provider_calls ${options.before === undefined ? "" : "WHERE id < ?"}
     ORDER BY id DESC LIMIT ?`,
    [...(options.before === undefined ? [] : [options.before]), options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  return {
    calls: page.map(callOf),
    next: rows.length > options.limit ? ((page.at(-1)?.id as number | undefined) ?? null) : null,
  };
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

/**
 * Appends one attempt to history and returns its row ID; the columns hold no body,
 * prompt, response or secret. An attempt about to reach a Provider is written with
 * outcome "started" and fixed by `finishProviderCall` (I03-R14).
 */
export function insertProviderCall(db: SqlDriver, row: ProviderCallRow): number {
  return db.run(
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
  ).lastInsertRowid;
}

/** Sets the result of a started attempt; a row that is no longer "started" is left as it is. */
export function finishProviderCall(
  db: SqlDriver,
  id: number,
  result: { outcome: string; durationMs: number },
): void {
  db.run(
    "UPDATE provider_calls SET outcome = ?, duration_ms = ? WHERE id = ? AND outcome = 'started'",
    [result.outcome, result.durationMs, id],
  );
}

/**
 * Turns every "started" attempt into "interrupted" and returns how many: at a
 * Broker's start, an attempt still started belongs to a process that died. It
 * stays an attempt, so it still counts against the budget (I03-R14).
 */
export function interruptStartedCalls(db: SqlDriver): number {
  return db.run("UPDATE provider_calls SET outcome = 'interrupted' WHERE outcome = 'started'")
    .changes;
}

/**
 * When the attempts after `afterMs` (UTC milliseconds, exclusive) were made,
 * oldest first: every row that reached the Provider ("started" and "interrupted"
 * included), not the "blocked" and "budget-exhausted" ones that never ran. Rows
 * dated in the future (a clock that went back) are included as stored.
 */
export function listAttemptTimes(db: SqlDriver, afterMs: number): number[] {
  const rows = db.all(
    `SELECT created_at AS at FROM provider_calls
     WHERE outcome NOT IN ('blocked', 'budget-exhausted') AND created_at > ?`,
    [new Date(afterMs).toISOString()],
  );
  return rows.map((r) => Date.parse(r.at as string)).sort((a, b) => a - b);
}
