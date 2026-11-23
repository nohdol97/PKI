// The plain reads behind the Explore screen (X02-R1..R3). They judge nothing about visibility: the read gate's
// caller (backend/src/explore-read.ts) asks the registry before any of it leaves the backend.
import type { Attachment, NativeLocator } from "@pki/contracts";
import { attachmentAt, locatorAt } from "./evidence-view.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface ExploreItemRow {
  id: number;
  type: string;
  name: string;
  /** Whether the name holds the query (always true without one). */
  nameMatch: boolean;
  /**
   * Without a name match, the item's own alias facts that hold the query (not rejected or superseded), by id. Each is
   * judged by the read gate: an alias fact the caller may not see does not make the item a result (X02B-R1, R6 2).
   */
  aliases: { id: number; value: string }[];
}

/** `%`, `_` and the escape itself in `text` read as themselves in a LIKE pattern. */
const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

const NAME_LIKE = "name LIKE ? ESCAPE '\\'";
/** An alias fact still standing (S01-R2: kind `alias.*`) that holds the pattern. */
const ALIAS_LIKE = `substr(f.kind, 1, 6) = 'alias.' AND f.status NOT IN ('rejected', 'superseded')
  AND f.value LIKE ? ESCAPE '\\'`;

/**
 * Up to `limit` items after id `after`, ascending, that lead their group (no active member of another) and, with a
 * `query`, whose name or whose own alias fact holds it. SQLite's LIKE ignores case for ASCII only (X02-D6, X02B-D3).
 */
export function listExploreItems(
  db: SqlDriver,
  options: { after: number; query?: string | undefined; limit: number },
): ExploreItemRow[] {
  const pattern = options.query ? likeOf(options.query) : undefined;
  const sql = (nameMatch: string, found: string) =>
    `SELECT id, type, name, ${nameMatch} AS name_match FROM items
     WHERE id > ? ${found}
       AND NOT EXISTS (SELECT 1 FROM item_merges m WHERE m.member_id = items.id AND m.active = 1)
     ORDER BY id LIMIT ?`;
  const rows = pattern
    ? db.all(
        sql(
          NAME_LIKE,
          `AND (${NAME_LIKE} OR EXISTS (SELECT 1 FROM facts f WHERE f.item_id = items.id AND ${ALIAS_LIKE}))`,
        ),
        [pattern, options.after, pattern, pattern, options.limit],
      )
    : db.all(sql("1", ""), [options.after, options.limit]);
  return rows.map((r) => {
    const nameMatch = r.name_match === 1;
    return {
      id: r.id as number,
      type: r.type as string,
      name: r.name as string,
      nameMatch,
      aliases:
        nameMatch || !pattern
          ? []
          : db
              .all(
                `SELECT f.id, f.value FROM facts f WHERE f.item_id = ? AND ${ALIAS_LIKE} ORDER BY f.id`,
                [r.id as number, pattern],
              )
              .map((f) => ({ id: f.id as number, value: f.value as string })),
    };
  });
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

/**
 * The version by its row id with the source's latest version number, the same calculation as an evidence read; with
 * `start` also the locator and attachment of the block holding that code point (X02B-R5), else both null.
 */
export function readSourceVersionView(
  db: SqlDriver,
  versionId: number,
  start?: number,
):
  | {
      sourceVersion: SourceVersionView;
      locator: NativeLocator | null;
      attachment: Attachment | null;
    }
  | undefined {
  const row = db.all(
    `SELECT v.id, v.version, v.title, v.body, v.blocks, v.meta,
       (SELECT max(version) FROM source_versions WHERE source_id = v.source_id) AS latest
     FROM source_versions v WHERE v.id = ?`,
    [versionId],
  )[0];
  return row
    ? {
        sourceVersion: {
          id: row.id as number,
          version: row.version as number,
          latestVersion: row.latest as number,
          title: row.title as string,
          body: row.body as string,
        },
        locator: start === undefined ? null : locatorAt(row.blocks, start),
        attachment: start === undefined ? null : attachmentAt(row.blocks, row.meta, start),
      }
    : undefined;
}
