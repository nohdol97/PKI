// The split record (S02-R15, schema v24 `item_split_moves`): one line per fact or relation a split moved,
// numbers only (the original item, the new item, the row). Two readers use it.
//
// 1. `listSplitMoves` is THE READ CONTRACT for later specs (S03-T05 reads it to find the rows a split took
//    off a table's source; it reads the record only and never the table directly). The answer is a list of
//    `{ id, fromItemId, toItemId, fact | relation }`, filtered by any of the original item, the new item
//    and the moved row, ascending by id. The rows go with their items and rows (foreign keys cascade).
// 2. `followMovedRow` is extraction's one hook (S02-R15, provisional decision 19): a fact or relation the
//    extraction has just written on an item whose group once had a row split away, under the same key, from
//    a source that already backs the moved row, is not made again; the moved row takes the evidence. Only
//    the key is followed: a changed value, or another source saying the same, is not (the known limits).
import { componentOf, type ItemId } from "./entity-groups.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface SplitMove {
  id: number;
  fromItemId: ItemId;
  toItemId: ItemId;
  /** Exactly one of the two is set. */
  factId: number | null;
  relationId: number | null;
}

export interface SplitMoveFilter {
  fromItemId?: ItemId;
  toItemId?: ItemId;
  factId?: number;
  relationId?: number;
}

/** The moves that match every given field; all moves for an empty filter. */
export function listSplitMoves(db: SqlDriver, filter: SplitMoveFilter = {}): SplitMove[] {
  const where: string[] = [];
  const params: number[] = [];
  for (const [column, value] of [
    ["from_item_id", filter.fromItemId],
    ["to_item_id", filter.toItemId],
    ["fact_id", filter.factId],
    ["relation_id", filter.relationId],
  ] as const) {
    if (value === undefined) continue;
    where.push(`${column} = ?`);
    params.push(value);
  }
  return db
    .all(
      `SELECT id, from_item_id, to_item_id, fact_id, relation_id FROM item_split_moves
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
      params,
    )
    .map((r) => ({
      id: r.id as number,
      fromItemId: r.from_item_id as ItemId,
      toItemId: r.to_item_id as ItemId,
      factId: r.fact_id as number | null,
      relationId: r.relation_id as number | null,
    }));
}

/** Whether some evidence of the row sits on a version of the source. */
const backedBy = (db: SqlDriver, column: "fact_id" | "relation_id", row: number, source: number) =>
  db.all(
    `SELECT 1 FROM evidence e JOIN source_versions v ON v.id = e.source_version_id
     WHERE e.${column} = ? AND v.source_id = ? LIMIT 1`,
    [row, source],
  ).length > 0;

/**
 * Called right after extraction saved a row and before anything else is written for it (no history line,
 * no evidence yet). When the row was just created and a moved row has the same key and is backed by this
 * source, the new row is deleted and the moved row is answered instead (`created: false`).
 */
export function followMovedRow(
  tx: SqlDriver,
  saved: { target: { factId: number } | { relationId: number }; created: boolean },
  sourceId: number,
): { target: { factId: number } | { relationId: number }; created: boolean } {
  if (!saved.created) return saved;
  if ("factId" in saved.target) {
    const fresh = tx.all("SELECT item_id, kind, value FROM facts WHERE id = ?", [
      saved.target.factId,
    ])[0];
    if (!fresh) return saved;
    const group = new Set(componentOf(tx, fresh.item_id as number));
    const moved = listSplitMoves(tx).filter((m) => m.factId !== null && group.has(m.fromItemId));
    for (const m of moved) {
      const row = tx.all("SELECT item_id FROM facts WHERE id = ? AND kind = ? AND value = ?", [
        m.factId as number,
        fresh.kind as string,
        fresh.value as string,
      ])[0];
      if (!row || !backedBy(tx, "fact_id", m.factId as number, sourceId)) continue;
      tx.run("DELETE FROM facts WHERE id = ?", [saved.target.factId]);
      return { target: { factId: m.factId as number }, created: false };
    }
    return saved;
  }
  const fresh = tx.all("SELECT subject_id, type, object_id FROM relations WHERE id = ?", [
    saved.target.relationId,
  ])[0];
  if (!fresh) return saved;
  const subject = fresh.subject_id as number;
  const object = fresh.object_id as number;
  for (const m of listSplitMoves(tx).filter((x) => x.relationId !== null)) {
    const group = new Set(componentOf(tx, m.fromItemId));
    // an end that was on the original item is on the new item in the moved row
    const same = (fresh_: number, moved: number) =>
      fresh_ === moved || (group.has(fresh_) && moved === m.toItemId);
    const row = tx.all("SELECT subject_id, object_id FROM relations WHERE id = ? AND type = ?", [
      m.relationId as number,
      fresh.type as string,
    ])[0];
    if (
      !row ||
      !same(subject, row.subject_id as number) ||
      !same(object, row.object_id as number)
    ) {
      continue;
    }
    if (!backedBy(tx, "relation_id", m.relationId as number, sourceId)) continue;
    tx.run("DELETE FROM relations WHERE id = ?", [saved.target.relationId]);
    return { target: { relationId: m.relationId as number }, created: false };
  }
  return saved;
}
