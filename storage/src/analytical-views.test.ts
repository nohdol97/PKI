// S03-T08 `metrics.view`, `analytical.link`, `analytical.no-query-surface` (storage part; S03-R8, R9, R18, R19):
// the Metric list answers exactly R19's fields, the link from a document's claim to the real table and its
// column reads in one call, conflicts are read group-wide, a hidden row is absent whole, and no value of the
// table appears. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  csvBlocks,
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import { listAnalytical, listMetricViews, type Visibility } from "./analytical-views.ts";
import { entityGroups } from "./entity-groups.ts";
import { addEvidence } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { userDecisions } from "./semantic-user.ts";
import { findSourceVersionId, registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const CALC = '{"aggregation":"sum","column":"amount"}';
const revision = () => db.all("SELECT knowledge_revision FROM revisions")[0]?.knowledge_revision;
const hiding = (hidden: (kind: string, id: string) => boolean): Visibility => ({
  shown: (kind, id) => !hidden(kind, id),
});

/** A Metric on a bound Dataset whose `amount` column fact has evidence in the table version. */
function world(status: "candidate" | "verified" = "candidate") {
  const table = storeVersion(db, "t1");
  const d = dataset(db, "orders", table.sourceId);
  const metric = item(db, "Metric", "매출");
  relation(db, metric, "MEASURED_ON", d);
  const calc = fact(db, metric, "metric.calculation", CALC, status);
  const column = fact(db, d, "dataset.column", "amount");
  addEvidence(db, {
    target: { factId: column },
    sourceVersionId: table.versionId,
    start: 0,
    end: 1,
    quote: "a",
  });
  line(db, calc, "schema", table.versionId);
  fact(db, metric, "alias.synonym", "revenue");
  fact(db, metric, "definition", "월 매출 합계");
  fact(db, metric, "metric.unit", "원");
  return { table, d, metric, calc, column };
}

describe("metrics.view", () => {
  it("C3: answers exactly the fields of R19, a Metric's checks and unmet conditions with its calculation, and 확정 only for a verified calculation", () => {
    const w = world();
    const [view] = listMetricViews(db);
    expect(Object.keys(view ?? {}).sort()).toEqual(
      [
        "calculationConfirmed",
        "calculations",
        "columns",
        "conflicts",
        "currencies",
        "datasets",
        "definitions",
        "epistemic",
        "grain",
        "itemId",
        "joins",
        "members",
        "name",
        "periods",
        "relations",
        "status",
        "terms",
        "units",
        "userAuthored",
        "userDecided",
        "versions",
      ].sort(),
    );
    expect(view?.terms.map((t) => t.value)).toEqual(["revenue"]);
    expect(view?.calculationConfirmed).toBe(false);
    const calc = view?.calculations[0];
    expect(calc).toMatchObject({ id: w.calc, checkNeeded: true, unmet: ["check-missing"] });
    expect(calc?.checks.map((c) => c.check)).toEqual(["schema"]);

    userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve"); // refused: the aggregation line is missing
    expect(listMetricViews(db)[0]?.calculationConfirmed).toBe(false);
    line(db, w.calc, "aggregation", w.table.versionId);
    userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve");
    expect(listMetricViews(db)[0]?.calculationConfirmed).toBe(true);
  });

  it("C3: a check line written does not raise the knowledge revision, a status change does; a hidden Metric and a hidden check line are absent", () => {
    const w = world();
    const before = revision();
    line(db, w.calc, "aggregation", w.table.versionId);
    expect(revision()).toBe(before);
    userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve");
    expect(revision()).not.toBe(before);

    expect(
      listMetricViews(
        db,
        hiding((k, id) => k === "item" && id === String(w.metric)),
      ),
    ).toEqual([]);
    const lineId = db.all("SELECT id FROM analytical_checks WHERE check_name = 'schema'")[0]
      ?.id as number;
    const view = listMetricViews(
      db,
      hiding((k, id) => k === "analytical-check" && id === `check:${lineId}`),
    )[0];
    expect(view?.calculations[0]?.checks.map((c) => c.check)).toEqual(["aggregation"]);
  });
});

describe("analytical.link", () => {
  it("C1: one read gives the Dataset, its real table, the column fact's id and column-missing for an absent column; a hidden table is no real table", () => {
    const w = world();
    const metric = listMetricViews(db)[0];
    expect(metric?.datasets).toMatchObject([
      { itemId: w.d, tables: [{ sourceId: w.table.sourceId }] },
    ]);
    expect(metric?.columns).toEqual([{ column: "amount", factId: w.column, missing: null }]);

    fact(db, w.metric, "metric.calculation", '{"aggregation":"max","column":"ghost"}');
    expect(listMetricViews(db)[0]?.columns).toContainEqual({
      column: "ghost",
      factId: null,
      missing: "column-missing",
    });

    const tableId = db.all("SELECT id FROM dataset_tables")[0]?.id as number;
    const hidden = listMetricViews(
      db,
      hiding((k, id) => k === "analytical-check" && id === `table:${tableId}`),
    )[0];
    expect(hidden?.datasets[0]?.tables).toEqual([]);
    expect(hidden?.columns[0]?.missing).toBe("no-table");
  });

  it("C1: a document's Dataset merged into the table's Dataset lists the member with the real table beside it; the representative without one is flagged; conflicts read group-wide", () => {
    const table = storeVersion(db, "t1");
    const real = dataset(db, "orders", table.sourceId);
    const doc = item(db, "Dataset", "orders");
    expect(
      db.transaction(() => userDecisions.entities.merge(db, real, doc, "2026-11-23T00:00:00.000Z")),
    ).toMatchObject({ status: "applied" });
    for (const [itemId, value] of [
      [doc, '["id"]'],
      [real, '["day","id"]'],
    ] as const) {
      addEvidence(db, {
        target: { factId: fact(db, itemId, "dataset.grain", value) },
        sourceVersionId: table.versionId,
        start: 0,
        end: 1,
        quote: "a",
      });
    }

    const [group] = listAnalytical(db).datasets;
    expect(group).toMatchObject({
      itemId: doc,
      tables: [],
      groupTableItemIds: [real],
      representativeLacksTable: true,
    });
    expect(group?.members.map((m) => m.itemId)).toEqual([real]);
    expect(group?.conflicts).toMatchObject([{ kind: "dataset.grain", rowKind: "fact" }]);
    expect(group?.conflicts[0]?.ids).toHaveLength(2);
  });
});

describe("analytical.no-query-surface", () => {
  it("C3: the total of the Measure column exists in no cell; it is in no read and no table, and the check line's columns are numbers and codes", () => {
    const saved = saveSourceRecord(db, "c1", {
      namespace: "",
      externalId: "sales",
      title: "sales",
      body: "id\tamount\n1\t500000000\n2\t487654321",
      blocks: csvBlocks,
    } as Parameters<typeof saveSourceRecord>[2]);
    if (saved.status !== "created") throw new Error("not stored");
    const d = dataset(db, "sales", saved.sourceId);
    const metric = item(db, "Metric", "m");
    relation(db, metric, "MEASURED_ON", d);
    const calc = fact(db, metric, "metric.calculation", CALC, "verified");
    const versionId = findSourceVersionId(db, saved.sourceId, saved.version) as number;
    line(db, calc, "aggregation", versionId);

    const reads = JSON.stringify(listAnalytical(db)) + JSON.stringify(listMetricViews(db));
    expect(reads).not.toContain("987654321");
    const tables = db
      .all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .map((r) => r.name as string);
    const rows = tables.map((t) => JSON.stringify(db.all(`SELECT * FROM "${t}"`))).join("");
    expect(rows).not.toContain("987654321");
    expect(
      db
        .all("PRAGMA table_info(analytical_checks)")
        .map((c) => `${c.name as string}:${c.type as string}`)
        .sort(),
    ).toEqual([
      "check_name:TEXT",
      "checked_at:TEXT",
      "examined:INTEGER",
      "fact_id:INTEGER",
      "failure_code:TEXT",
      "id:INTEGER",
      "other_version_id:INTEGER",
      "passed:INTEGER",
      "skipped:INTEGER",
      "version_id:INTEGER",
      "violations:INTEGER",
    ]);
  });
});

describe("rework 1: visibility of paths, unmet, limit and group members", () => {
  it("F1: a hidden MEASURED_ON relation leaves the Metric with no Dataset, no column match and no grain", () => {
    const w = world();
    fact(db, w.d, "dataset.grain", '["id"]');
    const rel = db.all("SELECT id FROM relations WHERE type = 'MEASURED_ON'")[0]?.id as number;
    const view = listMetricViews(
      db,
      hiding((k, id) => k === "relation" && id === String(rel)),
    )[0];
    expect(view?.datasets).toEqual([]);
    expect(view?.grain).toEqual([]);
    expect(view?.columns[0]?.missing).toBe("no-table");
  });

  it("F2: a hidden failed check line does not name its check in unmet; check-missing stands for it", () => {
    const w = world();
    db.run(
      "UPDATE analytical_checks SET passed = 0, failure_code = 'column-missing' WHERE fact_id = ? AND check_name = 'schema'",
      [w.calc],
    );
    const lineId = db.all("SELECT id FROM analytical_checks WHERE check_name = 'schema'")[0]
      ?.id as number;
    const open = listMetricViews(db)[0]?.calculations[0]?.unmet;
    expect(open).toContain("schema");
    const hidden = listMetricViews(
      db,
      hiding((k, id) => k === "analytical-check" && id === `check:${lineId}`),
    )[0]?.calculations[0]?.unmet;
    expect(hidden).not.toContain("schema");
    expect(hidden).toContain("check-missing");
  });

  it("U1: unmet is judged over the rows the caller sees: a hidden relation gives no-dataset, a hidden rival no spec-conflict", () => {
    const w = world();
    line(db, w.calc, "aggregation", w.table.versionId);
    const unmet = (vis?: Visibility) => listMetricViews(db, vis)[0]?.calculations[0]?.unmet;
    expect(unmet()).toEqual([]);
    const rel = db.all("SELECT id FROM relations WHERE type = 'MEASURED_ON'")[0]?.id as number;
    expect(unmet(hiding((k, id) => k === "relation" && id === String(rel)))).toContain(
      "no-dataset",
    );

    const cite = (factId: number) =>
      addEvidence(db, {
        target: { factId },
        sourceVersionId: w.table.versionId,
        start: 0,
        end: 1,
        quote: "a",
      });
    cite(w.calc);
    const rival = fact(
      db,
      w.metric,
      "metric.calculation",
      '{"aggregation":"max","column":"amount"}',
    );
    cite(rival);
    expect(unmet()).toContain("spec-conflict");
    expect(unmet(hiding((k, id) => k === "fact" && id === String(rival)))).not.toContain(
      "spec-conflict",
    );
  });

  it("U3: two merged Metrics list the member under the representative, with its own calculation; the member is not at the top level", () => {
    const a = item(db, "Metric", "매출");
    const b = item(db, "Metric", "revenue");
    fact(db, a, "metric.calculation", CALC);
    const memberCalc = fact(db, b, "metric.calculation", '{"aggregation":"max","column":"amount"}');
    db.transaction(() => userDecisions.entities.merge(db, a, b, "2026-11-23T00:00:00.000Z"));
    const { metrics } = listAnalytical(db);
    expect(metrics).toHaveLength(1);
    const top = metrics[0];
    const memberId = top?.itemId === a ? b : a;
    expect(top?.members.map((m) => m.itemId)).toEqual([memberId]);
    const member = top?.members[0];
    expect(member?.members).toEqual([]);
    if (memberId === b) expect(member?.calculations.map((c) => c.id)).toEqual([memberCalc]);
    expect(listMetricViews(db).map((m) => m.itemId)).toEqual([top?.itemId]);
  });

  it("AR-C5: a visible member whose representative is hidden lists no members of its own", () => {
    const [a, b, c] = ["m1", "m2", "m3"].map((n) => item(db, "Metric", n));
    const at = "2026-11-23T00:00:00.000Z";
    db.transaction(() => userDecisions.entities.merge(db, a, b, at));
    db.transaction(() => userDecisions.entities.merge(db, a, c, at));
    const rep = [a, b, c].find((id) => entityGroups.representativeOf(db, id) === id) as number;
    const vis = hiding((k, id) => k === "item" && id === String(rep));
    for (const metrics of [listAnalytical(db, vis).metrics, listMetricViews(db, vis)]) {
      expect(metrics).toHaveLength(2);
      expect(metrics.map((m) => m.members)).toEqual([[], []]);
    }
  });

  it("F3: hidden low-id items do not use up the limit and do not set truncated", () => {
    const [a, b, c] = [1, 2, 3].map((n) => item(db, "Metric", `m${n}`));
    const vis = hiding((k, id) => k === "item" && (id === String(a) || id === String(b)));
    expect(listMetricViews(db, vis, 1).map((m) => m.itemId)).toEqual([c]);
    expect(listAnalytical(db, vis, 1).truncated).toBe(false);
  });

  it("F4: a visible member is listed at the top level when its representative is hidden", () => {
    const table = storeVersion(db, "t1");
    const real = dataset(db, "orders", table.sourceId);
    const doc = item(db, "Dataset", "orders");
    db.transaction(() => userDecisions.entities.merge(db, real, doc, "2026-11-23T00:00:00.000Z"));
    const vis = hiding((k, id) => k === "item" && id === String(doc));
    const list = listAnalytical(db, vis).datasets;
    expect(list.map((d) => d.itemId)).toEqual([real]);
    expect(list[0]?.members).toEqual([]);
  });
});
