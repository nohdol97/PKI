// S03-T06 `gate.user-approve` / `gate.lost` (S03-R13 to R16, G-C1 .. G-C4 ②): the data conditions of a
// check-needing fact, the user's approval refused while one is unmet, a direct add and a value fix that make a
// candidate, and the path cut that takes a verified row's table away. All data is synthetic.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { dataChecksUnmet } from "./analytical-gate.ts";
import {
  dataset,
  fact,
  item,
  line,
  relation,
  storeVersion,
} from "./analytical-check-lines.test-support.ts";
import { listCheckLines } from "./analytical-check-lines.ts";
import { readFact } from "./knowledge.ts";
import { migrate } from "./migrations.ts";
import { userDecisions } from "./semantic-user.ts";
import { registerConnectorInstance } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const CALC = '{"aggregation":"sum","column":"a"}';
const history = (factId: number) =>
  db.all("SELECT * FROM fact_history WHERE fact_id = ? ORDER BY seq", [factId]);

/** A Metric measured on a Dataset bound to one table source, its calculation fact and its two passing lines. */
function world(status: "candidate" | "verified" = "candidate") {
  const table = storeVersion(db, "t1");
  const d = dataset(db, "d", table.sourceId);
  const metric = item(db, "Metric", "m");
  const measured = relation(db, metric, "MEASURED_ON", d);
  const calc = fact(db, metric, "metric.calculation", CALC, status);
  line(db, calc, "schema", table.versionId);
  line(db, calc, "aggregation", table.versionId);
  return { table, d, metric, measured, calc };
}

describe("gate.user-approve", () => {
  it("G-C1: the data conditions are unmet by a rival value and a stale line, and met when bound, unrivalled and checked; a kind with no checks has none", () => {
    const w = world();
    expect(dataChecksUnmet(db, { kind: "fact", id: w.calc })).toEqual([]);
    const unit = fact(db, w.metric, "metric.unit", "won");
    expect(dataChecksUnmet(db, { kind: "fact", id: unit })).toEqual([]); // no `dataChecks` in its rule

    // a second valid unit (the user wrote both) and a new table version the lines did not read
    userDecisions.add(db, {
      kind: "fact",
      itemId: w.metric,
      factKind: "metric.unit",
      value: "KRW",
    });
    userDecisions.add(db, {
      kind: "fact",
      itemId: w.metric,
      factKind: "metric.unit",
      value: "USD",
    });
    storeVersion(db, "t1");
    expect(dataChecksUnmet(db, { kind: "fact", id: w.calc })).toEqual([
      "spec-conflict",
      "check-missing",
    ]);
  });

  it("G-C1: the user's approval of a fact with an unmet condition is refused with every name and changes nothing; once the line passes it is verified and the lines stay", () => {
    const w = world();
    const next = storeVersion(db, "t1"); // the lines read the version before this one
    const before = history(w.calc);
    expect(userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve")).toEqual({
      status: "refused",
      reason: "data-check-unmet",
      unmet: ["check-missing"],
    });
    expect(history(w.calc)).toEqual(before);
    expect(readFact(db, w.calc)?.status).toBe("candidate");

    line(db, w.calc, "schema", next.versionId);
    line(db, w.calc, "aggregation", next.versionId);
    expect(userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve")).toMatchObject({
      status: "applied",
    });
    expect(readFact(db, w.calc)).toMatchObject({ status: "verified", epistemic: "user-approved" });
    expect(listCheckLines(db, w.calc)).toHaveLength(2);
  });

  it("G-C2: a direct add and a value fix of a kind with checks make a candidate hypothesis the user wrote; a kind with none stays verified", () => {
    const w = world("verified");
    const added = userDecisions.add(db, {
      kind: "fact",
      itemId: w.metric,
      factKind: "metric.calculation",
      value: '{"aggregation":"count"}',
    });
    if (added.status !== "applied") throw new Error("not added");
    expect(
      db.all("SELECT status, epistemic, user_authored FROM facts WHERE id = ?", [added.ref.id]),
    ).toEqual([{ status: "candidate", epistemic: "hypothesis", user_authored: 1 }]);

    const fixed = userDecisions.replaceValue(
      db,
      { kind: "fact", id: w.calc },
      '{"aggregation":"avg","column":"a"}',
    );
    if (fixed.status !== "applied") throw new Error("not replaced");
    expect(readFact(db, fixed.added.id)).toMatchObject({
      status: "candidate",
      epistemic: "hypothesis",
    });
    expect(readFact(db, w.calc)?.status).toBe("superseded");

    const unit = userDecisions.add(db, {
      kind: "fact",
      itemId: w.metric,
      factKind: "metric.unit",
      value: "won",
    });
    if (unit.status !== "applied") throw new Error("not added");
    expect(readFact(db, unit.ref.id)).toMatchObject({
      status: "verified",
      epistemic: "user-approved",
    });
  });
});

describe("gate.lost", () => {
  it("G-C4 (②): the user's rejection of the only MEASURED_ON of a verified calculation disputes it in the same transaction, with the table version as the basis", () => {
    const w = world();
    expect(userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve").status).toBe(
      "applied",
    );
    expect(userDecisions.decide(db, { kind: "relation", id: w.measured }, "reject").status).toBe(
      "applied",
    );
    expect(readFact(db, w.calc)?.status).toBe("disputed");
    expect(history(w.calc).at(-1)).toMatchObject({
      actor: "policy",
      action: "dispute",
      from_status: "verified",
      to_status: "disputed",
      reason: "data-basis-lost",
      basis_source_id: w.table.sourceId,
      basis_version: w.table.version,
    });
  });

  it("G-C4: a stray candidate MEASURED_ON to an unbound Dataset beside a bound one does not make a verified calculation lose its table at a judgement point", () => {
    const w = world();
    expect(userDecisions.decide(db, { kind: "fact", id: w.calc }, "approve").status).toBe(
      "applied",
    );
    const stray = item(db, "Dataset", "stray"); // no table bound
    relation(db, w.metric, "MEASURED_ON", stray);
    // the judgement point: a user cut of another path relation whose object has a table (the basis)
    const second = dataset(db, "second", storeVersion(db, "t2").sourceId);
    const extra = relation(db, w.metric, "MEASURED_ON", second);
    expect(userDecisions.decide(db, { kind: "relation", id: extra }, "reject").status).toBe(
      "applied",
    );
    expect(readFact(db, w.calc)?.status).toBe("verified");
  });
});
