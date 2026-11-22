// The same surface form (S01-R2): two forms of one item and one kind are the same row when the
// V02-R7 processing (Unicode normalization NFKC, one case, collapsed white space, trimmed) makes
// them equal strings. Nothing else merges: no similarity, no translation between languages. One
// implementation for the extraction (knowledge-engine) and the user's add and value fix
// (semantic-user.ts), so the two paths cannot judge a form differently.
import type { SqlDriver } from "./sql-driver.ts";

/** The comparison form of a name, a form or a text (V02-R7). */
export const normalizeForLinking = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** Whether a fact kind is a surface form: `alias.synonym`, `alias.abbreviation`, `alias.translation` (S01-R2). */
export const isSurfaceFormKind = (kind: string): boolean => kind.startsWith("alias.");

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
