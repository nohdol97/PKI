// AR-C3 (#233): one analytical read asks `Visibility.shown` about each (kind, id) once and its query count grows
// linearly with the items, at a constant well below the pre-memo 348 per Dataset+Metric+Join triple.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import { listAnalytical, type Visibility } from "./analytical-views.ts";
import { addEvidence } from "./knowledge.ts";
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

/** The shape of the bench world (tooling/poc/s03/analytical-read-latency.ts): `n` Dataset+Metric+Join triples. */
function seed(n: number): void {
  const cite = (factId: number, versionId: number) =>
    addEvidence(db, {
      target: { factId },
      sourceVersionId: versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
  for (let i = 1; i <= n; i++) {
    const table = storeVersion(db, `ds-${i}`);
    const d = dataset(db, `ds-${i}`, table.sourceId);
    for (const column of ["id", "day", "amount"])
      cite(fact(db, d, "dataset.column", column), table.versionId);
    const grain = fact(db, d, "dataset.grain", '["id"]');
    cite(grain, table.versionId);
    line(db, grain, "grain", table.versionId);
    const m = item(db, "Metric", `metric-${i}`);
    relation(db, m, "MEASURED_ON", d);
    const calc = fact(db, m, "metric.calculation", '{"aggregation":"sum","column":"amount"}');
    cite(calc, table.versionId);
    line(db, calc, "schema", table.versionId);
    line(db, calc, "aggregation", table.versionId);
    cite(fact(db, m, "metric.unit", "won"), table.versionId);
    const j = item(db, "Join", `join-${i}`);
    relation(db, j, "JOIN_LEFT", d);
    relation(db, j, "JOIN_RIGHT", d);
    const keys = fact(db, j, "join.keys", '[["id","id"]]');
    cite(keys, table.versionId);
    line(db, keys, "schema", table.versionId);
    const cardinality = fact(db, j, "join.cardinality", "one-to-one");
    cite(cardinality, table.versionId);
    line(db, cardinality, "join-cardinality", table.versionId);
  }
}

function measure(n: number): { asked: string[]; queries: number; listed: number } {
  seed(n);
  const asked: string[] = [];
  const vis: Visibility = {
    shown: (kind, id) => {
      asked.push(`${kind}:${id}`);
      return true;
    },
  };
  let queries = 0;
  const counting: SqlDriver = {
    ...db,
    all: (sql, params) => {
      queries++;
      return db.all(sql, params);
    },
  };
  const list = listAnalytical(counting, vis, 1000);
  return { asked, queries, listed: list.datasets.length + list.metrics.length + list.joins.length };
}

describe("analytical read cost", () => {
  it("AR-C3: no (kind, id) is asked twice, and the query count is linear with a small constant", () => {
    const four = measure(4);
    expect(four.listed).toBe(12);
    expect(four.asked.length).toBe(new Set(four.asked).size);
    expect(four.queries).toBeLessThanOrEqual(300 * 4 + 20);
  });

  it("AR-C3: doubling the items at most doubles the queries", () => {
    const four = measure(4);
    db.close();
    db = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "c1", "test-fixtures");
    const eight = measure(8);
    expect(eight.queries).toBeLessThanOrEqual(four.queries * 2 + 20);
  });
});
