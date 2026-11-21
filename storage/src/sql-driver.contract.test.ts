// V01-C7 `sql-driver.contract`: every SqlDriver implementation passes the
// same suite. Add a new driver to `drivers` rather than writing a new suite.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
import type { OpenSqlDriver, SqlDriver } from "./sql-driver.ts";

const drivers: [string, OpenSqlDriver][] = [["better-sqlite3", openBetterSqlite3]];

describe.each(drivers)("sql-driver.contract: %s", (_name, open) => {
  let dir: string;
  let db: SqlDriver;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pki-sql-driver-"));
    db = open(join(dir, "test.sqlite"));
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v)");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports changes and the inserted rowid", () => {
    const first = db.run("INSERT INTO t (v) VALUES (?)", ["a"]);
    const second = db.run("INSERT INTO t (v) VALUES (?)", ["b"]);
    expect(first).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(second.lastInsertRowid).toBe(2);
    expect(db.run("UPDATE t SET v = 'c'").changes).toBe(2);
  });

  it("binds positional parameters and round-trips every value type", () => {
    const values = ["텍스트", 42, 1.5, null, new Uint8Array([1, 2, 3])];
    for (const v of values) db.run("INSERT INTO t (v) VALUES (?)", [v]);
    const rows = db.all("SELECT v FROM t ORDER BY id");
    expect(rows.map((r) => r.v)).toEqual([
      "텍스트",
      42,
      1.5,
      null,
      expect.objectContaining({ length: 3 }),
    ]);
    expect([...(rows[4]?.v as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("does not interpret parameter values as SQL", () => {
    db.run("INSERT INTO t (v) VALUES (?)", ["x'); DROP TABLE t; --"]);
    expect(db.all("SELECT v FROM t")).toEqual([{ v: "x'); DROP TABLE t; --" }]);
  });

  it("runs multi-statement scripts with exec", () => {
    db.exec("INSERT INTO t (v) VALUES (1); INSERT INTO t (v) VALUES (2);");
    expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }]);
  });

  it("commits a transaction and returns its value", () => {
    const result = db.transaction(() => {
      db.run("INSERT INTO t (v) VALUES (1)");
      return "done";
    });
    expect(result).toBe("done");
    expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 1 }]);
  });

  it("rolls back every write of a failed transaction and rethrows", () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (v) VALUES (1)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
  });

  it("enforces foreign keys", () => {
    db.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, t_id INTEGER NOT NULL REFERENCES t(id))");
    expect(() => db.run("INSERT INTO child (t_id) VALUES (99)")).toThrow();
  });

  it("persists committed data across reopening the file", () => {
    db.run("INSERT INTO t (v) VALUES ('kept')");
    db.close();
    db = open(join(dir, "test.sqlite"));
    expect(db.all("SELECT v FROM t")).toEqual([{ v: "kept" }]);
  });

  it("rejects use after close", () => {
    db.close();
    expect(() => db.all("SELECT 1")).toThrow();
    db = open(join(dir, "test.sqlite"));
  });
});
