// Reads for linking (V02-R7): the names extraction compares with a source's text.
// One table; no keyword index, no ranking (V02-R8). The source versions a name came
// from are the registry's lineage of the item (I04-R16), not read here.
import type { SqlDriver } from "./sql-driver.ts";

/** Every item's id and name, by id. Provisional: one name per item (V02 미해결 질문 6). */
export function listItemNames(db: SqlDriver): { id: number; name: string }[] {
  return db
    .all("SELECT id, name FROM items ORDER BY id")
    .map((row) => ({ id: row.id as number, name: row.name as string }));
}
