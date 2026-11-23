import Database from "better-sqlite3";
import type { OpenSqlDriver, SqlRow } from "../sql-driver.ts";

const blockingSleep = (ms: number) =>
  void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Prepared statements kept per connection; SQL with a varying `IN (?, ...)` list must not grow the map without end. */
const STATEMENT_CACHE_LIMIT = 256;

export const openBetterSqlite3: OpenSqlDriver = (path, options = {}) => {
  const {
    busyTimeoutMs = 5000,
    commitRetryDelaysMs = [100, 400, 1600],
    sleep = blockingSleep,
  } = options;
  const db = new Database(path);
  try {
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    // V02-R12: a deleted row's bytes are overwritten, not left in free space. The
    // setting lives on the connection, so it is set on every open, never in a migration.
    db.pragma("secure_delete = ON");
    // WAL would keep the purged pages in -wal after commit, and a file remembers WAL
    // across opens, so the rollback journal (deleted at commit) is pinned (review B2).
    db.pragma("journal_mode = DELETE");
    // A row's history lines go with the row through ON DELETE CASCADE (S01-R6), and every other cascade
    // of the schema too; the setting is per connection, so it is set here, not left to a compile default.
    db.pragma("foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  const statements = new Map<string, Database.Statement>();
  const statement = (sql: string): Database.Statement => {
    const kept = statements.get(sql);
    if (kept) return kept;
    const prepared = db.prepare(sql);
    if (statements.size >= STATEMENT_CACHE_LIMIT) {
      statements.delete(statements.keys().next().value as string);
    }
    statements.set(sql, prepared);
    return prepared;
  };
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => {
      const { changes, lastInsertRowid } = statement(sql).run(...params);
      return { changes, lastInsertRowid: Number(lastInsertRowid) };
    },
    all: (sql, params = []) => statement(sql).all(...params) as SqlRow[],
    transaction: (fn, txOptions) => {
      const { beforeCommit } = txOptions ?? {};
      if (!beforeCommit) {
        const transaction = db.transaction(fn);
        return txOptions?.immediate ? transaction.immediate() : transaction();
      }
      if (db.inTransaction) {
        throw new Error("beforeCommit needs the outermost transaction, but one is open");
      }
      db.exec(txOptions?.immediate ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = fn();
        beforeCommit();
        for (let attempt = 0; ; attempt++) {
          try {
            db.exec("COMMIT");
            return result;
          } catch (error) {
            const delay = commitRetryDelaysMs[attempt];
            if ((error as { code?: string }).code !== "SQLITE_BUSY" || delay === undefined) {
              throw error;
            }
            sleep(delay);
          }
        }
      } catch (error) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => {
      statements.clear();
      db.close();
    },
  };
};
