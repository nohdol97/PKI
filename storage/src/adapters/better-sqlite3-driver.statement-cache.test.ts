// AR-C1, AR-C2 (#233): the driver keeps a prepared statement per SQL text (capped), and a reused statement
// still answers with the current schema.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";

afterEach(() => vi.restoreAllMocks());

describe("better-sqlite3 driver statement cache", () => {
  it("AR-C1: the same SQL text is prepared once for all and run calls", () => {
    const db = openBetterSqlite3(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    for (let n = 0; n < 3; n++) db.all("SELECT a FROM t WHERE a > ?", [n]);
    for (let n = 0; n < 2; n++) db.run("INSERT INTO t (a) VALUES (?)", [n]);
    expect(prepare).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("AR-C1: at most 256 statements are kept, the oldest goes first", () => {
    const db = openBetterSqlite3(":memory:");
    const prepare = vi.spyOn(Database.prototype, "prepare");
    const sql = (n: number) => `SELECT 1 WHERE 1 = ${n}`;
    for (let n = 0; n < 257; n++) db.all(sql(n));
    expect(prepare).toHaveBeenCalledTimes(257);
    db.all(sql(256));
    expect(prepare).toHaveBeenCalledTimes(257);
    db.all(sql(0));
    expect(prepare).toHaveBeenCalledTimes(258);
    db.close();
  });

  it("AR-C2: a reused SELECT * sees a column added later, and a re-created table", () => {
    const db = openBetterSqlite3(":memory:");
    db.exec("CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)");
    expect(db.all("SELECT * FROM t")).toEqual([{ a: 1 }]);
    db.exec("ALTER TABLE t ADD COLUMN b INTEGER DEFAULT 7");
    expect(db.all("SELECT * FROM t")).toEqual([{ a: 1, b: 7 }]);
    db.exec("DROP TABLE t; CREATE TABLE t (c TEXT); INSERT INTO t VALUES ('x')");
    expect(db.all("SELECT * FROM t")).toEqual([{ c: "x" }]);
    db.close();
  });

  it("AR-C2: a closed connection still refuses a statement it had cached", () => {
    const db = openBetterSqlite3(":memory:");
    db.all("SELECT 1 AS one");
    db.close();
    expect(() => db.all("SELECT 1 AS one")).toThrow(/not open/);
  });
});
