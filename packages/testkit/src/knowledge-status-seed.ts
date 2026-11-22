// Test seed (S01-T01): puts an item, fact or relation in a status without the transition table. The
// schema (migration v20) lets a status change through only behind a history line, so this writes a
// line that says the change and then updates the row, as the lifecycle gate does; the product
// reaches a status only through that gate (storage `automatedLifecycle`, S01 user actions). Use it
// where a test needs a row in a state the gate would take several steps to reach. A row later
// restored by evidence is restored only if `actor` is `propagation` (S01-R5): the default `user`
// reads as an action the user took.
import type { ContractSqlDriver } from "./sql-driver.contract.ts";

const TABLES = {
  item: ["items", "item_history", "item_id"],
  fact: ["facts", "fact_history", "fact_id"],
  relation: ["relations", "relation_history", "relation_id"],
} as const;

export function setStatusForTest(
  db: Pick<ContractSqlDriver, "run" | "all">,
  kind: keyof typeof TABLES,
  id: number,
  status: "candidate" | "verified" | "disputed" | "superseded" | "rejected",
  actor: "user" | "extraction" | "propagation" | "policy" = "user",
): void {
  const [table, history, fk] = TABLES[kind];
  const row = db.all(`SELECT status, epistemic FROM ${table} WHERE id = ?`, [id])[0];
  if (!row) throw new Error(`${kind} ${id} not found`);
  db.run(
    `INSERT INTO ${history} (${fk}, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
     VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM ${history} WHERE ${fk} = ?),
       '2026-11-22T00:00:00.000Z', ?, 'test-set', ?, ?, ?, ?)`,
    [id, id, actor, row.status as string, status, row.epistemic as string, row.epistemic as string],
  );
  db.run(`UPDATE ${table} SET status = ? WHERE id = ?`, [status, id]);
}
