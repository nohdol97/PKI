// The canonical transaction (I04-R17): every write that may reach a tombstone
// entry opens one, so the entries can queue their ledger lines on it. It is not a
// driver: it passes every call to the driver the composition root built, in that
// driver's one transaction, which takes the write lock as it begins (the entries
// read, judge, then write). A call inside one joins it with the same tx, as a
// savepoint: if it throws and the outer one catches, its rows and its queued
// lines are undone, never half kept.
// I04-T10 adds the ledger: numbering the queued lines and writing them right
// before COMMIT. Until then the lines are dropped with the transaction. Called
// inside a raw driver transaction, this one is itself a savepoint: T10's write
// must wait for the real COMMIT, not this one's release.
import type { CanonicalTransaction, CanonicalTx, LedgerLineDraft } from "./derivatives.ts";
import type { SqlDriver } from "./sql-driver.ts";

interface Open {
  tx: CanonicalTx;
  lines: LedgerLineDraft[];
}

/** The open canonical transaction of a driver, also under its own tx (a nested call passes either). */
const open = new WeakMap<SqlDriver, Open>();

export const canonicalTransaction: CanonicalTransaction = (db, fn) => {
  const outer = open.get(db);
  if (outer) {
    const mark = outer.lines.length;
    try {
      return db.transaction(() => fn(outer.tx));
    } catch (error) {
      outer.lines.length = mark;
      throw error;
    }
  }
  const lines: LedgerLineDraft[] = [];
  const tx: CanonicalTx = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    all: (sql, params) => db.all(sql, params),
    transaction: (inner, options) => db.transaction(inner, options),
    close: () => db.close(),
    queueLedgerLine: (line) => void lines.push(line),
  };
  open.set(db, { tx, lines });
  open.set(tx, { tx, lines });
  try {
    return db.transaction(() => fn(tx), { immediate: true });
  } finally {
    open.delete(db);
    open.delete(tx);
  }
};

/** The lines queued so far in the open transaction of `tx` (none once it ended); I04-T10 writes them. */
export function queuedLedgerLines(tx: CanonicalTx): readonly LedgerLineDraft[] {
  return open.get(tx)?.lines ?? [];
}
