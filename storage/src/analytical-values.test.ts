// S03-T08 `analytical.api` (the `/correct` pieces, S03-R3): a value given as pieces is stored as the canonical text.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { normalizeUserValue } from "./analytical-values.ts";
import { migrate } from "./migrations.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

describe("analytical.api: /correct pieces", () => {
  it("C3: a calculation and a column set given as pieces become the canonical text, the same as the text form; a formula is a misfit", () => {
    expect(
      normalizeUserValue(db, "metric.calculation", { column: " Amount ", aggregation: "sum" }),
    ).toEqual({ status: "ok", value: '{"aggregation":"sum","column":"amount"}' });
    expect(
      normalizeUserValue(db, "metric.calculation", '{"aggregation":"sum","column":"AMOUNT"}'),
    ).toEqual({ status: "ok", value: '{"aggregation":"sum","column":"amount"}' });
    expect(normalizeUserValue(db, "dataset.grain", ["Day", "id"])).toEqual({
      status: "ok",
      value: '["day","id"]',
    });
    expect(
      normalizeUserValue(db, "metric.calculation", { aggregation: "sum", column: "a+b" }),
    ).toEqual({
      status: "ok",
      value: '{"aggregation":"sum","column":"a+b"}',
    });
    expect(normalizeUserValue(db, "metric.calculation", ["sum", "a"])).toEqual({
      status: "misfit",
    });
    expect(normalizeUserValue(db, "definition", ["not", "text"])).toEqual({ status: "misfit" });
    expect(normalizeUserValue(db, "ungoverned.kind", " plain ")).toEqual({
      status: "ok",
      value: "plain",
    });
  });
});
