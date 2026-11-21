// Reads for linking (V02-R7): the names extraction compares with a source's text,
// and the source versions an item's name came from, which the Broker grades with
// the call (a candidate's name is text from those sources). Each is one table or
// a depth-1 join; no keyword index, no ranking (V02-R8).
import type { SqlDriver } from "./sql-driver.ts";

/** Every item's id and name, by id. Provisional: one name per item (V02 미해결 질문 6). */
export function listItemNames(db: SqlDriver): { id: number; name: string }[] {
  return db
    .all("SELECT id, name FROM items ORDER BY id")
    .map((row) => ({ id: row.id as number, name: row.name as string }));
}

/** The versions holding evidence of the item's facts and of relations it is subject or object of. */
export function listItemEvidenceVersions(db: SqlDriver, itemId: number): number[] {
  return db
    .all(
      `SELECT e.source_version_id AS id FROM evidence e JOIN facts f ON f.id = e.fact_id
        WHERE f.item_id = ?
       UNION
       SELECT e.source_version_id FROM evidence e JOIN relations r ON r.id = e.relation_id
        WHERE r.subject_id = ? OR r.object_id = ?
       ORDER BY id`,
      [itemId, itemId, itemId],
    )
    .map((row) => row.id as number);
}
