// S03-T05 `check.staleness` (S03-R11) and the queue triggers of `check.job` (S03-R12) at the storage level:
// a check line is erased in the same transaction when another row it reads changes, and the job of each
// table source the changed row reaches is queued. The receiver of a changed membership does the same for
// merge, unmerge and split, and changes no row's state. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  dataset,
  fact,
  item,
  line,
  lineIds,
  relation,
  storeVersion,
  type Stored,
} from "./analytical-check-lines.test-support.ts";
import { onMembershipChanged } from "./analytical-check-lines.ts";
import { ANALYTICAL_CHECK_JOB_KIND } from "./job-kinds.ts";
import { addEvidence } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { applyTransition, automatedLifecycle } from "./semantic-lifecycle.ts";
import { createUserDecisions, userDecisions } from "./semantic-user.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const AT = "2026-11-23T01:02:03.000Z";

interface Scene {
  a: Stored;
  b: Stored;
  d: number;
  d2: number;
  column: number;
  grain: number;
  measure: number;
  metric: number;
  calc: number;
  unit: number;
  join: number;
  keys: number;
  cardinality: number;
  measuredOn: number;
  usesJoin: number;
  joinLeft: number;
  joinRight: number;
}

/**
 * A fact table `d` (source a) with a column, a Grain and a measure fact; a Metric on it with a calculation and
 * a unit fact; a Join between `d` and a dimension `d2` (source b) with a keys and a cardinality fact; the
 * Metric uses the Join. Every check line is written once, reading the table(s) it reads.
 */
function scene(db: SqlDriver): Scene {
  const a = storeVersion(db, "a");
  const b = storeVersion(db, "b");
  const d = dataset(db, "d", a.sourceId);
  const d2 = dataset(db, "d2", b.sourceId);
  const column = fact(db, d, "dataset.column", "x");
  const grain = fact(db, d, "dataset.grain", '["x"]');
  const measure = fact(db, d, "dataset.measure", "y");
  const metric = item(db, "Metric", "m");
  const calc = fact(db, metric, "metric.calculation", '{"aggregation":"count"}');
  const unit = fact(db, metric, "metric.unit", "won");
  const join = item(db, "Join", "j");
  const keys = fact(db, join, "join.keys", '[["x","x"]]');
  const cardinality = fact(db, join, "join.cardinality", "many-to-one");
  const measuredOn = relation(db, metric, "MEASURED_ON", d);
  const usesJoin = relation(db, metric, "USES_JOIN", join);
  const joinLeft = relation(db, join, "JOIN_LEFT", d);
  const joinRight = relation(db, join, "JOIN_RIGHT", d2);
  line(db, grain, "schema", a.versionId);
  line(db, grain, "grain", a.versionId);
  line(db, measure, "schema", a.versionId);
  line(db, calc, "schema", a.versionId);
  line(db, calc, "aggregation", a.versionId, b.versionId);
  line(db, keys, "schema", a.versionId, b.versionId);
  line(db, cardinality, "join-cardinality", a.versionId, b.versionId);
  return {
    a,
    b,
    d,
    d2,
    column,
    grain,
    measure,
    metric,
    calc,
    unit,
    join,
    keys,
    cardinality,
    measuredOn,
    usesJoin,
    joinLeft,
    joinRight,
  };
}

let db: SqlDriver;
let s: Scene;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
  s = scene(db);
});
afterEach(() => db.close());

const ALL = (s: Scene) =>
  [
    `${s.grain}:grain`,
    `${s.grain}:schema`,
    `${s.measure}:schema`,
    `${s.calc}:aggregation`,
    `${s.calc}:schema`,
    `${s.keys}:schema`,
    `${s.cardinality}:join-cardinality`,
  ].sort();
const without = (...gone: string[]) => ALL(s).filter((l) => !gone.includes(l));
const lines = () => lineIds(db).sort();
const fact_ = (id: number) => ({ kind: "fact", id }) as const;
const rel_ = (id: number) => ({ kind: "relation", id }) as const;
const approve = (ref: { kind: "fact" | "relation"; id: number }) =>
  userDecisions.decide(db, ref, "approve", AT);
const checkJobs = () =>
  db
    .all("SELECT source_id FROM jobs WHERE kind = ? ORDER BY source_id", [
      ANALYTICAL_CHECK_JOB_KIND,
    ])
    .map((r) => r.source_id as number);

const ANY_SCOPE = { combinable: () => true };

describe("check.staleness: another row a check reads changes", () => {
  it("check.staleness: changing the Grain fact's status deletes the calculation's aggregation line in the same transaction and keeps its schema line and the Grain fact's own lines", () => {
    expect(() =>
      db.transaction(() => {
        approve(fact_(s.grain));
        expect(lines()).toEqual(without(`${s.calc}:aggregation`));
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(lines()).toEqual(ALL(s)); // the erase went with the transaction
    approve(fact_(s.grain));
    expect(lines()).toEqual(without(`${s.calc}:aggregation`));
  });

  it("check.staleness: a new, rejected or superseded MEASURED_ON deletes every line of the Metric's facts", () => {
    const metricLines = [`${s.calc}:aggregation`, `${s.calc}:schema`];
    const restore = () => {
      line(db, s.calc, "schema", s.a.versionId);
      line(db, s.calc, "aggregation", s.a.versionId);
      expect(lines()).toEqual(ALL(s));
    };
    const basis = { sourceId: s.a.sourceId, version: s.a.version };
    applyTransition(db, rel_(s.measuredOn), "propagation", "superseded", { basis, at: AT });
    expect(lines()).toEqual(without(...metricLines));
    restore();
    // rejected by the user
    const other = relation(db, s.metric, "MEASURED_ON", s.d2);
    userDecisions.decide(db, rel_(other), "reject", AT);
    expect(lines()).toEqual(without(...metricLines));
    restore();
    // a new one: an extraction's creation line, and a user's direct add
    const fresh = relation(db, s.metric, "MEASURED_ON", item(db, "Dataset", "d4"));
    automatedLifecycle.created(db, rel_(fresh), "extraction", basis, AT);
    expect(lines()).toEqual(without(...metricLines));
    restore();
    const d3 = item(db, "Dataset", "d3");
    userDecisions.add(
      db,
      { kind: "relation", subjectId: s.metric, type: "MEASURED_ON", objectId: d3 },
      AT,
    );
    expect(lines()).toEqual(without(...metricLines));
  });

  it("check.staleness: a change of the Join's keys fact deletes the Join's join-cardinality line and the aggregation lines of the Metrics that use the Join; a change of its cardinality fact only the latter", () => {
    approve(fact_(s.cardinality));
    expect(lines()).toEqual(without(`${s.calc}:aggregation`));
    line(db, s.calc, "aggregation", s.a.versionId);
    approve(fact_(s.keys));
    expect(lines()).toEqual(without(`${s.calc}:aggregation`, `${s.cardinality}:join-cardinality`));
  });

  it("check.staleness: a change of JOIN_LEFT/RIGHT deletes the Join's lines and the using Metrics' aggregation lines; USES_JOIN the Metric's aggregation line", () => {
    userDecisions.decide(db, rel_(s.joinLeft), "reject", AT);
    expect(lines()).toEqual(
      without(`${s.keys}:schema`, `${s.cardinality}:join-cardinality`, `${s.calc}:aggregation`),
    );
    line(db, s.keys, "schema", s.a.versionId);
    line(db, s.cardinality, "join-cardinality", s.a.versionId);
    line(db, s.calc, "aggregation", s.a.versionId);
    userDecisions.decide(db, rel_(s.usesJoin), "reject", AT);
    expect(lines()).toEqual(without(`${s.calc}:aggregation`));
  });

  it("check.staleness: a column fact's change deletes the lines of its Dataset's facts and of the Metrics and Joins on it", () => {
    approve(fact_(s.column));
    expect(lines()).toEqual([]); // d's facts, the Metric on d, the Join on d (and the Metric through the Join)
  });

  it("check.staleness: approving, disputing or rejecting the target, and adding evidence to it, keep the target's own lines", () => {
    approve(fact_(s.calc));
    userDecisions.decide(db, fact_(s.calc), "dispute", AT);
    userDecisions.decide(db, fact_(s.calc), "reject", AT);
    addEvidence(db, {
      target: { factId: s.calc },
      sourceVersionId: s.a.versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
    expect(lines()).toEqual(ALL(s));
  });

  it("check.staleness: evidence added to another row a check reads deletes that check's line", () => {
    addEvidence(db, {
      target: { factId: s.grain },
      sourceVersionId: s.a.versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
    expect(lines()).toEqual(without(`${s.calc}:aggregation`));
    // the same evidence again is no change
    line(db, s.calc, "aggregation", s.a.versionId);
    addEvidence(db, {
      target: { factId: s.grain },
      sourceVersionId: s.a.versionId,
      start: 0,
      end: 1,
      quote: "a",
    });
    expect(lines()).toEqual(ALL(s));
  });

  it("check.staleness: a unit, currency, period or version fact's change deletes nothing", () => {
    approve(fact_(s.unit));
    for (const kind of ["metric.currency", "metric.period", "metric.version"]) {
      const f = fact(db, s.metric, kind, "v");
      approve(fact_(f));
    }
    expect(lines()).toEqual(ALL(s));
    expect(checkJobs()).toEqual([]);
  });

  it("check.staleness: undoing a direct add of a row a check reads deletes that check's line", () => {
    const added = userDecisions.add(
      db,
      { kind: "fact", itemId: s.d, factKind: "dataset.grain", value: '["y"]' },
      AT,
    );
    if (added.status !== "applied") throw new Error(added.status);
    line(db, s.calc, "aggregation", s.a.versionId);
    expect(lines()).toEqual(ALL(s));
    expect(userDecisions.undo(db, fact_(added.ref.id), AT).status).toBe("removed");
    expect(lines()).toEqual(without(`${s.calc}:aggregation`));
  });
});

describe("check.job: an analytical row's change queues the check job", () => {
  it("check.job: an analytical row's change queues the check job of each table source its item reaches, and none when it reaches none", () => {
    approve(fact_(s.grain)); // on d: source a
    expect(checkJobs()).toEqual([s.a.sourceId]);
    approve(fact_(s.keys)); // the Join reaches d and d2
    expect(checkJobs()).toEqual([s.a.sourceId, s.b.sourceId].sort((x, y) => x - y));
    db.run("DELETE FROM jobs");
    // the Metric's only MEASURED_ON and its USES_JOIN rejected: nothing is reached, no job
    const lonely = item(db, "Metric", "lonely");
    const only = relation(db, lonely, "MEASURED_ON", s.d);
    db.run("DELETE FROM jobs");
    userDecisions.decide(db, rel_(only), "reject", AT);
    expect(checkJobs()).toEqual([]);
  });

  it("dark launch: with no dataset_tables row the hook reads nothing else and queues nothing", () => {
    db.run("DELETE FROM dataset_tables");
    // a read of anything else would fail on this: the analytical tables are gone
    db.exec("DROP TABLE analytical_checks");
    expect(() => approve(fact_(s.grain))).not.toThrow();
    expect(() => approve(rel_(s.joinLeft))).not.toThrow();
    expect(checkJobs()).toEqual([]);
  });
});

describe("check.staleness: the receiver of a changed membership", () => {
  const decisions = () =>
    createUserDecisions({ combinable: () => true, listeners: [onMembershipChanged] });

  it("check.staleness: the receiver deletes the lines of the touched items' facts and of the facts that read them, and queues the jobs of the sources reached before and after", () => {
    const d3 = dataset(db, "d3", s.b.sourceId, "other");
    const merged = db.transaction(() => decisions().entities.merge(db, d3, s.d, AT));
    expect(merged.status).toBe("applied");
    // d and d3 are touched: their facts, the Metric measured on d and the Join with d on a side
    expect(lines()).toEqual([]);
    expect(checkJobs()).toEqual([s.a.sourceId, s.b.sourceId].sort((x, y) => x - y));
  });

  it("check.staleness: splitting the Grain fact to a new item deletes the calculation's aggregation line and queues the job", () => {
    db.run("DELETE FROM jobs");
    const done = db.transaction(() =>
      decisions().entities.split(db, s.d, [fact_(s.grain)], "d-split", AT),
    );
    expect(done.status).toBe("applied");
    expect(lines()).not.toContain(`${s.calc}:aggregation`);
    expect(checkJobs()).toContain(s.a.sourceId);
  });

  it("check.staleness: splitting the calculation fact itself deletes its lines", () => {
    const done = db.transaction(() =>
      decisions().entities.split(db, s.metric, [fact_(s.calc)], "m-split", AT),
    );
    expect(done.status).toBe("applied");
    expect(lines()).not.toContain(`${s.calc}:schema`);
    expect(lines()).not.toContain(`${s.calc}:aggregation`);
  });

  it("check.staleness: the receiver changes no status, epistemic type or history line", () => {
    const run = (listeners: Parameters<typeof createUserDecisions>[0]["listeners"]) => {
      const other = openBetterSqlite3(":memory:");
      migrate(other);
      registerConnectorInstance(other, "c1", "test-fixtures");
      const w = scene(other);
      const x = createUserDecisions({ combinable: () => true, listeners });
      const d3 = dataset(other, "d3", w.b.sourceId, "other");
      const merged = other.transaction(() => x.entities.merge(other, d3, w.d, AT));
      if (merged.status !== "applied") throw new Error(merged.status);
      other.transaction(() => x.entities.unmerge(other, merged.mergeId, false, AT));
      other.transaction(() =>
        x.entities.split(other, w.d, [{ kind: "fact", id: w.grain }], "n", AT),
      );
      const state = [
        "items",
        "facts",
        "relations",
        "item_history",
        "fact_history",
        "relation_history",
      ].map((t) => other.all(`SELECT * FROM ${t} ORDER BY 1, 2`));
      other.close();
      return state;
    };
    expect(run([onMembershipChanged])).toEqual(run([]));
  });

  it("check.staleness: the receiver does not throw when a moved row is gone, an item is gone, or nothing reaches a table", () => {
    expect(() =>
      db.transaction(() =>
        onMembershipChanged(
          db,
          { items: [99999], movedRows: [{ kind: "fact", id: 99999 }] },
          ANY_SCOPE,
        ),
      ),
    ).not.toThrow();
    const bare = item(db, "Concept", "bare");
    expect(() =>
      onMembershipChanged(db, { items: [bare], movedRows: [] }, ANY_SCOPE),
    ).not.toThrow();
    expect(lines()).toEqual(ALL(s));
    db.run("DELETE FROM dataset_tables");
    expect(() => onMembershipChanged(db, { items: [s.d], movedRows: [] }, ANY_SCOPE)).not.toThrow();
  });
});
