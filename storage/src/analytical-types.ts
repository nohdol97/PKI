// The analytical type definitions' initial values (S03-R2), the nine value types with their
// normalisation (S03-R3) and the checks a value type demands of a fact kind's rule (S03-R13).
// Constants and functions only: the migration that writes the seeds is S03-T04's, and it copies these
// values (a migration keeps its own copy, as S02's does). The catalogue in `@pki/contracts` lists the same
// names with the edition that added them; `analytical.value-types` and `ontology.analytical-seeds` compare
// the two. Nothing here reads or writes a table.
import type { DataCheckName, FactValueType } from "@pki/contracts";
import type { ElementRule } from "./ontology.ts";

export const ANALYTICAL_VALUE_TYPES = [
  "header",
  "column",
  "column-set",
  "calculation",
  "key-pairs",
  "join-cardinality",
  "period",
  "currency",
  "dataset-role",
] as const satisfies readonly FactValueType[];
export type AnalyticalValueType = (typeof ANALYTICAL_VALUE_TYPES)[number];

/** The checks a value type needs in `dataChecks` (`required`) and may add (`optional`); the others need none. */
export const REQUIRED_DATA_CHECKS: Readonly<
  Partial<
    Record<
      FactValueType,
      { required: readonly DataCheckName[]; optional: readonly DataCheckName[] }
    >
  >
> = {
  column: { required: ["schema"], optional: [] },
  "key-pairs": { required: ["schema"], optional: [] },
  "column-set": { required: ["schema"], optional: ["grain"] },
  calculation: { required: ["schema", "aggregation"], optional: [] },
  "join-cardinality": { required: ["join-cardinality"], optional: [] },
};

const dated = (
  itemTypes: readonly string[],
  valueType: FactValueType,
  cardinality: "one" | "many",
  dataChecks?: readonly DataCheckName[],
): ElementRule => ({
  elementKind: "fact-kind",
  itemTypes,
  valueType,
  cardinality,
  ...(dataChecks ? { dataChecks } : {}),
});
const item: ElementRule = { elementKind: "item-type" };
const link = (subject: string, object: string): ElementRule => ({
  elementKind: "relation-type",
  subjectTypes: [subject],
  objectTypes: [object],
  symmetric: false,
});

/** S03-R2's table, in its order; `origin` is `seed` for every row. */
export const ANALYTICAL_SEED: readonly {
  elementKind: "item-type" | "fact-kind" | "relation-type";
  name: string;
  rule: ElementRule;
}[] = [
  { elementKind: "item-type", name: "Dataset", rule: item },
  { elementKind: "item-type", name: "Metric", rule: item },
  { elementKind: "item-type", name: "Join", rule: item },
  { elementKind: "fact-kind", name: "dataset.column", rule: dated(["Dataset"], "header", "many") },
  {
    elementKind: "fact-kind",
    name: "dataset.role",
    rule: dated(["Dataset"], "dataset-role", "one"),
  },
  {
    elementKind: "fact-kind",
    name: "dataset.grain",
    rule: dated(["Dataset"], "column-set", "one", ["schema", "grain"]),
  },
  ...["dataset.measure", "dataset.dimension", "dataset.time_dimension"].map((name) => ({
    elementKind: "fact-kind" as const,
    name,
    rule: dated(["Dataset"], "column", "many", ["schema"]),
  })),
  {
    elementKind: "fact-kind",
    name: "metric.calculation",
    rule: dated(["Metric"], "calculation", "one", ["schema", "aggregation"]),
  },
  { elementKind: "fact-kind", name: "metric.unit", rule: dated(["Metric"], "text", "one") },
  { elementKind: "fact-kind", name: "metric.version", rule: dated(["Metric"], "text", "one") },
  { elementKind: "fact-kind", name: "metric.currency", rule: dated(["Metric"], "currency", "one") },
  { elementKind: "fact-kind", name: "metric.period", rule: dated(["Metric"], "period", "one") },
  {
    elementKind: "fact-kind",
    name: "join.keys",
    rule: dated(["Join"], "key-pairs", "one", ["schema"]),
  },
  {
    elementKind: "fact-kind",
    name: "join.cardinality",
    rule: dated(["Join"], "join-cardinality", "one", ["join-cardinality"]),
  },
  { elementKind: "relation-type", name: "MEASURED_ON", rule: link("Metric", "Dataset") },
  { elementKind: "relation-type", name: "JOIN_LEFT", rule: link("Join", "Dataset") },
  { elementKind: "relation-type", name: "JOIN_RIGHT", rule: link("Join", "Dataset") },
  { elementKind: "relation-type", name: "USES_JOIN", rule: link("Metric", "Join") },
];

/**
 * A column name in the processed form of V02-R7: Unicode NFKC, one case, white space collapsed and
 * trimmed. The same processing as `normalizeForLinking` in knowledge-engine (`storage` cannot call it).
 */
export const normalizeColumnName = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

const MAX_NAME = 200;
/** One processed column name, or null: empty, or over 200 code points. */
function columnName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = normalizeColumnName(raw);
  return name === "" || [...name].length > MAX_NAME ? null : name;
}

/** A structured value as given: a JSON text is parsed, anything else is taken as it is. */
function structured(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const AGGREGATIONS: readonly string[] = ["sum", "count", "count_distinct", "avg", "min", "max"];
const CARDINALITIES: readonly string[] = [
  "one-to-one",
  "many-to-one",
  "one-to-many",
  "many-to-many",
];
const PERIODS: readonly string[] = ["day", "week", "month", "quarter", "year"];
const ROLES: readonly string[] = ["fact", "dimension"];
let currencies: ReadonlySet<string> | undefined;
const knownCurrency = (code: string): boolean => {
  currencies ??= new Set(Intl.supportedValuesOf("currency"));
  return currencies.has(code);
};
const closed = (list: readonly string[], raw: unknown): string | null =>
  typeof raw === "string" && list.includes(raw) ? raw : null;

function columnSet(raw: unknown): string | null {
  const list = structured(raw);
  if (!Array.isArray(list) || list.length === 0) return null;
  const names = list.map(columnName);
  if (names.some((n) => n === null)) return null;
  const unique = new Set(names as string[]);
  return unique.size === names.length ? JSON.stringify([...unique].sort()) : null;
}

function keyPairs(raw: unknown): string | null {
  const list = structured(raw);
  if (!Array.isArray(list) || list.length === 0) return null;
  const pairs: string[] = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [left, right] = [columnName(pair[0]), columnName(pair[1])];
    if (left === null || right === null) return null;
    pairs.push(JSON.stringify([left, right]));
  }
  return new Set(pairs).size === pairs.length ? `[${pairs.sort().join(",")}]` : null;
}

/** One aggregation and one column; a formula is not a value (S03-R3). */
function calculation(raw: unknown): string | null {
  const value = structured(raw);
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => key !== "aggregation" && key !== "column")) return null;
  const aggregation = closed(AGGREGATIONS, value.aggregation);
  if (aggregation === null) return null;
  if (value.column === undefined) {
    return aggregation === "count" ? JSON.stringify({ aggregation }) : null;
  }
  const column = columnName(value.column);
  return column === null ? null : JSON.stringify({ aggregation, column });
}

/**
 * The stored form of a value of one of the nine analytical value types, or null when it is not a value of
 * that type (S01-R21: such a value is dropped before it is written). Two inputs with the same meaning give
 * the same text, so the same-row rule holds: a column name differing in case or spacing, a column set in
 * another order. A composite value may be given as its JSON text or as the parsed value.
 */
export function normalizeValue(valueType: AnalyticalValueType, raw: unknown): string | null {
  switch (valueType) {
    case "header":
    case "column":
      return columnName(raw);
    case "column-set":
      return columnSet(raw);
    case "calculation":
      return calculation(raw);
    case "key-pairs":
      return keyPairs(raw);
    case "join-cardinality":
      return closed(CARDINALITIES, raw);
    case "period":
      return closed(PERIODS, raw);
    case "dataset-role":
      return closed(ROLES, raw);
    case "currency": {
      const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      return /^[A-Z]{3}$/.test(code) && knownCurrency(code) ? code : null;
    }
  }
}
