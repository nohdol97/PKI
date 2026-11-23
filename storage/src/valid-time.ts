// Valid time vs observed time (S02-R17): the interval `[valid_at, valid_until)` of a fact or relation. An
// extraction fills it only into a row whose two ends are empty and whose interval the user never fixed.
// The user's own fix is `EntityDecisions.setValidity` (entity-decisions.ts), which writes a `set-validity`
// history line; that line is state-neutral, so it never makes a row "user-decided" (S01 gate).
import type { EntryRef } from "./semantic-lifecycle.ts";
import { linesOf } from "./semantic-lifecycle.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** Whether the user fixed this row's interval (a `set-validity` line exists). */
export const validitySetByUser = (tx: SqlDriver, ref: EntryRef): boolean =>
  linesOf(tx, ref).some((l) => l.action === "set-validity");

/**
 * Writes the interval into a row whose two ends are both empty and whose interval the user never set;
 * returns whether it did. `observed_at` is never read or written here.
 */
export function fillValidity(
  tx: SqlDriver,
  ref: { kind: "fact" | "relation"; id: number },
  from: string | null,
  until: string | null,
): boolean {
  if (from === null && until === null) return false;
  if (validitySetByUser(tx, ref)) return false;
  const table = ref.kind === "fact" ? "facts" : "relations";
  return (
    tx.run(
      `UPDATE ${table} SET valid_at = ?, valid_until = ? WHERE id = ? AND valid_at IS NULL AND valid_until IS NULL`,
      [from, until, ref.id],
    ).changes === 1
  );
}
