// The plain reads behind the Explore screen (X02-R1..R3). They judge nothing about visibility: the read gate's
// caller (backend/src/explore-read.ts) asks the registry before any of it leaves the backend.
import type { SqlDriver } from "./sql-driver.ts";

export interface ExploreItemRow {
  id: number;
  type: string;
  name: string;
}

/** `%`, `_` and the escape itself in `text` read as themselves in a LIKE pattern. */
const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

/**
 * Up to `limit` items after id `after`, ascending, that lead their group (no active member of another) and, with a
 * `query`, whose name holds it. SQLite's LIKE ignores case for ASCII only (X02-D6: part-of-name match, nothing more).
 */
export function listExploreItems(
  db: SqlDriver,
  options: { after: number; query?: string | undefined; limit: number },
): ExploreItemRow[] {
  const named = options.query ? "AND name LIKE ? ESCAPE '\\'" : "";
  return db
    .all(
      `SELECT id, type, name FROM items
       WHERE id > ? ${named}
         AND NOT EXISTS (SELECT 1 FROM item_merges m WHERE m.member_id = items.id AND m.active = 1)
       ORDER BY id LIMIT ?`,
      [options.after, ...(options.query ? [likeOf(options.query)] : []), options.limit],
    )
    .map((r) => ({ id: r.id as number, type: r.type as string, name: r.name as string }));
}

export interface ValidInterval {
  validAt: string | null;
  validUntil: string | null;
}

/** The valid interval of each fact or relation id that is stored (S02-R17). */
export function readValidIntervals(
  db: SqlDriver,
  table: "facts" | "relations",
  ids: readonly number[],
): Map<number, ValidInterval> {
  return new Map(
    db
      .all(
        `SELECT id, valid_at, valid_until FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`,
        [JSON.stringify(ids)],
      )
      .map((r) => [
        r.id as number,
        { validAt: r.valid_at as string | null, validUntil: r.valid_until as string | null },
      ]),
  );
}

export interface SourceVersionView {
  id: number;
  version: number;
  latestVersion: number;
  title: string;
  body: string;
}

/** The version by its row id with the source's latest version number, the same calculation as an evidence read. */
export function readSourceVersionView(
  db: SqlDriver,
  versionId: number,
): SourceVersionView | undefined {
  const row = db.all(
    `SELECT v.id, v.version, v.title, v.body,
       (SELECT max(version) FROM source_versions WHERE source_id = v.source_id) AS latest
     FROM source_versions v WHERE v.id = ?`,
    [versionId],
  )[0];
  return row
    ? {
        id: row.id as number,
        version: row.version as number,
        latestVersion: row.latest as number,
        title: row.title as string,
        body: row.body as string,
      }
    : undefined;
}
