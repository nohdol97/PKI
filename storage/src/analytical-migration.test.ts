// S03-T04 `ontology.analytical-seeds` (the migration part, S03-R2, R13, C1) and the two tables of S03-R1
// (`dataset_tables`, `analytical_checks`): the migration after S02's on a database of S02's level (schema
// v24, with rows). It seeds the analytical names `verified`, edition 1, `origin = seed`, with the rules'
// `dataChecks`, and no history line; a name that exists is left alone; the four rules S02 seeded are widened
// to Metric and Dataset only while they are S02's seed rule and `verified`; the lifecycle gate is made
// again with the text it had; the knowledge revision does not move.
import { KNOWLEDGE_SCHEMA } from "@pki/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { ANALYTICAL_SEED } from "./analytical-types.ts";
import { describeKnowledgeSchema } from "./knowledge-schema.ts";
import { migrate, migrations, schemaVersion } from "./migrations.ts";
import { insertItem, saveFact, type KnowledgeAttributes } from "./knowledge.ts";
import { canonicalRule, listOntologyElements, type ElementRule } from "./ontology.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** S02's last migration (S02-T04's v24): the database this migration upgrades. */
const S02_SCHEMA = 24;
const MIGRATION_SCHEMA = S02_SCHEMA + 1;

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db, migrations.slice(0, S02_SCHEMA));
});
afterEach(() => db.close());

const AT = "2026-11-23T00:00:00.000Z";
type Stored = {
  kind: string;
  name: string;
  rule: string;
  status: string;
  edition: number;
  origin: string;
};
const rows = (): Stored[] =>
  db
    .all(
      "SELECT element_kind AS kind, name, rule, status, edition, origin FROM ontology_elements ORDER BY id",
    )
    .map((r) => r as unknown as Stored);
const named = (name: string): Stored[] => rows().filter((r) => r.name === name);
const historyCount = () => db.all("SELECT count(*) AS n FROM ontology_history")[0]?.n;
const upgrade = () => migrate(db, migrations.slice(0, MIGRATION_SCHEMA));

/** The rules as R2's table states them, written out here: the migration's copy is compared with this. */
const EXPECTED_CHECKS: Record<string, string[]> = {
  "dataset.grain": ["grain", "schema"],
  "dataset.measure": ["schema"],
  "dataset.dimension": ["schema"],
  "dataset.time_dimension": ["schema"],
  "metric.calculation": ["aggregation", "schema"],
  "join.keys": ["schema"],
  "join.cardinality": ["join-cardinality"],
};
const SEEDED_NAMES = ANALYTICAL_SEED.map((e) => e.name);

describe("ontology.analytical-seeds: the migration", () => {
  it("is the migration after S02's: one step, and the schema goes up by one", () => {
    expect(migrations.length).toBeGreaterThanOrEqual(MIGRATION_SCHEMA);
    expect(schemaVersion(db)).toBe(S02_SCHEMA);
    upgrade();
    expect(schemaVersion(db)).toBe(MIGRATION_SCHEMA);
  });

  it("seeds the twenty names verified, edition 1, origin seed, with R2's dataChecks", () => {
    expect(SEEDED_NAMES).toHaveLength(20);
    for (const name of SEEDED_NAMES) expect(named(name), name).toHaveLength(0);
    upgrade();
    for (const seed of ANALYTICAL_SEED) {
      const [row] = named(seed.name);
      expect(named(seed.name), seed.name).toHaveLength(1);
      expect({
        kind: row?.kind,
        status: row?.status,
        edition: row?.edition,
        origin: row?.origin,
      }).toEqual({
        kind: seed.elementKind,
        status: "verified",
        edition: 1,
        origin: "seed",
      });
      // the stored text is the canonical form of the constant's rule, the one a change through the gate stores
      expect(row?.rule, seed.name).toBe(JSON.stringify(canonicalRule(seed.rule)));
      const rule = JSON.parse(row?.rule as string) as ElementRule;
      const checks = rule.elementKind === "fact-kind" ? rule.dataChecks : undefined;
      expect(checks, seed.name).toEqual(EXPECTED_CHECKS[seed.name]);
    }
    // a name with no check carries no key (the stored text of S01's and S02's kinds is the same shape)
    expect(named("metric.unit")[0]?.rule).not.toContain("dataChecks");
    expect(named("dataset.column")[0]?.rule).not.toContain("dataChecks");
  });

  it("matches the catalogue's edition 2 names and rules, and the list reports them usable", () => {
    const before = describeKnowledgeSchema(listOntologyElements(db)).entries;
    // the catalogue's edition 2 is these names: the list says so before and after
    expect(KNOWLEDGE_SCHEMA.edition).toBeGreaterThanOrEqual(2);
    for (const name of SEEDED_NAMES) {
      const entry = before.find((e) => e.name === name);
      expect({ name, usable: entry?.usable }).toEqual({ name, usable: false });
    }
    for (const name of ["definition", "alias.synonym", "alias.abbreviation", "alias.translation"]) {
      expect(before.find((e) => e.name === name)?.ruleMatches, name).toBe(false);
    }
    upgrade();
    const after = describeKnowledgeSchema(listOntologyElements(db)).entries;
    for (const name of SEEDED_NAMES) {
      const entry = after.find((e) => e.name === name);
      // the column fact is in the list too: seeded, though not extracted
      expect({ name, usable: entry?.usable, ruleMatches: entry?.ruleMatches }).toEqual({
        name,
        usable: true,
        ruleMatches: true,
      });
    }
    for (const name of ["definition", "alias.synonym", "alias.abbreviation", "alias.translation"]) {
      expect(after.find((e) => e.name === name)?.ruleMatches, name).toBe(true);
    }
    // nothing the catalogue lists up to edition 2 is left unusable (edition 3's names come with a later migration)
    const edition3 = ["Request", "status", "conclusion"];
    expect(after.filter((e) => e.usable === false && !edition3.includes(e.name))).toEqual([]);
  });

  it("writes no history line and does not move the knowledge revision", () => {
    const revision = readKnowledgeRevision(db);
    const history = historyCount();
    upgrade();
    expect(historyCount()).toBe(history);
    expect(readKnowledgeRevision(db)).toBe(revision);
  });

  it("makes the lifecycle gate again with the very text it had, and keeps the origin guard", () => {
    const trigger = (name: string) =>
      db.all("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", [name]);
    const gate = trigger("ontology_elements_lifecycle_gate");
    const origin = trigger("ontology_elements_origin_fixed");
    expect(gate).toHaveLength(1);
    upgrade();
    expect(trigger("ontology_elements_lifecycle_gate")).toEqual(gate);
    expect(trigger("ontology_elements_origin_fixed")).toEqual(origin);
    // and it still stops a rule change that has no history line
    expect(() =>
      db.run("UPDATE ontology_elements SET edition = edition + 1 WHERE name = 'Metric'"),
    ).toThrow(/ontology gate/);
    expect(() =>
      db.run("UPDATE ontology_elements SET origin = 'user' WHERE name = 'Metric'"),
    ).toThrow(/origin/);
  });

  it("leaves a name that exists alone, whatever its status or origin, and by R19's comparison", () => {
    const add = (kind: string, name: string, rule: object, status: string, origin: string) =>
      db.run(
        "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES (?, ?, ?, ?, 1, ?)",
        [kind, name, JSON.stringify(rule), status, origin],
      );
    add("item-type", "Dataset", { elementKind: "item-type" }, "candidate", "source-proposed");
    // the user's own `metric_unit` is the same name as `metric.unit` for R19 (case, `_`, `.` and `-` aside)
    add(
      "fact-kind",
      "metric_unit",
      { elementKind: "fact-kind", itemTypes: ["Project"], valueType: "text", cardinality: "many" },
      "verified",
      "user",
    );
    add("item-type", "Join", { elementKind: "item-type" }, "rejected", "user");
    const before = rows();
    upgrade();
    const after = rows();
    const widened = new Set([
      "definition",
      "alias.synonym",
      "alias.abbreviation",
      "alias.translation",
    ]);
    expect(after.slice(0, before.length).filter((r) => !widened.has(r.name))).toEqual(
      before.filter((r) => !widened.has(r.name)),
    );
    expect(named("Dataset")).toEqual([before.find((r) => r.name === "Dataset")]);
    expect(named("Join")).toEqual([before.find((r) => r.name === "Join")]);
    expect(named("metric.unit")).toEqual([]);
    expect(named("metric_unit")).toEqual([before.find((r) => r.name === "metric_unit")]);
    // the rest is made as the others are
    expect(named("Metric")[0]).toMatchObject({ status: "verified", origin: "seed" });
    expect(named("metric.calculation")[0]).toMatchObject({ status: "verified", origin: "seed" });
    expect(after).toHaveLength(before.length + 20 - 3);
  });

  it("widens definition and alias.* to Metric and Dataset while they are S02's seed rule and verified", () => {
    upgrade();
    const widened = {
      definition: ["Concept", "Dataset", "Metric"],
      "alias.synonym": ["Concept", "Dataset", "Metric", "Project", "System"],
      "alias.abbreviation": ["Concept", "Dataset", "Metric", "Project", "System"],
      "alias.translation": ["Concept", "Dataset", "Metric", "Project", "System"],
    };
    for (const [name, itemTypes] of Object.entries(widened)) {
      const [row] = named(name);
      expect(JSON.parse(row?.rule as string), name).toEqual({
        elementKind: "fact-kind",
        itemTypes,
        valueType: name === "definition" ? "text" : "surface-form",
        cardinality: "many",
      });
      expect(row?.edition, name).toBe(2);
      expect(row?.status, name).toBe("verified");
    }
    // the names no analytical spec touches keep edition 1
    expect(named("target_date")[0]?.edition).toBe(2); // S02's own widening, made by v23
    expect(named("Concept")[0]?.edition).toBe(1);
    expect(named("statement")[0]?.edition).toBe(1);
  });

  it("does not widen a rule the user changed, or one that is not verified (a disputed one)", () => {
    const line = (
      id: number,
      action: string,
      from: string,
      to: string,
      fromEdition: number,
      toEdition: number,
    ) =>
      db.run(
        `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition)
         VALUES (?, 1, ?, 'user', ?, ?, ?, ?, ?)`,
        [id, AT, action, from, to, fromEdition, toEdition],
      );
    const idOf = (name: string) =>
      db.all("SELECT id FROM ontology_elements WHERE name = ?", [name])[0]?.id as number;
    // the user's change of `definition`: another rule, edition 2 (the gate wants the line first)
    const definition = idOf("definition");
    line(definition, "change-rule", "verified", "verified", 1, 2);
    const mine = JSON.stringify({
      elementKind: "fact-kind",
      itemTypes: ["Concept", "Project"],
      valueType: "text",
      cardinality: "many",
    });
    db.run("UPDATE ontology_elements SET rule = ?, edition = 2 WHERE id = ?", [mine, definition]);
    // a disputed `alias.synonym`
    const synonym = idOf("alias.synonym");
    line(synonym, "dispute", "verified", "disputed", 1, 1);
    db.run("UPDATE ontology_elements SET status = 'disputed' WHERE id = ?", [synonym]);
    upgrade();
    expect(named("definition")[0]).toMatchObject({ rule: mine, edition: 2, status: "verified" });
    expect(named("alias.synonym")[0]).toMatchObject({ edition: 1, status: "disputed" });
    expect(JSON.parse(named("alias.synonym")[0]?.rule as string).itemTypes).toEqual([
      "Concept",
      "Project",
      "System",
    ]);
    // the two others, still S02's seed rule and verified, are widened
    expect(named("alias.abbreviation")[0]?.edition).toBe(2);
    expect(named("alias.translation")[0]?.edition).toBe(2);
  });

  it("keeps every other row and table as they were", () => {
    const tables = ["items", "facts", "relations", "evidence", "jobs", "source_versions"];
    const before = tables.map((t) => db.all(`SELECT * FROM ${t}`));
    const existing = rows();
    upgrade();
    expect(tables.map((t) => db.all(`SELECT * FROM ${t}`))).toEqual(before);
    // the existing rows are first and the same, but for the four widened rules
    const changed = new Set([
      "definition",
      "alias.synonym",
      "alias.abbreviation",
      "alias.translation",
    ]);
    expect(
      rows()
        .slice(0, existing.length)
        .filter((r) => !changed.has(r.name)),
    ).toEqual(existing.filter((r) => !changed.has(r.name)));
  });
});

describe("ontology.analytical-seeds: the migration is atomic", () => {
  it("a failure inside v25 leaves schema v24 as it was: no table, no seed row, the gate and revision intact", () => {
    const before = {
      rows: rows(),
      revision: readKnowledgeRevision(db),
      gate: db.all("SELECT sql FROM sqlite_master WHERE name = 'ontology_elements_lifecycle_gate'"),
    };
    // a row that makes the widening step fail after the tables, the seeds and the gate drop were done
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON ontology_elements
      BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect(() => upgrade()).toThrow(/injected/);
    expect(schemaVersion(db)).toBe(S02_SCHEMA);
    expect(
      db.all("SELECT 1 FROM sqlite_master WHERE name IN ('dataset_tables', 'analytical_checks')"),
    ).toEqual([]);
    expect(rows()).toEqual(before.rows);
    expect(readKnowledgeRevision(db)).toBe(before.revision);
    expect(
      db.all("SELECT sql FROM sqlite_master WHERE name = 'ontology_elements_lifecycle_gate'"),
    ).toEqual(before.gate);
    // and without the fault the migration then applies
    db.exec("DROP TRIGGER boom");
    upgrade();
    expect(schemaVersion(db)).toBe(MIGRATION_SCHEMA);
  });
});

describe("the two tables of S03-R1", () => {
  beforeEach(upgrade);
  const columns = (table: string) =>
    db.all(`PRAGMA table_info(${table})`).map((c) => [c.name, c.type, c.notnull] as const);
  const attrs: KnowledgeAttributes = {
    epistemic: "explicit",
    status: "candidate",
    validAt: null,
    observedAt: AT,
  };
  let seq = 0;
  const base = () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    const saved = saveSourceRecord(db, "c1", {
      namespace: "",
      externalId: `e${++seq}`,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error("seed");
    const version = db.all("SELECT id FROM source_versions WHERE source_id = ?", [
      saved.sourceId,
    ])[0]?.id as number;
    const item = insertItem(db, { type: "Dataset", name: `d${seq}`, ...attrs });
    const fact = saveFact(db, { itemId: item, kind: "dataset.column", value: "a", ...attrs }).id;
    return { source: saved.sourceId, version, item, fact };
  };

  it("dataset_tables: item, source, table key and data rows; one table per (source, key)", () => {
    expect(columns("dataset_tables").map(([name]) => name)).toEqual([
      "id",
      "item_id",
      "source_id",
      "table_key",
      "row_count",
    ]);
    const { source, item } = base();
    const put = (key: string) =>
      db.run(
        "INSERT INTO dataset_tables (item_id, source_id, table_key, row_count) VALUES (?, ?, ?, 3)",
        [item, source, key],
      );
    put("");
    expect(() => put("")).toThrow(/UNIQUE/);
    put("Sheet1"); // another sheet of the same source is another table
    expect(() =>
      db.run(
        "INSERT INTO dataset_tables (item_id, source_id, table_key, row_count) VALUES (?, ?, 'x', -1)",
        [item, source],
      ),
    ).toThrow(/CHECK/);
    // the row goes with its item
    db.run("DELETE FROM facts WHERE item_id = ?", [item]);
    db.run("DELETE FROM items WHERE id = ?", [item]);
    expect(db.all("SELECT 1 FROM dataset_tables")).toEqual([]);
  });

  it("analytical_checks: the numbers and codes of one check per (fact, check), gone with its fact or version", () => {
    expect(columns("analytical_checks").map(([name]) => name)).toEqual([
      "id",
      "fact_id",
      "check_name",
      "passed",
      "failure_code",
      "examined",
      "violations",
      "skipped",
      "version_id",
      "other_version_id",
      "checked_at",
    ]);
    const { version, fact } = base();
    const put = (check: string, passed: number, code: string | null) =>
      db.run(
        `INSERT INTO analytical_checks (fact_id, check_name, passed, failure_code, examined, violations, skipped, version_id, other_version_id, checked_at)
         VALUES (?, ?, ?, ?, 4, 0, 1, ?, NULL, ?)`,
        [fact, check, passed, code, version, AT],
      );
    put("schema", 1, null);
    expect(() => put("schema", 1, null)).toThrow(/UNIQUE/);
    expect(() => put("sql", 1, null)).toThrow(/CHECK/);
    put("aggregation", 0, "non-numeric");
    expect(() => put("grain", 2, null)).toThrow(/CHECK/);
    db.run("DELETE FROM facts WHERE id = ?", [fact]);
    expect(db.all("SELECT 1 FROM analytical_checks")).toEqual([]);
    // and with the version it read
    const second = base();
    db.run(
      `INSERT INTO analytical_checks (fact_id, check_name, passed, failure_code, examined, violations, skipped, version_id, other_version_id, checked_at)
       VALUES (?, 'schema', 1, NULL, 1, 0, 0, ?, NULL, ?)`,
      [second.fact, second.version, AT],
    );
    db.run("DELETE FROM source_versions WHERE id = ?", [second.version]);
    expect(db.all("SELECT 1 FROM analytical_checks")).toEqual([]);
  });
});
