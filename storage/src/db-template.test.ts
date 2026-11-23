// #181 R1/R3: memoryDbTemplate prepares one database per test file (the real driver and `migrate`)
// and hands out private in-memory copies that still open through `openBetterSqlite3`.
import { memoryDbTemplate } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";

let prepares = 0;
const freshDb = memoryDbTemplate(openBetterSqlite3, (db) => {
  prepares += 1;
  migrate(db);
  db.exec("create table template_marker (v text)");
});

describe("memoryDbTemplate", () => {
  it("prepares once; each copy has the migrated schema and writes stay private", () => {
    const a = freshDb();
    const b = freshDb();
    expect(prepares).toBe(1);
    const tables = (db: typeof a) =>
      db
        .all("select name from sqlite_master where type = 'table' order by name")
        .map((r) => String(r.name));
    expect(tables(a)).toContain("template_marker");
    expect(tables(a)).toEqual(tables(b));
    expect(tables(a).length).toBeGreaterThan(5);
    a.exec("insert into template_marker values ('only in a')");
    expect(b.all("select count(*) as n from template_marker")).toEqual([{ n: 0 }]);
    const c = freshDb();
    expect(c.all("select count(*) as n from template_marker")).toEqual([{ n: 0 }]);
    a.close();
    b.close();
    c.close();
  });
});
