// S03-T05 `check.job` (S03-R12, R11, C2): the `analytical-check` handler on a real SQLite database. A table
// source's Datasets and the Metrics and Joins that reach them get one line per (fact, check), written through
// `commitDerived` behind the version fence; no Provider is called; a check whose input conflicts writes no line.
// The judgement of the lines is S03-T06's: the handler only hands the results over. All data is synthetic.
import {
  closeJob,
  createCommitScope,
  findSourceVersionId,
  insertItem,
  leaseNextJob,
  listCheckLines,
  migrate,
  ANALYTICAL_CHECK_JOB_KIND,
  readKnowledgeRevision,
  registerAnalyticalCheckJob,
  registerConnectorInstance,
  saveDatasetTable,
  saveFact,
  saveRelation,
  saveSourceRecord,
  writeSetting,
  type KnowledgeStatus,
  type SqlDriver,
  type StoredCheckLine,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { csvVersion } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAnalyticalCheckHandler,
  type CheckJobHandOver,
  type CheckLineOutcome,
} from "./analytical-check-job.ts";

const T0 = new Date("2026-11-23T00:00:00.000Z");
let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

interface Arrived {
  sourceId: number;
  version: number;
  versionId: number;
}
function arrive(
  id: string,
  rows: readonly (readonly string[])[],
  accessScope?: readonly string[],
): Arrived {
  const v = csvVersion(rows);
  const saved = saveSourceRecord(db, "c1", {
    namespace: "",
    externalId: id,
    title: id,
    body: v.body,
    blocks: v.blocks,
    ...(accessScope ? { accessScope } : {}),
  } as Parameters<typeof saveSourceRecord>[2]);
  if (saved.status !== "created") throw new Error(`not stored: ${saved.status}`);
  return {
    sourceId: saved.sourceId,
    version: saved.version,
    versionId: findSourceVersionId(db, saved.sourceId, saved.version) as number,
  };
}
const attrs = (status: KnowledgeStatus = "candidate") =>
  ({ epistemic: "explicit", status, validAt: null, observedAt: "t" }) as const;
const item = (type: string, name: string) => insertItem(db, { type, name, ...attrs() });
const bind = (name: string, sourceId: number, key = "") => {
  const id = item("Dataset", name);
  saveDatasetTable(db, { itemId: id, sourceId, key, rowCount: 1 });
  return id;
};
const fact = (itemId: number, kind: string, value: string, status: KnowledgeStatus = "candidate") =>
  saveFact(db, { itemId, kind, value, ...attrs(status) }).id;
const rel = (s: number, type: string, o: number) =>
  saveRelation(db, { subjectId: s, type, objectId: o, ...attrs() }).id;

const SALES = [
  ["k", "amount"],
  ["1", "10"],
  ["2", "20"],
] as const;
const CUSTOMERS = [
  ["k", "name"],
  ["1", "x"],
  ["2", "y"],
] as const;

let worlds = 0;
interface World {
  salesId: string;
  a: Arrived;
  b: Arrived;
  d: number;
  d2: number;
  grain: number;
  measure: number;
  metric: number;
  calc: number;
  unit: number;
  join: number;
  keys: number;
  cardinality: number;
}
/** Sales (source a, Dataset d) with a Grain and a measure, a Metric summing `amount`, a Join to customers (b). */
function world(
  options: {
    sales?: readonly (readonly string[])[];
    customers?: readonly (readonly string[])[];
    calc?: string;
    cardinality?: string;
    uses?: boolean;
  } = {},
): World {
  const salesId = `sales-${++worlds}`;
  const a = arrive(salesId, options.sales ?? SALES);
  const b = arrive(`customers-${worlds}`, options.customers ?? CUSTOMERS);
  const d = bind("sales", a.sourceId);
  const d2 = bind("customers", b.sourceId);
  const grain = fact(d, "dataset.grain", '["k"]');
  const measure = fact(d, "dataset.measure", "amount");
  const metric = item("Metric", "m");
  const calc = fact(
    metric,
    "metric.calculation",
    options.calc ?? '{"aggregation":"sum","column":"amount"}',
  );
  const unit = fact(metric, "metric.unit", "won");
  rel(metric, "MEASURED_ON", d);
  const join = item("Join", "j");
  const keys = fact(join, "join.keys", '[["k","k"]]');
  const cardinality = fact(join, "join.cardinality", options.cardinality ?? "many-to-one");
  rel(join, "JOIN_LEFT", d);
  rel(join, "JOIN_RIGHT", d2);
  if (options.uses) rel(metric, "USES_JOIN", join);
  return { salesId, a, b, d, d2, grain, measure, metric, calc, unit, join, keys, cardinality };
}

function run(
  sourceId: number,
  options: {
    judge?: (tx: SqlDriver, handOver: CheckJobHandOver) => void;
    scope?: ReturnType<typeof createCommitScope>;
    between?: () => void;
  } = {},
) {
  registerAnalyticalCheckJob(db, sourceId, T0);
  const job = leaseNextJob(db, { kinds: [ANALYTICAL_CHECK_JOB_KIND], now: T0, leaseMs: 60_000 });
  if (!job) throw new Error("no job queued");
  const handler = createAnalyticalCheckHandler({
    db,
    now: () => T0,
    ...(options.judge ? { judge: options.judge } : {}),
  });
  return handler(job).then((result) => {
    options.between?.();
    if (result.status !== "succeeded") return { job, status: result.status };
    return { job, status: closeJob(db, job, result, T0, options.scope) };
  });
}

const lines = (factId: number): Record<string, StoredCheckLine> =>
  Object.fromEntries(listCheckLines(db, factId).map((l) => [l.check, l]));
const names = (factId: number) => Object.keys(lines(factId));
const outcome = (factId: number, check: string) => {
  const l = lines(factId)[check];
  return l && ([l.passed, l.failure] as const);
};

describe("check.job: the lines", () => {
  it("check.job: writes one line per (fact, check) of the source's Datasets, Metrics and Joins, with the version read", async () => {
    const w = world();
    expect((await run(w.a.sourceId)).status).toBe("succeeded");
    expect(names(w.grain)).toEqual(["grain", "schema"]);
    expect(names(w.measure)).toEqual(["schema"]);
    expect(names(w.calc)).toEqual(["aggregation", "schema"]);
    expect(names(w.keys)).toEqual(["schema"]);
    expect(names(w.cardinality)).toEqual(["join-cardinality"]);
    expect(names(w.unit)).toEqual([]); // a fact kind with no data check
    for (const l of [lines(w.grain).grain, lines(w.calc).schema, lines(w.calc).aggregation]) {
      expect(l).toMatchObject({
        passed: true,
        failure: null,
        versionId: w.a.versionId,
        current: true,
      });
    }
    // a Join's line records both tables (left first); the right table's source is not this job's, still read
    expect(lines(w.cardinality)["join-cardinality"]).toMatchObject({
      versionId: w.a.versionId,
      otherVersionId: w.b.versionId,
    });
    expect(lines(w.keys).schema).toMatchObject({ examined: 2, violations: 0 });
  });

  it("check.job: a failure is a code and counts", async () => {
    const dup = world({
      sales: [
        ["k", "amount"],
        ["1", "10"],
        ["1", "20"],
      ],
      customers: [
        ["k", "name"],
        ["1", "x"],
        ["1", "y"],
      ],
    });
    await run(dup.a.sourceId);
    expect(outcome(dup.grain, "grain")).toEqual([false, "grain-duplicate"]);
    expect(lines(dup.grain).grain).toMatchObject({ examined: 2, violations: 1 });
    expect(outcome(dup.calc, "aggregation")).toEqual([false, "grain-unverified"]);
    expect(outcome(dup.cardinality, "join-cardinality")).toEqual([false, "join-not-unique"]);
  });

  it("check.job: a column the table lacks leaves column-missing", async () => {
    const missing = world({ calc: '{"aggregation":"sum","column":"nope"}' });
    await run(missing.a.sourceId);
    expect(outcome(missing.calc, "schema")).toEqual([false, "column-missing"]);
    expect(outcome(missing.calc, "aggregation")).toEqual([false, "column-missing"]);
  });

  it("check.job: a non-numeric cell leaves non-numeric", async () => {
    const text = world({
      sales: [
        ["k", "amount"],
        ["1", "abc"],
        ["2", "20"],
      ],
    });
    await run(text.a.sourceId);
    expect(outcome(text.calc, "aggregation")).toEqual([false, "non-numeric"]);
  });

  it("check.job: a used Join whose cardinality fails leaves join-unverified, and a repeated opposite key leaves fan-out", async () => {
    const bad = world({
      uses: true,
      customers: [
        ["k", "name"],
        ["1", "x"],
        ["1", "y"],
      ],
    });
    await run(bad.a.sourceId);
    expect(outcome(bad.calc, "aggregation")).toEqual([false, "join-unverified"]);
    const fan = world({
      uses: true,
      cardinality: "many-to-many",
      customers: [
        ["k", "name"],
        ["1", "x"],
        ["1", "y"],
      ],
    });
    await run(fan.a.sourceId);
    expect(outcome(fan.calc, "aggregation")).toEqual([false, "fan-out"]);
    const ok = world({ uses: true });
    await run(ok.a.sourceId);
    expect(outcome(ok.calc, "aggregation")).toEqual([true, null]);
  });

  it("check.job: a Dataset whose table is not in the version leaves no-table, and a table over the limit too-large", async () => {
    const a = arrive("sales", SALES);
    const lost = bind("lost", a.sourceId, "Sheet9");
    const here = bind("here", a.sourceId);
    const f1 = fact(lost, "dataset.grain", '["k"]');
    const f2 = fact(here, "dataset.grain", '["k"]');
    await run(a.sourceId);
    expect(outcome(f1, "grain")).toEqual([false, "no-table"]);
    expect(outcome(f2, "grain")).toEqual([true, null]);
    writeSetting(db, "analytical.maxCells", "1");
    await run(a.sourceId);
    expect(outcome(f2, "grain")).toEqual([false, "too-large"]);
  });

  it("check.job: writes nothing when a newer version of the table arrived meanwhile", async () => {
    const w = world();
    const result = await run(w.a.sourceId, {
      between: () => void arrive(w.salesId, [...SALES, ["3", "30"]]),
    });
    expect(result.status).toBe("superseded");
    expect(db.all("SELECT 1 FROM analytical_checks")).toEqual([]);
  });

  it("check.job: no Provider call", async () => {
    const w = world();
    await run(w.a.sourceId);
    expect(db.all("SELECT 1 FROM provider_calls")).toEqual([]);
    expect(createAnalyticalCheckHandler.length).toBe(1); // one options object, no Broker
  });
});

describe("check.job: only a check whose input conflicts is not computed", () => {
  it("two Grain facts on the Dataset: no aggregation line, the schema line is there", async () => {
    const w = world();
    fact(w.d, "dataset.grain", '["amount"]');
    await run(w.a.sourceId);
    expect(names(w.calc)).toEqual(["schema"]);
  });

  it("two MEASURED_ON targets: neither the schema nor the aggregation line", async () => {
    const w = world();
    rel(w.metric, "MEASURED_ON", w.d2);
    await run(w.a.sourceId);
    expect(names(w.calc)).toEqual([]);
  });

  it("two keys facts or two JOIN_LEFT targets: no join-cardinality line", async () => {
    const twoKeys = world();
    fact(twoKeys.join, "join.keys", '[["name","name"]]');
    await run(twoKeys.a.sourceId);
    expect(names(twoKeys.cardinality)).toEqual([]);
    const twoSides = world();
    rel(twoSides.join, "JOIN_LEFT", twoSides.d2);
    await run(twoSides.a.sourceId);
    expect(names(twoSides.cardinality)).toEqual([]);
    expect(names(twoSides.keys)).toEqual([]); // the keys fact's schema check cannot choose its table either
  });

  it("two unit facts: every line is present", async () => {
    const w = world();
    fact(w.metric, "metric.unit", "dollar");
    await run(w.a.sourceId);
    expect(names(w.calc)).toEqual(["aggregation", "schema"]);
    expect(names(w.grain)).toEqual(["grain", "schema"]);
  });

  it("a line a previous run wrote for a check that is now not computed is removed", async () => {
    const w = world();
    await run(w.a.sourceId);
    expect(names(w.calc)).toEqual(["aggregation", "schema"]);
    rel(w.metric, "MEASURED_ON", w.d2); // the conflict (a row change would erase the lines; here a stale one is left)
    // put the lines back as a run before the conflict would have left them
    db.run(
      `INSERT OR IGNORE INTO analytical_checks (fact_id, check_name, passed, examined, violations, skipped, version_id, checked_at)
       VALUES (?, 'schema', 1, 0, 0, 0, ?, 't'), (?, 'aggregation', 1, 0, 0, 0, ?, 't')`,
      [w.calc, w.a.versionId, w.calc, w.a.versionId],
    );
    await run(w.a.sourceId);
    expect(names(w.calc)).toEqual([]);
  });
});

describe("check.job: a stored value the job cannot use", () => {
  it("a calculation with no column for sum/avg/min/max, an empty or unreadable column list fails with column-missing and never passes", async () => {
    const w = world({ calc: '{"aggregation":"sum"}' });
    db.run("UPDATE facts SET value = '[]' WHERE id = ?", [w.grain]);
    db.run("UPDATE facts SET value = 'not json' WHERE id = ?", [w.keys]);
    db.run("UPDATE facts SET value = '' WHERE id = ?", [w.measure]);
    await run(w.a.sourceId);
    for (const [id, check] of [
      [w.calc, "schema"],
      [w.calc, "aggregation"],
      [w.grain, "schema"],
      [w.grain, "grain"],
      [w.keys, "schema"],
      [w.measure, "schema"],
    ] as const) {
      expect(outcome(id, check), `${id} ${check}`).toEqual([false, "column-missing"]);
    }
  });
});

describe("check.job: versions of a line", () => {
  it("a Join line records both versions; a Metric using Joins on two other sources records none in other_version_id", async () => {
    const w = world({ uses: true });
    const c = arrive("third", CUSTOMERS);
    const d3 = bind("third", c.sourceId);
    const join2 = item("Join", "j2");
    fact(join2, "join.keys", '[["k","k"]]');
    fact(join2, "join.cardinality", "many-to-one");
    rel(join2, "JOIN_LEFT", w.d);
    rel(join2, "JOIN_RIGHT", d3);
    rel(w.metric, "USES_JOIN", join2);
    await run(w.a.sourceId);
    expect(lines(w.cardinality)["join-cardinality"]).toMatchObject({
      otherVersionId: w.b.versionId,
    });
    expect(lines(w.calc).aggregation).toMatchObject({
      versionId: w.a.versionId,
      otherVersionId: null,
    });
  });
});

describe("check.job: the run's end", () => {
  it("a row changed between the read and the write writes nothing and queues the job again", async () => {
    const w = world();
    const result = await run(w.a.sourceId, { between: () => void item("Concept", "late") });
    expect(result.status).toBe("succeeded");
    expect(db.all("SELECT 1 FROM analytical_checks")).toEqual([]);
    expect(
      db.all("SELECT target, status FROM jobs WHERE kind = ? ORDER BY id", [
        ANALYTICAL_CHECK_JOB_KIND,
      ]),
    ).toEqual([
      { target: "run:1", status: "succeeded" },
      { target: "run:2", status: "queued" },
    ]);
    expect(readKnowledgeRevision(db)).toBeGreaterThan(0);
  });

  it("hands the written results and the split record's rows to judge in the closing transaction, and item_split_moves is unchanged", async () => {
    const w = world();
    const moves = db.all("SELECT * FROM item_split_moves");
    const seen: CheckJobHandOver[] = [];
    let readInside = 0;
    await run(w.a.sourceId, {
      judge: (tx, handOver) => {
        seen.push(handOver);
        readInside = tx.all("SELECT 1 FROM analytical_checks").length; // the lines are written already
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toEqual({ sourceId: w.a.sourceId, version: w.a.version });
    expect(seen[0]?.splitMoved).toEqual([]);
    const written = (seen[0]?.results ?? [])
      .map((r: CheckLineOutcome) => `${r.factId}:${r.check}`)
      .sort();
    expect(written).toEqual(
      [
        `${w.grain}:grain`,
        `${w.grain}:schema`,
        `${w.measure}:schema`,
        `${w.calc}:schema`,
        `${w.calc}:aggregation`,
        `${w.keys}:schema`,
        `${w.cardinality}:join-cardinality`,
      ].sort(),
    );
    expect(readInside).toBe(7);
    expect(db.all("SELECT * FROM item_split_moves")).toEqual(moves);
  });

  it("check.scope: under a policy that cannot combine the table's source with the claim's source no line is written for that claim, the other lines are", async () => {
    const a = arrive("sales", SALES, ["x"]);
    const b = arrive("customers", CUSTOMERS, ["y"]);
    const d = bind("sales", a.sourceId);
    const d2 = bind("customers", b.sourceId);
    const grain = fact(d, "dataset.grain", '["k"]');
    const join = item("Join", "j");
    const keys = fact(join, "join.keys", '[["k","k"]]');
    rel(join, "JOIN_LEFT", d);
    rel(join, "JOIN_RIGHT", d2);
    const scope = createCommitScope({
      policy: { combinable: (scopes: readonly unknown[]) => scopes.length <= 1 } as never,
      now: () => T0.toISOString(),
    });
    await run(a.sourceId, { scope });
    expect(names(grain)).toEqual(["grain", "schema"]); // one scope: allowed
    expect(names(keys)).toEqual([]); // x and y together: refused, the fact stays "no check"
    expect(db.all("SELECT kind FROM scope_policy_drops")).not.toEqual([]);
  });

  // a policy that refuses the one-scope lineage [own] but passes the two-scope Join line
  function refuseOwnWorld() {
    const a = arrive("sales", SALES, ["x"]);
    const b = arrive("customers", CUSTOMERS, ["y"]);
    const d = bind("sales", a.sourceId);
    const d2 = bind("customers", b.sourceId);
    const join = item("Join", "j");
    const keys = fact(join, "join.keys", '[["k","k"]]');
    rel(join, "JOIN_LEFT", d);
    rel(join, "JOIN_RIGHT", d2);
    const scope = createCommitScope({
      policy: { combinable: (scopes: readonly unknown[]) => scopes.length !== 1 } as never,
      now: () => T0.toISOString(),
    });
    return { a, keys, scope };
  }

  it("F182-C1: a policy that refuses [own] still lets the sweep detect a change: no stale line is written and the job is queued again", async () => {
    const w = refuseOwnWorld();
    await run(w.a.sourceId, { scope: w.scope, between: () => void item("Concept", "late") });
    expect(db.all("SELECT 1 FROM analytical_checks")).toEqual([]);
    expect(
      db.all("SELECT target, status FROM jobs WHERE kind = ? ORDER BY id", [
        ANALYTICAL_CHECK_JOB_KIND,
      ]),
    ).toEqual([
      { target: "run:1", status: "succeeded" },
      { target: "run:2", status: "queued" },
    ]);
  });

  it("F182-C2: a policy that refuses [own] still erases the line of a check that is no longer computed", async () => {
    const w = world();
    rel(w.metric, "MEASURED_ON", w.d2); // two targets: the metric's checks are not computed
    db.run(
      `INSERT INTO analytical_checks (fact_id, check_name, passed, examined, violations, skipped, version_id, checked_at)
       VALUES (?, 'schema', 1, 0, 0, 0, ?, 't')`,
      [w.calc, w.a.versionId],
    );
    const scope = createCommitScope({
      policy: { combinable: (scopes: readonly unknown[]) => scopes.length !== 1 } as never,
      now: () => T0.toISOString(),
    });
    await run(w.a.sourceId, { scope });
    expect(names(w.calc)).toEqual([]);
  });

  it("check.staleness: a line of the previous version is not current after a new version, and current again after the job of the new version ran", async () => {
    const w = world();
    await run(w.a.sourceId);
    expect(lines(w.grain).grain?.current).toBe(true);
    arrive(w.salesId, [...SALES, ["3", "30"]]);
    expect(lines(w.grain).grain?.current).toBe(false);
    await run(w.a.sourceId);
    expect(lines(w.grain).grain).toMatchObject({ current: true, examined: 3 });
  });
});
