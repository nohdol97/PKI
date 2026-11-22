// Invalidation records (I04-R4, schema v10): one row per propagation, no content.
// The registry's propagate writes the row when it starts (its id is then known to
// the kinds) and the counts when it ends, in the caller's transaction.
import type { SqlDriver } from "./sql-driver.ts";

export type SourceChangeKind =
  | "new-version"
  | "old-versions-pruned"
  | "scope-changed"
  | "source-deleted"
  | "access-revoked"
  | "user-deleted";

export interface InvalidationRecord {
  id: number;
  changeSeq: number;
  sourceId: number;
  changeKind: SourceChangeKind;
  removedByKind: Record<string, number>;
  recomputedByKind: Record<string, number>;
  at: string;
}

export function startInvalidation(
  db: SqlDriver,
  start: { changeSeq: number; sourceId: number; changeKind: SourceChangeKind; at: string },
): number {
  return db.run(
    "INSERT INTO invalidations (change_seq, source_id, change_kind, at) VALUES (?, ?, ?, ?)",
    [start.changeSeq, start.sourceId, start.changeKind, start.at],
  ).lastInsertRowid;
}

export function finishInvalidation(
  db: SqlDriver,
  id: number,
  counts: { removedByKind: Record<string, number>; recomputedByKind: Record<string, number> },
): void {
  db.run("UPDATE invalidations SET removed_by_kind = ?, recomputed_by_kind = ? WHERE id = ?", [
    JSON.stringify(counts.removedByKind),
    JSON.stringify(counts.recomputedByKind),
    id,
  ]);
}

/** The latest records, newest first. */
export function listInvalidations(db: SqlDriver, limit = 20): InvalidationRecord[] {
  return db
    .all(
      `SELECT id, change_seq, source_id, change_kind, removed_by_kind, recomputed_by_kind, at
       FROM invalidations ORDER BY id DESC LIMIT ?`,
      [limit],
    )
    .map((r) => ({
      id: r.id as number,
      changeSeq: r.change_seq as number,
      sourceId: r.source_id as number,
      changeKind: r.change_kind as SourceChangeKind,
      removedByKind: JSON.parse(r.removed_by_kind as string) as Record<string, number>,
      recomputedByKind: JSON.parse(r.recomputed_by_kind as string) as Record<string, number>,
      at: r.at as string,
    }));
}
