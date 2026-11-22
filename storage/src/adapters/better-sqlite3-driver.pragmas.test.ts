// The connection settings the schema relies on (S01-R6): a row's history is deleted with the row by
// ON DELETE CASCADE, which needs foreign_keys on every connection.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";

describe("better-sqlite3 driver pragmas", () => {
  it("opens with foreign keys enforced", () => {
    const db = openBetterSqlite3(":memory:");
    expect(db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    db.close();
  });

  it("sets foreign_keys itself instead of relying on the library's compile default", () => {
    // the compile default keeps the test above green without the line, so the source is read too
    const source = readFileSync(new URL("./better-sqlite3-driver.ts", import.meta.url), "utf8");
    expect(source).toContain('db.pragma("foreign_keys = ON")');
  });
});
