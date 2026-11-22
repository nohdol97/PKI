// The canonical transaction (I04-R17): every write that may reach a tombstone
// entry opens one, so the entries can queue their ledger lines on it. It is not a
// driver: it passes every call to the driver the composition root built, in that
// driver's one transaction. A call inside one joins it and gets the same tx.
// I04-T10 adds the ledger: numbering the queued lines and writing them right
// before COMMIT. Until then the lines are dropped with the transaction.
import type { CanonicalTransaction, CanonicalTx, LedgerLineDraft } from "./derivatives.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The open canonical transaction of a driver, also under its own tx (a nested call passes either). */
const open = new WeakMap<SqlDriver, CanonicalTx>();

export const canonicalTransaction: CanonicalTransaction = (db, fn) => {
  const outer = open.get(db);
  if (outer) return fn(outer);
  const lines: LedgerLineDraft[] = [];
  const tx: CanonicalTx = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    all: (sql, params) => db.all(sql, params),
    transaction: (inner, options) => db.transaction(inner, options),
    close: () => db.close(),
    queueLedgerLine: (line) => void lines.push(line),
  };
  open.set(db, tx);
  open.set(tx, tx);
  try {
    return db.transaction(() => fn(tx));
  } finally {
    open.delete(db);
    open.delete(tx);
  }
};
