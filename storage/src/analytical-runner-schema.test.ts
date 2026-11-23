// S03-T10 follow-up (#229 F6): the tables and columns the V02 site runner's Python tests build a synthetic database from
// (`verification/tests/s03_runner_schema.sql`) exist in the schema `migrate` really creates, so a renamed column
// turns this red instead of leaving the runner reading a name the product no longer has.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const SCHEMA = new URL("../../verification/tests/s03_runner_schema.sql", import.meta.url);

/** `CREATE TABLE name (col TYPE ..., col TYPE ...)` statements: the table and the first word of each definition. */
function runnerTables(sql: string): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([^;]*)\);/g)) {
    tables.set(
      m[1] as string,
      (m[2] as string).split(",").map((def) => def.trim().split(/\s+/)[0] as string),
    );
  }
  return tables;
}

it("analytical.runner-schema: every table and column of the runner's synthetic schema exists in the migrated schema", () => {
  const tables = runnerTables(readFileSync(SCHEMA, "utf8"));
  expect([...tables.keys()].sort()).toEqual([
    "analytical_checks",
    "dataset_tables",
    "facts",
    "items",
    "jobs",
    "settings",
    "source_versions",
    "tombstones",
  ]);
  for (const [table, columns] of tables) {
    const real = db.all(`SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
    for (const column of columns) expect(real, `${table}.${column}`).toContain(column);
  }
});
