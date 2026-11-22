// The canonical transaction (I04-R17): every write that may reach a tombstone
// entry opens one, so the entries can queue their ledger lines on it. It is not a
// driver: it passes every call to the driver the composition root built, in that
// driver's one transaction, which takes the write lock as it begins (the entries
// read, judge, then write). A call inside one joins it with the same tx, as a
// savepoint: if it throws and the outer one catches, its rows and its queued
// lines are undone, never half kept.
// The ledger (I04-R17, I04-T10): when the driver has one attached (the composition
// root attaches it), the outermost transaction numbers the queued lines and writes
// them right before COMMIT, in the driver's `beforeCommit`, then records the last
// number in the same transaction. Called inside a raw driver transaction, a
// transaction that holds a ledger cannot open: `beforeCommit` would run at a
// savepoint's release, before the outer transaction could still roll back.
import type { CanonicalTransaction, CanonicalTx, LedgerLineDraft } from "./derivatives.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";
import {
  LEDGER_SEQ_SETTING,
  LedgerDegradedError,
  LedgerLineUnwritableError,
  draftReadable,
  ledgerOf,
} from "./tombstone-ledger.ts";

/** The last ledger sequence the database has applied or written (0 before any). */
export function readLedgerSeq(db: SqlDriver): number {
  return Number(readSetting(db, LEDGER_SEQ_SETTING) ?? 0);
}

export function writeLedgerSeq(db: SqlDriver, seq: number): void {
  writeSetting(db, LEDGER_SEQ_SETTING, String(seq));
}

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
  const ledger = ledgerOf(db);
  if (ledger?.isLocked()) throw new LedgerDegradedError();
  const lines: LedgerLineDraft[] = [];
  let assigned: number[] = [];
  const tx: CanonicalTx = {
    exec: (sql) => db.exec(sql),
    run: (sql, params) => db.run(sql, params),
    all: (sql, params) => db.all(sql, params),
    // a savepoint that rolls back takes the lines queued inside it, like a joined canonicalTransaction
    transaction: (inner, options) => {
      const mark = lines.length;
      try {
        return db.transaction(inner, options);
      } catch (error) {
        lines.length = mark;
        throw error;
      }
    },
    close: () => db.close(),
    queueLedgerLine: (line) => void lines.push(line),
  };
  open.set(db, { tx, lines });
  open.set(tx, { tx, lines });
  try {
    return db.transaction(() => fn(tx), {
      immediate: true,
      ...(ledger && {
        beforeCommit: () => {
          if (lines.length === 0) return;
          // the reader's own validation: no tombstone without a line the reader accepts (fail closed)
          if (!lines.every(draftReadable)) throw new LedgerLineUnwritableError();
          assigned = ledger.reserve(lines.length, readLedgerSeq(tx));
          ledger.append(assigned, lines);
          writeLedgerSeq(tx, assigned[assigned.length - 1] as number);
        },
      }),
    });
  } catch (error) {
    // the lines may be in the file and their transaction is gone: say so, so the next
    // start does not apply a deletion that never happened. If even that cannot be
    // written the ledger locks, and the next start applies them as requested.
    if (ledger && assigned.length > 0) {
      try {
        ledger.cancel(assigned);
      } catch {
        ledger.lock();
      }
    }
    throw error;
  } finally {
    open.delete(db);
    open.delete(tx);
  }
};

/** The lines queued so far in the open transaction of `tx` (none once it ended); I04-T10 writes them. */
export function queuedLedgerLines(tx: CanonicalTx): readonly LedgerLineDraft[] {
  return open.get(tx)?.lines ?? [];
}
