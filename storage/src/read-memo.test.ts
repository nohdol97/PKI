// P3F-C2 (#233): `memoReads` answers an identical read once, forgets on any write, and hands out frozen rows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { memoReads } from "./read-memo.ts";
import type { SqlDriver } from "./sql-driver.ts";

let base: SqlDriver;
let reads: number;
let memo: SqlDriver;
beforeEach(() => {
  base = openBetterSqlite3(":memory:");
  base.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  base.run("INSERT INTO t (v) VALUES ('a')");
  reads = 0;
  memo = memoReads({
    ...base,
    all: (sql, params) => {
      reads++;
      return base.all(sql, params);
    },
  });
});
afterEach(() => base.close());

const Q = "SELECT id, v FROM t ORDER BY id";

describe("memoReads", () => {
  it("P3F-C2: an identical (sql, params) reaches the driver once and both answers are equal", () => {
    const first = memo.all(Q);
    const second = memo.all(Q);
    expect(reads).toBe(1);
    expect(second).toEqual(first);
    memo.all("SELECT id FROM t WHERE id = ?", [1]);
    memo.all("SELECT id FROM t WHERE id = ?", [2]);
    expect(reads).toBe(3);
  });

  it("P3F-C2: a write through the wrapper clears the memo and the next read returns the changed rows", () => {
    expect(memo.all(Q)).toHaveLength(1);
    memo.run("INSERT INTO t (v) VALUES ('b')");
    expect(memo.all(Q)).toHaveLength(2);
    memo.transaction(() => memo.all(Q));
    memo.exec("DELETE FROM t");
    expect(memo.all(Q)).toHaveLength(0);
    expect(reads).toBe(4);
  });

  it("P3F-C2: a returned row and the list are frozen", () => {
    const rows = memo.all(Q);
    expect(() => {
      (rows[0] as Record<string, unknown>).v = "x";
    }).toThrow(TypeError);
    expect(() => rows.push({ id: 9, v: "z" })).toThrow(TypeError);
  });

  it("a bigint or byte-array param bypasses the memo", () => {
    memo.all("SELECT ? AS x", [1n]);
    memo.all("SELECT ? AS x", [1n]);
    expect(reads).toBe(2);
  });
});
