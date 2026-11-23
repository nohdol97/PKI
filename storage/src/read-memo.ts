// A per-read memo of identical SQL reads (P3F-R1, #233). The wrapper lives as long as one analytical read; any write
// through it forgets every answer, so a memoized answer is never older than the last write the wrapper saw.
import type { SqlDriver, SqlRow, SqlValue, TransactionOptions } from "./sql-driver.ts";

const unkeyable = (v: SqlValue): boolean => typeof v === "bigint" || v instanceof Uint8Array;

/** Returns `db` with `all` answered once per identical (sql, params); rows and lists come back frozen. */
// No return annotation: the module boundary lint reads `: SqlDriver` on an object literal as a new adapter; the
// assignment at the one call site checks the shape.
export function memoReads(db: SqlDriver) {
  const seen = new Map<string, readonly SqlRow[]>();
  return {
    exec: (sql: string) => {
      seen.clear();
      db.exec(sql);
    },
    run: (sql: string, params?: readonly SqlValue[]) => {
      seen.clear();
      return db.run(sql, params);
    },
    all: (sql: string, params?: readonly SqlValue[]): SqlRow[] => {
      if (params?.some(unkeyable)) return db.all(sql, params);
      const key = `${sql}\u0000${JSON.stringify(params ?? [])}`;
      let rows = seen.get(key);
      if (rows === undefined) {
        rows = Object.freeze(db.all(sql, params).map((row) => Object.freeze(row)));
        seen.set(key, rows);
      }
      return rows as SqlRow[];
    },
    transaction: <T>(fn: () => T, options?: TransactionOptions): T => {
      seen.clear();
      try {
        return db.transaction(fn, options);
      } finally {
        seen.clear();
      }
    },
    close: () => db.close(),
  };
}
