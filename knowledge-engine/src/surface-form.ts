// The same surface form (S01-R2): two forms of one item and one kind are the same row when the
// V02-R7 processing (Unicode normalization NFKC, one case, collapsed white space) makes them equal
// strings. Nothing else merges: no similarity, no translation between languages.
import type { SqlDriver } from "@pki/storage";
import { normalizeForLinking } from "./linking.ts";

/** The id of the fact of `item` and `kind` whose value is the same form as `form`, the oldest if several. */
export function findSameForm(
  db: SqlDriver,
  item: number,
  kind: string,
  form: string,
): number | undefined {
  const wanted = normalizeForLinking(form);
  for (const row of db.all(
    "SELECT id, value FROM facts WHERE item_id = ? AND kind = ? ORDER BY id",
    [item, kind],
  )) {
    if (normalizeForLinking(row.value as string) === wanted) return row.id as number;
  }
  return undefined;
}
