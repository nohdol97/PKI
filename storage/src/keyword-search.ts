import type { SqlDriver } from "./sql-driver.ts";

/**
 * Returns the ids of source versions whose title or body contain every
 * term of `query`, split on whitespace and control characters (NUL ends an
 * FTS5 string), best match first. Each term is quoted
 * so FTS5 query syntax in user input stays plain text, and matched as a prefix
 * so a Korean word followed by a particle ("예산을") is found by "예산".
 */
export function searchKeyword(db: SqlDriver, query: string, limit = 50, offset = 0): number[] {
  const match = matchExpression(query);
  if (match === undefined) return [];
  return db
    .all(
      "SELECT rowid FROM keyword_index WHERE keyword_index MATCH ? ORDER BY rank LIMIT ? OFFSET ?",
      [match, limit, offset],
    )
    .map((r) => r.rowid as number);
}

/** The FTS5 MATCH string for `query` (see searchKeyword), or undefined when it has no terms. */
export function matchExpression(query: string): string | undefined {
  const terms = query.split(/[\s\p{Cc}]+/u).filter(Boolean);
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
}
