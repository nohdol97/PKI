// Tombstones (V02-R3, R12, ADR 0013 decision 4): a deleted or access-revoked
// source's identifier, the version reached, the time and the reason. No content.
// Writing one raises the change sequence (trigger); an equal or lower version
// leaves the stored tombstone and the sequence as they are.
import type { SqlDriver } from "./sql-driver.ts";

/**
 * Who deleted (schema v9, agreed with the I01 and I04 specs): the screen's request
 * (`user-deleted`, never lets the source back until an explicit lift, which V02
 * has none of), the Connector reporting the source gone (`source-deleted`) or
 * its access lost (`access-revoked`).
 */
export type TombstoneReason = "user-deleted" | "source-deleted" | "access-revoked";

export interface Tombstone {
  sourceId: number;
  version: number;
  at: string;
  reason: TombstoneReason;
}

export function writeTombstone(db: SqlDriver, t: Tombstone): "written" | "unchanged" {
  const { changes } = db.run(
    `INSERT INTO tombstones (source_id, version, at, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET version = excluded.version, at = excluded.at,
       reason = excluded.reason
     WHERE excluded.version > tombstones.version`,
    [t.sourceId, t.version, t.at, t.reason],
  );
  return changes === 1 ? "written" : "unchanged";
}

export function readTombstone(db: SqlDriver, sourceId: number): Tombstone | undefined {
  const row = db.all("SELECT version, at, reason FROM tombstones WHERE source_id = ?", [
    sourceId,
  ])[0];
  if (!row) return undefined;
  return {
    sourceId,
    version: row.version as number,
    at: row.at as string,
    reason: row.reason as Tombstone["reason"],
  };
}
