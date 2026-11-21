import Database from "better-sqlite3";
import type { OpenSqlDriver, SqlRow } from "./sql-driver.ts";

export const openBetterSqlite3: OpenSqlDriver = (path) => {
  const db = new Database(path);
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => {
      const { changes, lastInsertRowid } = db.prepare(sql).run(...params);
      return { changes, lastInsertRowid: Number(lastInsertRowid) };
    },
    all: (sql, params = []) => db.prepare(sql).all(...params) as SqlRow[],
    transaction: (fn) => db.transaction(fn)(),
    close: () => void db.close(),
  };
};
