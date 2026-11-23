// Reads for linking (V02-R7): the names extraction compares with a source's text, and the
// `verified` surface forms of items (S01-R16). Plain reads; no keyword index, no ranking (V02-R8).
// The source versions a name came from are the registry's lineage of the item (I04-R16), not read here.
import type { SqlDriver } from "./sql-driver.ts";

/** Every item's id and name, by id. Provisional: one name per item (V02 미해결 질문 6). */
export function listItemNames(db: SqlDriver): { id: number; name: string }[] {
  return db
    .all("SELECT id, name FROM items ORDER BY id")
    .map((row) => ({ id: row.id as number, name: row.name as string }));
}

/**
 * The surface forms (`alias.*` facts) in status `verified`, by item then fact id (S01-R16): the
 * only forms linking reads. A `candidate`, `disputed`, `rejected` or `superseded` form is not one,
 * whoever wrote it. The text is as stored; the caller compares it as it compares names.
 */
export function listVerifiedForms(
  db: SqlDriver,
): { factId: number; itemId: number; form: string }[] {
  return db
    .all(
      "SELECT id, item_id, value FROM facts WHERE substr(kind, 1, 6) = 'alias.' AND status = 'verified' ORDER BY item_id, id",
    )
    .map((row) => ({
      factId: row.id as number,
      itemId: row.item_id as number,
      form: row.value as string,
    }));
}
