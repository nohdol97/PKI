// S03-C2 `checks.schema`, `checks.grain`, `checks.join`, `checks.aggregation` (S03-R10):
// the four checks as pure functions of table values. Every guard has a case that turns
// red when its line is removed (mutation-checked, see the task report).
import { describe, expect, it } from "vitest";
import {
  checkAggregation,
  checkGrain,
  checkJoinCardinality,
  checkSchema,
  type CheckResult,
  type JoinUse,
} from "./analytical-checks.ts";
import type { TableRead } from "./tabular-source.ts";

/** A table read from a grid: `cols` are the processed header names, `rows` the data rows. */
function table(cols: string[], rows: (string | null)[][], key = ""): TableRead {
  return {
    key,
    table: {
      key,
      columns: cols.map((name, i) => ({ index: i + 1, name, span: { start: 0, end: 1 } })),
      rowCount: rows.length,
      cellsOutsideHeader: 0,
      rows: () => rows,
    },
  };
}
const notTable = (reason: "no-header" | "no-rows" | "too-large"): TableRead => ({
  key: "",
  reason,
});
const pass = (r: CheckResult) => [r.passed, r.failure];

describe("checks.schema", () => {
  const t = table(["id", "amount"], [["1", "5"]]);
  it("passes when every column is in the header", () => {
    expect(checkSchema(t, ["id", "amount"])).toEqual({
      check: "schema",
      passed: true,
      failure: null,
      examined: 2,
      violations: 0,
      skipped: 0,
    });
  });
  it("an empty column list passes with examined 0 (a column-less count)", () => {
    const r = checkSchema(t, []);
    expect([r.passed, r.examined]).toEqual([true, 0]);
  });
  it("fails column-missing and counts the missing ones", () => {
    const r = checkSchema(t, ["id", "nope", "gone"]);
    expect(pass(r)).toEqual([false, "column-missing"]);
    expect([r.examined, r.violations]).toEqual([3, 2]);
  });
  it("fails no-table with no table, or a read that is not a table", () => {
    expect(pass(checkSchema(undefined, ["id"]))).toEqual([false, "no-table"]);
    expect(pass(checkSchema(notTable("no-header"), ["id"]))).toEqual([false, "no-table"]);
    expect(pass(checkSchema(notTable("no-rows"), ["id"]))).toEqual([false, "no-table"]);
  });
  it("fails too-large for a table over the limit (S03-R12)", () => {
    expect(pass(checkSchema(notTable("too-large"), ["id"]))).toEqual([false, "too-large"]);
  });
});

describe("checks.grain", () => {
  it("passes a table whose rows differ on the grain", () => {
    const r = checkGrain(
      table(
        ["a", "b"],
        [
          ["1", "x"],
          ["2", "x"],
        ],
      ),
      ["a"],
    );
    expect(r).toMatchObject({
      passed: true,
      failure: null,
      examined: 2,
      violations: 0,
      skipped: 0,
    });
  });
  it("fails grain-duplicate and counts the rows that repeat an earlier one", () => {
    const r = checkGrain(table(["a"], [["1"], ["2"], ["1"], ["1"]]), ["a"]);
    expect(pass(r)).toEqual([false, "grain-duplicate"]);
    expect([r.examined, r.violations]).toEqual([4, 2]);
  });
  it("fails grain-empty for a row with an empty grain cell, counted", () => {
    const r = checkGrain(
      table(
        ["a", "b"],
        [
          ["1", "x"],
          [null, "y"],
          ["3", null],
        ],
      ),
      ["a"],
    );
    expect(pass(r)).toEqual([false, "grain-empty"]);
    expect([r.examined, r.violations]).toEqual([3, 1]);
  });
  it("reports grain-empty before grain-duplicate", () => {
    const r = checkGrain(table(["a"], [[null], ["1"], ["1"]]), ["a"]);
    expect(r.failure).toBe("grain-empty");
  });
  it("passes when two columns together are unique", () => {
    const rows = [
      ["1", "x"],
      ["1", "y"],
      ["2", "x"],
    ];
    expect(pass(checkGrain(table(["a", "b"], rows), ["a"]))).toEqual([false, "grain-duplicate"]);
    expect(pass(checkGrain(table(["a", "b"], rows), ["a", "b"]))).toEqual([true, null]);
  });
  it("tells ('a b', 'c') from ('a', 'b c') as different keys", () => {
    const r = checkGrain(
      table(
        ["a", "b"],
        [
          ["a b", "c"],
          ["a", "b c"],
        ],
      ),
      ["a", "b"],
    );
    expect(r.passed).toBe(true);
  });
  it("fails column-missing for a grain column the table lacks, or no grain column", () => {
    expect(pass(checkGrain(table(["a"], [["1"]]), ["a", "z"]))).toEqual([false, "column-missing"]);
    expect(pass(checkGrain(table(["a"], [["1"]]), []))).toEqual([false, "column-missing"]);
  });
  it("fails no-table and too-large", () => {
    expect(pass(checkGrain(undefined, ["a"]))).toEqual([false, "no-table"]);
    expect(pass(checkGrain(notTable("no-rows"), ["a"]))).toEqual([false, "no-table"]);
    expect(pass(checkGrain(notTable("too-large"), ["a"]))).toEqual([false, "too-large"]);
  });
});

describe("checks.join", () => {
  const left = table(
    ["id", "name"],
    [
      ["1", "a"],
      ["2", "b"],
      ["2", "c"],
    ],
  );
  const right = table(["id"], [["1"], ["2"], ["3"]]);
  const keys: [string, string][] = [["id", "id"]];

  it("many-to-one fails join-not-unique when the right key repeats", () => {
    const dup = table(["id"], [["1"], ["1"], ["2"]]);
    const r = checkJoinCardinality(left, dup, keys, "many-to-one");
    expect(pass(r)).toEqual([false, "join-not-unique"]);
    expect([r.examined, r.violations, r.skipped]).toEqual([3, 1, 0]);
  });
  it("many-to-one passes when the right key is unique, whatever the left holds", () => {
    expect(pass(checkJoinCardinality(left, right, keys, "many-to-one"))).toEqual([true, null]);
  });
  it("one-to-many looks at the left, one-to-one at both", () => {
    expect(pass(checkJoinCardinality(left, right, keys, "one-to-many"))).toEqual([
      false,
      "join-not-unique",
    ]);
    const unique = table(["id"], [["1"], ["2"]]);
    expect(pass(checkJoinCardinality(left, unique, keys, "one-to-one"))).toEqual([
      false,
      "join-not-unique",
    ]);
    expect(pass(checkJoinCardinality(right, unique, keys, "one-to-one"))).toEqual([true, null]);
  });
  it("one-to-one fails when only the right key repeats", () => {
    const dupRight = table(["id"], [["1"], ["1"]]);
    expect(pass(checkJoinCardinality(unique(), dupRight, keys, "one-to-one"))).toEqual([
      false,
      "join-not-unique",
    ]);
  });
  it("passes a claim looser than the facts (actual 1:1 claimed many-to-one)", () => {
    expect(pass(checkJoinCardinality(right, unique(), keys, "many-to-one"))).toEqual([true, null]);
  });
  it("many-to-many passes when the key columns exist and fails column-missing otherwise", () => {
    const dup = table(["id"], [["1"], ["1"]]);
    expect(pass(checkJoinCardinality(dup, dup, keys, "many-to-many"))).toEqual([true, null]);
    expect(pass(checkJoinCardinality(dup, dup, [["id", "zz"]], "many-to-many"))).toEqual([
      false,
      "column-missing",
    ]);
    expect(pass(checkJoinCardinality(dup, dup, [["zz", "id"]], "many-to-many"))).toEqual([
      false,
      "column-missing",
    ]);
  });
  it("counts rows with an empty key as skipped and leaves them out of uniqueness", () => {
    const withEmpty = table(["id"], [["1"], [null], [null], ["2"]]);
    const r = checkJoinCardinality(left, withEmpty, keys, "many-to-one");
    expect(pass(r)).toEqual([true, null]);
    expect([r.examined, r.violations, r.skipped]).toEqual([2, 0, 2]);
  });
  it("compares the whole key of a two-column key", () => {
    const l = table(["a", "b"], [["1", "x"]]);
    const r = table(
      ["a", "b"],
      [
        ["1", "x"],
        ["1", "y"],
      ],
    );
    const two: [string, string][] = [
      ["a", "a"],
      ["b", "b"],
    ];
    expect(pass(checkJoinCardinality(l, r, two, "many-to-one"))).toEqual([true, null]);
    expect(pass(checkJoinCardinality(l, r, [["a", "a"]], "many-to-one"))).toEqual([
      false,
      "join-not-unique",
    ]);
  });
  it("fails no-table and too-large for either side, column-missing for a key column", () => {
    expect(pass(checkJoinCardinality(undefined, right, keys, "many-to-one"))).toEqual([
      false,
      "no-table",
    ]);
    expect(pass(checkJoinCardinality(left, notTable("no-header"), keys, "many-to-one"))).toEqual([
      false,
      "no-table",
    ]);
    expect(pass(checkJoinCardinality(left, notTable("too-large"), keys, "many-to-one"))).toEqual([
      false,
      "too-large",
    ]);
    expect(pass(checkJoinCardinality(left, right, [["id", "zz"]], "many-to-one"))).toEqual([
      false,
      "column-missing",
    ]);
    expect(pass(checkJoinCardinality(left, right, [["zz", "id"]], "many-to-one"))).toEqual([
      false,
      "column-missing",
    ]);
  });
  function unique() {
    return table(["id"], [["1"], ["2"]]);
  }
});

describe("checks.aggregation", () => {
  const grainOk = { grainPassed: true } as const;
  const sales = (cells: (string | null)[]) =>
    table(
      ["g", "v"],
      cells.map((v, i) => [String(i), v]),
    );
  const run = (
    t: TableRead | undefined,
    aggregation: Parameters<typeof checkAggregation>[0]["aggregation"],
    column: string | undefined = "v",
    extra: Partial<Parameters<typeof checkAggregation>[0]> = {},
  ) => checkAggregation({ table: t, aggregation, column, ...grainOk, joins: [], ...extra });

  it("sum fails non-numeric on 1,000 and counts it; count on the same column passes", () => {
    const t = sales(["1000", "1,000", null]);
    const r = run(t, "sum");
    expect(pass(r)).toEqual([false, "non-numeric"]);
    expect([r.examined, r.violations, r.skipped]).toEqual([2, 1, 1]);
    expect(pass(run(t, "count"))).toEqual([true, null]);
    expect(pass(run(t, "count_distinct"))).toEqual([true, null]);
  });
  it.each(["sum", "avg", "min", "max"] as const)("%s needs numbers", (a) => {
    expect(pass(run(sales(["x"]), a))).toEqual([false, "non-numeric"]);
  });
  it("passes sum over ' 42', '-3', '1e3', '1000.50'", () => {
    const r = run(sales([" 42", "-3", "1e3", "1000.50"]), "sum");
    expect(pass(r)).toEqual([true, null]);
    expect([r.examined, r.violations, r.skipped]).toEqual([4, 0, 0]);
  });
  it("fails grain-unverified when the Dataset's grain check is not a current pass", () => {
    expect(pass(run(sales(["1"]), "sum", "v", { grainPassed: false }))).toEqual([
      false,
      "grain-unverified",
    ]);
  });
  it("count needs no column but the grain; a named column must exist", () => {
    expect(pass(run(sales(["1"]), "count", undefined, { column: undefined }))).toEqual([
      true,
      null,
    ]);
    expect(pass(run(sales(["1"]), "sum", "zz"))).toEqual([false, "column-missing"]);
    expect(pass(run(sales(["1"]), "sum", undefined, { column: undefined }))).toEqual([
      false,
      "column-missing",
    ]);
    expect(pass(run(sales(["1"]), "max", undefined, { column: undefined }))).toEqual([
      false,
      "column-missing",
    ]);
    expect(pass(run(sales(["1"]), "count_distinct", undefined, { column: undefined }))).toEqual([
      false,
      "column-missing",
    ]);
    expect(pass(run(undefined, "sum"))).toEqual([false, "no-table"]);
    expect(pass(run(notTable("too-large"), "sum"))).toEqual([false, "too-large"]);
  });
  it("reports non-numeric before grain-unverified", () => {
    expect(run(sales(["x"]), "sum", "v", { grainPassed: false }).failure).toBe("non-numeric");
  });

  const dimDup = table(["id"], [["1"], ["1"]]);
  const dimUnique = table(["id"], [["1"], ["2"]]);
  const join = (over: Partial<JoinUse> = {}): JoinUse => ({
    passed: true,
    datasetIsSide: true,
    opposite: dimDup,
    oppositeKeyColumns: ["id"],
    ...over,
  });
  it("fails fan-out for sum, count and avg when the opposite key repeats, not for max", () => {
    for (const a of ["sum", "count", "avg"] as const) {
      const r = run(sales(["1"]), a, a === "count" ? undefined : "v", { joins: [join()] });
      expect(pass(r)).toEqual([false, "fan-out"]);
      expect([r.examined, r.violations]).toEqual([1, 1]);
    }
    for (const a of ["max", "min", "count_distinct"] as const) {
      expect(pass(run(sales(["1"]), a, "v", { joins: [join()] }))).toEqual([true, null]);
    }
  });
  it("passes sum through a Join whose opposite key is unique", () => {
    expect(pass(run(sales(["1"]), "sum", "v", { joins: [join({ opposite: dimUnique })] }))).toEqual(
      [true, null],
    );
  });
  it("fails join-unverified: Join check not passed, Dataset not a side, opposite unreadable", () => {
    const cases: Partial<JoinUse>[] = [
      { passed: false },
      { datasetIsSide: false },
      { opposite: undefined },
      { opposite: notTable("too-large") },
      { oppositeKeyColumns: ["zz"] },
    ];
    for (const c of cases) {
      expect(pass(run(sales(["1"]), "sum", "v", { joins: [join(c)] }))).toEqual([
        false,
        "join-unverified",
      ]);
    }
  });
  it("judges every Join: one unverified among several fails", () => {
    const r = run(sales(["1"]), "max", "v", { joins: [join(), join({ passed: false })] });
    expect(r.failure).toBe("join-unverified");
  });
  it("the opposite key's empty cells are not duplicates", () => {
    const opp = table(["id"], [[null], [null], ["1"]]);
    expect(pass(run(sales(["1"]), "sum", "v", { joins: [join({ opposite: opp })] }))).toEqual([
      true,
      null,
    ]);
  });
});

describe("results carry counts and codes only (S03 decision 10)", () => {
  it("has exactly the six fields and none of the cell values", () => {
    const secret = "SECRET-CELL-VALUE";
    const t = table(["a"], [[secret], [secret]]);
    const results = [
      checkGrain(t, ["a"]),
      checkSchema(t, ["a", "b"]),
      checkJoinCardinality(t, t, [["a", "a"]], "many-to-one"),
      checkAggregation({ table: t, aggregation: "sum", column: "a", grainPassed: true, joins: [] }),
    ];
    for (const r of results) {
      expect(Object.keys(r).sort()).toEqual(
        ["check", "examined", "failure", "passed", "skipped", "violations"].sort(),
      );
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});
