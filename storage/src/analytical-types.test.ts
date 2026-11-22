// S03-T01 `analytical.value-types` (S03-R3, C1, C3) and the constant, catalogue and shape-check parts of
// `ontology.analytical-seeds` (S03-R2, R13, C1). The migration that writes the seeds is S03-T04's.
import {
  isDateText,
  isNumberText,
  KNOWLEDGE_SCHEMA,
  NOT_EXTRACTED_NAMES,
  PRODUCT_SEED,
} from "@pki/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  ANALYTICAL_SEED,
  ANALYTICAL_VALUE_TYPES,
  REQUIRED_DATA_CHECKS,
  normalizeColumnName,
  normalizeValue,
} from "./analytical-types.ts";
import { insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate, migrations } from "./migrations.ts";
import {
  applyUserOntologyChange,
  checkOntologyChange,
  readOntologyElement,
  valueFits,
  type ElementRule,
  type OntologyChange,
} from "./ontology.ts";
import type { SqlDriver } from "./sql-driver.ts";

describe("analytical.value-types", () => {
  it("names the nine value types", () => {
    expect([...ANALYTICAL_VALUE_TYPES]).toEqual([
      "header",
      "column",
      "column-set",
      "calculation",
      "key-pairs",
      "join-cardinality",
      "period",
      "currency",
      "dataset-role",
    ]);
  });

  it("stores a column name in the processed form: case, width and spacing do not make a new value", () => {
    expect(normalizeColumnName("  Amount \t Total ")).toBe("amount total");
    expect(normalizeValue("column", "Amount")).toBe("amount");
    expect(normalizeValue("column", " AMOUNT ")).toBe(normalizeValue("column", "amount"));
    expect(normalizeValue("column", "Ａmount")).toBe("amount");
    expect(normalizeValue("header", "금액  합계")).toBe("금액 합계");
  });

  it("rejects an empty column and a name over 200 code points, and takes exactly 200", () => {
    for (const type of ["column", "header"] as const) {
      expect(normalizeValue(type, "   ")).toBeNull();
      expect(normalizeValue(type, "")).toBeNull();
      expect(normalizeValue(type, "가".repeat(200))).toBe("가".repeat(200));
      expect(normalizeValue(type, "가".repeat(201))).toBeNull();
      expect(normalizeValue(type, 5 as never)).toBeNull();
    }
  });

  it("makes a column-set a sorted JSON array of processed names: the order and the case do not matter", () => {
    const a = normalizeValue("column-set", ["Region", "Month"]);
    expect(a).toBe('["month","region"]');
    expect(normalizeValue("column-set", ["month", "REGION"])).toBe(a);
    expect(normalizeValue("column-set", '["region","month"]')).toBe(a);
  });

  it("refuses a column-set that is empty, repeats a name after processing, or holds a bad name", () => {
    expect(normalizeValue("column-set", [])).toBeNull();
    expect(normalizeValue("column-set", ["Month", "month"])).toBeNull();
    expect(normalizeValue("column-set", ["month", " "])).toBeNull();
    expect(normalizeValue("column-set", "month")).toBeNull();
    expect(normalizeValue("column-set", { a: 1 })).toBeNull();
  });

  it("makes a calculation one aggregation and one column, keys sorted, the column processed", () => {
    const sum = '{"aggregation":"sum","column":"amount"}';
    expect(normalizeValue("calculation", { aggregation: "sum", column: "Amount" })).toBe(sum);
    expect(normalizeValue("calculation", { column: " AMOUNT ", aggregation: "sum" })).toBe(sum);
    expect(normalizeValue("calculation", sum)).toBe(sum);
    for (const aggregation of ["count_distinct", "avg", "min", "max"]) {
      expect(normalizeValue("calculation", { aggregation, column: "id" })).toBe(
        `{"aggregation":"${aggregation}","column":"id"}`,
      );
    }
  });

  it("lets count stand without a column (the rows) and no other aggregation", () => {
    expect(normalizeValue("calculation", { aggregation: "count" })).toBe('{"aggregation":"count"}');
    expect(normalizeValue("calculation", { aggregation: "count", column: "Id" })).toBe(
      '{"aggregation":"count","column":"id"}',
    );
    expect(normalizeValue("calculation", { aggregation: "sum" })).toBeNull();
    expect(normalizeValue("calculation", { aggregation: "sum", column: "" })).toBeNull();
  });

  it("rejects what is a formula and not a value: two columns, operators, conditions, nesting, a query", () => {
    const bad: unknown[] = [
      "sum(a)/sum(b)",
      "sum(amount)",
      "select sum(amount) from orders",
      "SELECT 1",
      { aggregation: "sum", column: ["a", "b"] },
      { aggregation: "sum", column: "a", other: "b" },
      { aggregation: "sum", column: "a", where: "b > 1" },
      { aggregation: "sum", column: "a", filter: "x" },
      { aggregation: { aggregation: "sum", column: "a" }, column: "b" },
      { aggregation: "sum", column: { aggregation: "sum", column: "a" } },
      { aggregation: "sum/count", column: "a" },
      { aggregation: "median", column: "a" },
      { aggregation: "SUM", column: "a" },
      { aggregation: "sum", column: 3 },
      {},
      null,
      "",
      '[{"aggregation":"sum","column":"a"}]',
    ];
    for (const value of bad) expect(normalizeValue("calculation", value), String(value)).toBeNull();
  });

  it("makes key-pairs a sorted JSON array of processed (left, right) pairs", () => {
    const value = normalizeValue("key-pairs", [
      ["Order_ID", "ID"],
      ["Region", "Region"],
    ]);
    expect(value).toBe('[["order_id","id"],["region","region"]]');
    expect(
      normalizeValue("key-pairs", [
        ["region", "REGION"],
        ["ORDER_id", "id"],
      ]),
    ).toBe(value);
    expect(normalizeValue("key-pairs", value)).toBe(value);
  });

  it("refuses key-pairs with no pair, a pair that is not two names, or the same pair twice", () => {
    expect(normalizeValue("key-pairs", [])).toBeNull();
    expect(normalizeValue("key-pairs", [["a"]])).toBeNull();
    expect(normalizeValue("key-pairs", [["a", "b", "c"]])).toBeNull();
    expect(normalizeValue("key-pairs", [["a", " "]])).toBeNull();
    expect(
      normalizeValue("key-pairs", [
        ["a", "b"],
        ["A", "B"],
      ]),
    ).toBeNull();
    expect(normalizeValue("key-pairs", ["a", "b"])).toBeNull();
  });

  it("takes the closed lists exactly and refuses anything outside them", () => {
    for (const v of ["one-to-one", "many-to-one", "one-to-many", "many-to-many"]) {
      expect(normalizeValue("join-cardinality", v)).toBe(v);
    }
    for (const v of ["day", "week", "month", "quarter", "year"]) {
      expect(normalizeValue("period", v)).toBe(v);
    }
    for (const v of ["fact", "dimension"]) expect(normalizeValue("dataset-role", v)).toBe(v);
    for (const [type, v] of [
      ["join-cardinality", "one-to-few"],
      ["join-cardinality", "ONE-TO-ONE"],
      ["period", "hour"],
      ["period", "Month"],
      ["period", ""],
      ["dataset-role", "measure"],
      ["dataset-role", "Fact"],
    ] as const) {
      expect(normalizeValue(type, v), `${type} ${v}`).toBeNull();
    }
  });

  it("takes an ISO 4217 code the runtime knows, upper-cased, and nothing else", () => {
    expect(normalizeValue("currency", "KRW")).toBe("KRW");
    expect(normalizeValue("currency", "usd")).toBe("USD");
    expect(normalizeValue("currency", " eur ")).toBe("EUR");
    for (const v of ["", "US", "USDD", "ZZZ", "XXY", "원", "US$", "123"]) {
      expect(normalizeValue("currency", v), v).toBeNull();
    }
  });

  it("is what the user's value check asks for: valueFits agrees with the normalisation", () => {
    expect(valueFits("period", "month")).toBe(true);
    expect(valueFits("period", "hour")).toBe(false);
    expect(valueFits("calculation", '{"aggregation":"sum","column":"a"}')).toBe(true);
    expect(valueFits("calculation", "sum(a)/sum(b)")).toBe(false);
    expect(valueFits("identifier", "x")).toBe(true);
  });

  it("splits the number and date grammar where S03-R3 draws the line", () => {
    for (const ok of ["1000.50", " 42", "-3", "1e3", "1e+21"])
      expect(isNumberText(ok), ok).toBe(true);
    for (const no of ["1,000", "₩1000", "10%", "NaN", "Infinity", ""]) {
      expect(isNumberText(no), no).toBe(false);
    }
    for (const ok of ["2024-01-31", "2024-01-31T09:00:00.000Z"])
      expect(isDateText(ok), ok).toBe(true);
    for (const no of ["2024/01/31", "2024-02-30", "20240131"])
      expect(isDateText(no), no).toBe(false);
    expect(isNumberText("20240131")).toBe(true);
  });
});

const fk = (
  valueType: string,
  dataChecks?: readonly string[],
  over: Record<string, unknown> = {},
): ElementRule =>
  ({
    elementKind: "fact-kind",
    itemTypes: ["Project"],
    valueType,
    cardinality: "one",
    ...(dataChecks === undefined ? {} : { dataChecks }),
    ...over,
  }) as ElementRule;
const add = (name: string, rule: ElementRule): OntologyChange => ({ op: "add", name, rule });

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db, migrations.slice(0, 23)); // S02's level: the analytical migration is what these checks judge
});
afterEach(() => db.close());

describe("ontology.analytical-seeds: the shape check of dataChecks (S03-R13)", () => {
  const errors = (rule: ElementRule) =>
    checkOntologyChange(db, add("calc_kind", rule)).schemaErrors;

  it("names the checks each value type must carry and may carry", () => {
    expect(REQUIRED_DATA_CHECKS).toEqual({
      column: { required: ["schema"], optional: [] },
      "key-pairs": { required: ["schema"], optional: [] },
      "column-set": { required: ["schema"], optional: ["grain"] },
      calculation: { required: ["schema", "aggregation"], optional: [] },
      "join-cardinality": { required: ["join-cardinality"], optional: [] },
    });
  });

  it("refuses a calculation kind without aggregation, with the code and nothing written", () => {
    expect(errors(fk("calculation", ["schema"]))).toEqual(["data-checks-missing"]);
    expect(errors(fk("calculation"))).toEqual(["data-checks-missing"]);
    expect(errors(fk("calculation", []))).toEqual(["data-checks-missing"]);
    expect(errors(fk("calculation", ["aggregation"]))).toEqual(["data-checks-missing"]);
    expect(checkOntologyChange(db, add("calc_kind", fk("calculation", ["schema"])))).toMatchObject({
      applicable: false,
    });
    expect(db.all("SELECT 1 FROM ontology_elements WHERE name = 'calc_kind'")).toEqual([]);
  });

  it("refuses dataChecks on a value type that must have none", () => {
    for (const type of [
      "text",
      "date",
      "surface-form",
      "identifier",
      "header",
      "period",
      "currency",
      "dataset-role",
    ]) {
      expect(errors(fk(type, ["schema"])), type).toEqual(["data-checks-not-allowed"]);
    }
  });

  it("refuses a check outside the optional ones, an unknown name, a repeat and a non-list", () => {
    expect(errors(fk("column", ["schema", "grain"]))).toEqual(["data-checks-not-allowed"]);
    expect(errors(fk("column-set", ["schema", "aggregation"]))).toEqual([
      "data-checks-not-allowed",
    ]);
    expect(errors(fk("column", ["schema", "nope"]))).toEqual(["data-checks-invalid"]);
    expect(errors(fk("column", ["schema", "schema"]))).toEqual(["data-checks-invalid"]);
    expect(errors(fk("column", "schema" as never))).toEqual(["data-checks-invalid"]);
    expect(errors(fk("column", [3 as never]))).toEqual(["data-checks-invalid"]);
  });

  it("accepts the required checks, the optional one, and an empty or absent list where none is required", () => {
    expect(errors(fk("column", ["schema"]))).toEqual([]);
    expect(errors(fk("key-pairs", ["schema"]))).toEqual([]);
    expect(errors(fk("column-set", ["schema"]))).toEqual([]);
    expect(errors(fk("column-set", ["grain", "schema"]))).toEqual([]);
    expect(errors(fk("calculation", ["aggregation", "schema"]))).toEqual([]);
    expect(errors(fk("join-cardinality", ["join-cardinality"]))).toEqual([]);
    expect(errors(fk("text"))).toEqual([]);
    expect(errors(fk("text", []))).toEqual([]);
    expect(errors(fk("period", []))).toEqual([]);
  });

  it("stores the checks sorted and without repeats, and an empty list as none (the stored text of S01 and S02 kinds is unchanged)", () => {
    expect(applyUserOntologyChange(db, add("tag_a", fk("text", [])))).toMatchObject({
      status: "applied",
    });
    expect(readOntologyElement(db, "fact-kind", "tag_a")?.rule).toEqual({
      elementKind: "fact-kind",
      itemTypes: ["Project"],
      valueType: "text",
      cardinality: "one",
    });
    expect(
      applyUserOntologyChange(db, add("calc_a", fk("calculation", ["schema", "aggregation"]))),
    ).toMatchObject({
      status: "applied",
    });
    expect(JSON.stringify(readOntologyElement(db, "fact-kind", "calc_a")?.rule)).toBe(
      '{"elementKind":"fact-kind","itemTypes":["Project"],"valueType":"calculation","cardinality":"one","dataChecks":["aggregation","schema"]}',
    );
    // a rule that only adds an empty list is no change
    expect(
      checkOntologyChange(db, {
        op: "change-rule",
        elementKind: "fact-kind",
        name: "tag_a",
        rule: fk("text", []),
      }).schemaErrors,
    ).toEqual(["rule-unchanged"]);
  });

  it("refuses a change of an existing rule the same way, and reaches the rule's other keys", () => {
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('fact-kind', 'note_kind', ?, 'verified', 1, 'user')",
      [JSON.stringify(fk("text"))],
    );
    const change = (rule: ElementRule): OntologyChange => ({
      op: "change-rule",
      elementKind: "fact-kind",
      name: "note_kind",
      rule,
    });
    expect(checkOntologyChange(db, change(fk("calculation", ["schema"]))).schemaErrors).toEqual([
      "data-checks-missing",
    ]);
    expect(checkOntologyChange(db, change(fk("text", ["schema"]))).schemaErrors).toEqual([
      "data-checks-not-allowed",
    ]);
    expect(checkOntologyChange(db, change(fk("text", [], { extra: 1 }))).schemaErrors).toEqual([
      "rule-malformed",
    ]);
  });
});

describe("ontology.analytical-seeds: the effect on existing rows (S01-R19 step 3)", () => {
  const attrs: KnowledgeAttributes = {
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: "2026-11-21T00:00:00Z",
  };
  const change = (rule: ElementRule): OntologyChange => ({
    op: "change-rule",
    elementKind: "fact-kind",
    name: "note_kind",
    rule,
  });
  const withRow = (value: string) => {
    expect(applyUserOntologyChange(db, add("note_kind", fk("text")))).toMatchObject({
      status: "applied",
    });
    const itemId = insertItem(db, { type: "Project", name: "P", ...attrs });
    saveFact(db, { itemId, kind: "note_kind", value, ...attrs });
  };

  it.each([
    ["currency", undefined, "not a currency code"],
    ["column", ["schema"], "가".repeat(201)],
    ["calculation", ["schema", "aggregation"], "sum(a)/sum(b)"],
    ["period", undefined, "hourly"],
    ["date", undefined, "not a date"],
  ] as const)(
    "refuses a change to %s while a live row's value is not one",
    (type, checks, value) => {
      withRow(value);
      expect(checkOntologyChange(db, change(fk(type, checks)))).toMatchObject({
        schemaErrors: [],
        impact: { liveRows: 1, violations: 1 },
        applicable: false,
      });
      expect(applyUserOntologyChange(db, change(fk(type, checks)))).toMatchObject({
        status: "refused",
        reason: "existing-data-violation",
      });
    },
  );

  it("applies the change when every live value is one of the new type", () => {
    withRow("KRW");
    expect(applyUserOntologyChange(db, change(fk("currency")))).toMatchObject({
      status: "applied",
    });
  });
});

describe("ontology.analytical-seeds: the constants and the catalogue", () => {
  const byName = (name: string) => {
    const found = ANALYTICAL_SEED.filter((e) => e.name === name);
    expect(found, name).toHaveLength(1);
    return found[0] as (typeof ANALYTICAL_SEED)[number];
  };

  it("holds the initial values of S03-R2's table", () => {
    expect(ANALYTICAL_SEED.map((e) => `${e.elementKind}:${e.name}`)).toEqual([
      "item-type:Dataset",
      "item-type:Metric",
      "item-type:Join",
      "fact-kind:dataset.column",
      "fact-kind:dataset.role",
      "fact-kind:dataset.grain",
      "fact-kind:dataset.measure",
      "fact-kind:dataset.dimension",
      "fact-kind:dataset.time_dimension",
      "fact-kind:metric.calculation",
      "fact-kind:metric.unit",
      "fact-kind:metric.version",
      "fact-kind:metric.currency",
      "fact-kind:metric.period",
      "fact-kind:join.keys",
      "fact-kind:join.cardinality",
      "relation-type:MEASURED_ON",
      "relation-type:JOIN_LEFT",
      "relation-type:JOIN_RIGHT",
      "relation-type:USES_JOIN",
    ]);
    const fact = (name: string) => {
      const rule = byName(name).rule;
      if (rule.elementKind !== "fact-kind") throw new Error(name);
      return rule;
    };
    expect(fact("dataset.column")).toMatchObject({
      itemTypes: ["Dataset"],
      valueType: "header",
      cardinality: "many",
    });
    expect(fact("dataset.role")).toMatchObject({
      itemTypes: ["Dataset"],
      valueType: "dataset-role",
      cardinality: "one",
    });
    expect(fact("dataset.grain")).toMatchObject({ valueType: "column-set", cardinality: "one" });
    for (const n of ["dataset.measure", "dataset.dimension", "dataset.time_dimension"]) {
      expect(fact(n)).toMatchObject({
        itemTypes: ["Dataset"],
        valueType: "column",
        cardinality: "many",
      });
    }
    expect(fact("metric.calculation")).toMatchObject({
      itemTypes: ["Metric"],
      valueType: "calculation",
      cardinality: "one",
    });
    for (const n of ["metric.unit", "metric.version"]) {
      expect(fact(n)).toMatchObject({
        itemTypes: ["Metric"],
        valueType: "text",
        cardinality: "one",
      });
    }
    expect(fact("metric.currency")).toMatchObject({ valueType: "currency", cardinality: "one" });
    expect(fact("metric.period")).toMatchObject({ valueType: "period", cardinality: "one" });
    expect(fact("join.keys")).toMatchObject({
      itemTypes: ["Join"],
      valueType: "key-pairs",
      cardinality: "one",
    });
    expect(fact("join.cardinality")).toMatchObject({
      valueType: "join-cardinality",
      cardinality: "one",
    });
    expect(byName("MEASURED_ON").rule).toEqual({
      elementKind: "relation-type",
      subjectTypes: ["Metric"],
      objectTypes: ["Dataset"],
      symmetric: false,
    });
    expect(byName("JOIN_LEFT").rule).toMatchObject({
      subjectTypes: ["Join"],
      objectTypes: ["Dataset"],
      symmetric: false,
    });
    expect(byName("JOIN_RIGHT").rule).toMatchObject({
      subjectTypes: ["Join"],
      objectTypes: ["Dataset"],
      symmetric: false,
    });
    expect(byName("USES_JOIN").rule).toMatchObject({
      subjectTypes: ["Metric"],
      objectTypes: ["Join"],
      symmetric: false,
    });
  });

  it("carries R2's dataChecks, and an empty list as none", () => {
    const checks = (name: string) => {
      const rule = byName(name).rule;
      return rule.elementKind === "fact-kind" ? [...(rule.dataChecks ?? [])].sort() : [];
    };
    expect(checks("dataset.grain")).toEqual(["grain", "schema"]);
    for (const n of [
      "dataset.measure",
      "dataset.dimension",
      "dataset.time_dimension",
      "join.keys",
    ]) {
      expect(checks(n), n).toEqual(["schema"]);
    }
    expect(checks("metric.calculation")).toEqual(["aggregation", "schema"]);
    expect(checks("join.cardinality")).toEqual(["join-cardinality"]);
    for (const n of [
      "dataset.column",
      "dataset.role",
      "metric.unit",
      "metric.version",
      "metric.currency",
      "metric.period",
    ]) {
      expect(checks(n), n).toEqual([]);
    }
  });

  it("is the catalogue's edition 2: the same names, rules and checks, `dataset.column` not extracted", () => {
    expect(KNOWLEDGE_SCHEMA.edition).toBe(2);
    const entries = [
      ...KNOWLEDGE_SCHEMA.knowledgeTypes,
      ...KNOWLEDGE_SCHEMA.relationTypes,
      ...KNOWLEDGE_SCHEMA.factKinds,
    ].filter((e) => e.since === 2);
    expect(entries.map((e) => e.name).sort()).toEqual(ANALYTICAL_SEED.map((e) => e.name).sort());
    for (const seed of ANALYTICAL_SEED) {
      const entry = entries.find((e) => e.name === seed.name);
      expect(entry?.place).toBe("type-definition");
      expect(entry?.rule, seed.name).toEqual(seed.rule);
    }
    expect([...NOT_EXTRACTED_NAMES]).toEqual(["dataset.column"]);
    expect(PRODUCT_SEED.filter((e) => e.since === 2)).toHaveLength(ANALYTICAL_SEED.length);
  });

  it("widens definition and alias.* to Metric and Dataset in the catalogue", () => {
    for (const name of ["definition", "alias.synonym", "alias.abbreviation", "alias.translation"]) {
      const entry = KNOWLEDGE_SCHEMA.factKinds.find((e) => e.name === name);
      expect(entry?.rule).toMatchObject({ elementKind: "fact-kind" });
      const types = entry?.rule?.elementKind === "fact-kind" ? entry.rule.itemTypes : [];
      expect(types, name).toEqual(expect.arrayContaining(["Metric", "Dataset"]));
      expect(entry?.widenedAt).toBe(2);
    }
  });

  it("passes every addition and widening through S01's checks as applicable on an S02-level database", () => {
    const additions = ANALYTICAL_SEED.filter((e) => e.rule.elementKind === "item-type");
    for (const e of additions) {
      expect(checkOntologyChange(db, add(e.name, e.rule)).applicable, e.name).toBe(true);
      db.run(
        "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('item-type', ?, ?, 'verified', 1, 'seed')",
        [e.name, JSON.stringify(e.rule)],
      );
    }
    for (const e of ANALYTICAL_SEED.filter((x) => x.rule.elementKind !== "item-type")) {
      expect(checkOntologyChange(db, add(e.name, e.rule)), e.name).toMatchObject({
        schemaErrors: [],
        applicable: true,
      });
    }
    for (const name of ["definition", "alias.synonym", "alias.abbreviation", "alias.translation"]) {
      const entry = KNOWLEDGE_SCHEMA.factKinds.find((e) => e.name === name);
      expect(
        checkOntologyChange(db, {
          op: "change-rule",
          elementKind: "fact-kind",
          name,
          rule: entry?.rule as ElementRule,
        }).applicable,
        name,
      ).toBe(true);
    }
  });

  it("never lets a reserved or S02 name collide with the analytical names", () => {
    const names = new Set(PRODUCT_SEED.map((e) => `${e.elementKind}:${e.name}`));
    expect(names.size).toBe(PRODUCT_SEED.length);
    expect(ANALYTICAL_SEED.some((e) => e.name === "Fact")).toBe(false);
  });
});
