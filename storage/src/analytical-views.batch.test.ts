// ARB-C3 (#233): the reads return what they returned before the per-row reads were batched. The expectation file
// was made by the code before the change from `batchWorld`; a row the caller may not see is absent whole.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { batchWorld } from "./analytical-views.batch.test-support.ts";
import { listAnalytical, listMetricViews } from "./analytical-views.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const expected = JSON.parse(
  readFileSync(new URL("./analytical-views.batch.expected.json", import.meta.url), "utf8"),
);

/** Every number under an id-bearing key of a response. */
function idsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => idsIn(v, found));
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (["id", "itemId", "factId"].includes(key) && typeof v === "number")
        found.add(`${key}:${v}`);
      if (["evidenceIds", "ids"].includes(key))
        (v as number[]).forEach((n) => found.add(`${key}:${n}`));
      idsIn(v, found);
    }
  }
  return found;
}

describe("analytical reads, batched (ARB-C3)", () => {
  it("answer what the unbatched reads answered, and a hidden row stays hidden", () => {
    const w = batchWorld(db);
    const actual = {
      analytical: listAnalytical(db, w.vis),
      metrics: listMetricViews(db, w.vis),
      analyticalAll: listAnalytical(db),
    };
    expect(JSON.parse(JSON.stringify(actual))).toEqual(expected);
    const shown = idsIn([actual.analytical, actual.metrics]);
    expect(shown.has(`itemId:${w.ids.item}`)).toBe(false);
    expect(shown.has(`id:${w.ids.fact}`)).toBe(false);
    expect(shown.has(`evidenceIds:${w.ids.evidence}`)).toBe(false);
    expect(shown.has(`ids:${w.ids.fact}`)).toBe(false);
    expect(idsIn(actual.analyticalAll).has(`itemId:${w.ids.item}`)).toBe(true);
  });
});
