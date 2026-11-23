// The four data checks as pure functions of table values (S03-R10): a table read by the
// TabularSource goes in, a result of a code and counts comes out. No Provider, no store, no
// job: the check job (S03-T05) reads the tables, the facts and the current check lines, and
// calls these. A result carries codes and counts only, never a cell value, a repeated key
// or a sum (S03 decision 10). `examined` is the rows looked at, `violations` the rows
// that broke the rule, `skipped` the rows left out because their cell was empty.
import { isNumberText } from "@pki/contracts";
import type { Table, TableRead } from "./tabular-source.ts";

export type DataCheck = "schema" | "grain" | "join-cardinality" | "aggregation";
export type CheckFailure =
  | "no-table"
  | "column-missing"
  | "grain-empty"
  | "grain-duplicate"
  | "join-not-unique"
  | "non-numeric"
  | "grain-unverified"
  | "join-unverified"
  | "fan-out"
  | "too-large";
export interface CheckResult {
  check: DataCheck;
  passed: boolean;
  failure: CheckFailure | null;
  examined: number;
  violations: number;
  skipped: number;
}

export type Aggregation = "sum" | "count" | "count_distinct" | "avg" | "min" | "max";
export type JoinCardinality = "one-to-one" | "many-to-one" | "one-to-many" | "many-to-many";

const result = (
  check: DataCheck,
  failure: CheckFailure | null,
  examined = 0,
  violations = 0,
  skipped = 0,
): CheckResult => ({ check, passed: failure === null, failure, examined, violations, skipped });

/** The table, or why there is none: a table over the limit is `too-large`, anything else `no-table` (S03-R12). */
function tableOf(read: TableRead | undefined): Table | "no-table" | "too-large" {
  if (read === undefined) return "no-table";
  if ("table" in read) return read.table;
  return read.reason === "too-large" ? "too-large" : "no-table";
}

/** The positions of the named columns in the table's rows, or undefined if one is missing. */
function positions(table: Table, names: readonly string[]): number[] | undefined {
  const found = names.map((n) => table.columns.findIndex((c) => c.name === n));
  return found.includes(-1) ? undefined : found;
}

/** A key as one string: the JSON of the array keeps ("a b","c") apart from ("a","b c"). */
const keyOf = (row: readonly (string | null)[], at: readonly number[]): string =>
  JSON.stringify(at.map((i) => row[i]));

/** Rows with a key (examined), rows whose key has an empty cell (skipped), and key repeats (duplicates). */
function keyRepeats(table: Table, at: readonly number[]) {
  const seen = new Set<string>();
  let examined = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const row of table.rows()) {
    if (at.some((i) => row[i] === null)) {
      skipped++;
      continue;
    }
    examined++;
    const key = keyOf(row, at);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return { examined, skipped, duplicates };
}

/**
 * `schema`: every named (processed) column is in the table's header row. An empty list passes: a column-less
 * `count` calls it so; that a list is required is the caller's knowledge (`normalizeValue`).
 */
export function checkSchema(read: TableRead | undefined, columns: readonly string[]): CheckResult {
  const table = tableOf(read);
  if (typeof table === "string") return result("schema", table);
  const missing = columns.filter((n) => !table.columns.some((c) => c.name === n)).length;
  return result("schema", missing > 0 ? "column-missing" : null, columns.length, missing);
}

/** `grain`: no empty cell in the grain columns, and no two rows with the same grain. */
export function checkGrain(read: TableRead | undefined, grain: readonly string[]): CheckResult {
  const table = tableOf(read);
  if (typeof table === "string") return result("grain", table);
  const at = grain.length === 0 ? undefined : positions(table, grain);
  if (at === undefined) return result("grain", "column-missing");
  const seen = new Set<string>();
  let rows = 0;
  let empty = 0;
  let duplicates = 0;
  for (const row of table.rows()) {
    rows++;
    if (at.some((i) => row[i] === null)) {
      empty++;
      continue;
    }
    const key = keyOf(row, at);
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  if (empty > 0) return result("grain", "grain-empty", rows, empty);
  if (duplicates > 0) return result("grain", "grain-duplicate", rows, duplicates);
  return result("grain", null, rows);
}

/**
 * `join-cardinality`: the key columns are in both tables, and the side(s) the claim calls
 * "one" have no repeated key (`many-to-one`: right, `one-to-many`: left, `one-to-one`:
 * both). `keys` are (left column, right column) pairs. A stricter truth than the claim
 * passes; `many-to-many` needs only the columns. Rows with an empty key are skipped.
 */
export function checkJoinCardinality(
  leftRead: TableRead | undefined,
  rightRead: TableRead | undefined,
  keys: readonly (readonly [string, string])[],
  claim: JoinCardinality,
): CheckResult {
  const left = tableOf(leftRead);
  const right = tableOf(rightRead);
  if (typeof left === "string") return result("join-cardinality", left);
  if (typeof right === "string") return result("join-cardinality", right);
  const leftAt = positions(
    left,
    keys.map(([l]) => l),
  );
  const rightAt = positions(
    right,
    keys.map(([, r]) => r),
  );
  if (keys.length === 0 || leftAt === undefined || rightAt === undefined) {
    return result("join-cardinality", "column-missing");
  }
  const sides = [
    ...(claim === "one-to-many" || claim === "one-to-one" ? [keyRepeats(left, leftAt)] : []),
    ...(claim === "many-to-one" || claim === "one-to-one" ? [keyRepeats(right, rightAt)] : []),
  ];
  const sum = (pick: (s: (typeof sides)[number]) => number) =>
    sides.reduce((n, s) => n + pick(s), 0);
  const [examined, skipped, duplicates] = [
    sum((s) => s.examined),
    sum((s) => s.skipped),
    sum((s) => s.duplicates),
  ];
  return result(
    "join-cardinality",
    duplicates > 0 ? "join-not-unique" : null,
    examined,
    duplicates,
    skipped,
  );
}

/** One Join a Metric uses (S03-R10 ③), as the check job found it. */
export interface JoinUse {
  /** The Join's `join-cardinality` check has a current line and it passed. */
  passed: boolean;
  /** The Metric's Dataset is one side of the Join. */
  datasetIsSide: boolean;
  /** The table on the other side, and its key columns of the Join (processed names). */
  opposite: TableRead | undefined;
  oppositeKeyColumns: readonly string[];
}

export interface AggregationInput {
  table: TableRead | undefined;
  aggregation: Aggregation;
  /** Absent only for `count` (the number of rows). */
  column: string | undefined;
  /** The Dataset's Grain check has a current line and it passed. */
  grainPassed: boolean;
  joins: readonly JoinUse[];
}

/** Aggregations that count a row once per matching row of the Join, so a repeated opposite key inflates them. */
const FAN_OUT_AGGREGATIONS: ReadonlySet<Aggregation> = new Set(["sum", "count", "avg"]);
const NUMERIC_AGGREGATIONS: ReadonlySet<Aggregation> = new Set(["sum", "avg", "min", "max"]);

/**
 * `aggregation`, in the order of S03-R10: ① a numeric aggregation's column holds only
 * numbers (S03-R3's grammar; empty cells are skipped) ② the Dataset's grain is verified
 * ③ each Join used is verified, the Dataset is one of its sides, and for `sum`, `count`
 * and `avg` the opposite key does not repeat. The first one that fails is the result.
 */
export function checkAggregation(input: AggregationInput): CheckResult {
  const table = tableOf(input.table);
  if (typeof table === "string") return result("aggregation", table);
  if (input.column === undefined && input.aggregation !== "count") {
    return result("aggregation", "column-missing");
  }
  let at: number | undefined;
  if (input.column !== undefined) {
    at = positions(table, [input.column])?.[0];
    if (at === undefined) return result("aggregation", "column-missing");
  }
  let examined = table.rowCount;
  let violations = 0;
  let skipped = 0;
  if (at !== undefined && NUMERIC_AGGREGATIONS.has(input.aggregation)) {
    examined = 0;
    for (const row of table.rows()) {
      const cell = row[at] ?? null;
      if (cell === null) skipped++;
      else {
        examined++;
        if (!isNumberText(cell)) violations++;
      }
    }
    if (violations > 0) return result("aggregation", "non-numeric", examined, violations, skipped);
  }
  if (!input.grainPassed) return result("aggregation", "grain-unverified");
  let fanOut = 0;
  for (const join of input.joins) {
    const opposite = tableOf(join.opposite);
    const keyAt =
      typeof opposite === "string" ? undefined : positions(opposite, join.oppositeKeyColumns);
    if (!join.passed || !join.datasetIsSide || typeof opposite === "string" || !keyAt?.length) {
      return result("aggregation", "join-unverified");
    }
    if (FAN_OUT_AGGREGATIONS.has(input.aggregation) && keyRepeats(opposite, keyAt).duplicates > 0) {
      fanOut++;
    }
  }
  if (fanOut > 0) return result("aggregation", "fan-out", input.joins.length, fanOut);
  return result("aggregation", null, examined, 0, skipped);
}
