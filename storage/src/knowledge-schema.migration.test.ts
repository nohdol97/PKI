// S02-T01 `schema.catalogue-migration` (S02-R2, R3, C1): migration 22 on a database of S01's level (schema
// v21, with rows). The catalogue's missing types, fact kinds and relation types are seeded `verified` with
// `origin = seed`; the existing rows stay; each seeded change passes S01's checks (`applicable`); the origin
// column is filled by R3's four steps; the three widened rules are widened only while they are S01's seed
// rule and `verified`, with the edition up by one and no history line.
import { KNOWLEDGE_SCHEMA, PRODUCT_SEED, type CatalogueRule } from "@pki/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { describeKnowledgeSchema } from "./knowledge-schema.ts";
import { insertItem, saveFact, saveRelation, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate, migrations, schemaVersion } from "./migrations.ts";
import {
  applyOntologyChange,
  applyUserOntologyChange,
  checkOntologyChange,
  factValueFit,
  listOntologyElements,
  userOntology,
  valueFits,
  type ElementRule,
  type OntologyChange,
} from "./ontology.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

/** The migration under test is the first one S02 adds: the next free number after S01's 21. */
const S01_SCHEMA = 21;

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db, migrations.slice(0, S01_SCHEMA));
});
afterEach(() => db.close());

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const AT = "2026-11-22T00:00:00.000Z";

type Rule = Record<string, unknown>;
const ITEM: Rule = { elementKind: "item-type" };
const S01_DEPENDS_ON: Rule = {
  elementKind: "relation-type",
  subjectTypes: ["Project", "System"],
  objectTypes: ["Project", "System"],
  symmetric: false,
};

/** A row as S01's code leaves it at schema v21: the history line first when there is one. */
function rawElement(
  elementKind: string,
  name: string,
  rule: Rule,
  status: string,
  opts: { created?: "user" | "extraction"; basis?: boolean; rejected?: boolean } = {},
): number {
  const id = db.run(
    "INSERT INTO ontology_elements (element_kind, name, rule, status, edition) VALUES (?, ?, ?, ?, 1)",
    [elementKind, name, JSON.stringify(rule), status],
  ).lastInsertRowid;
  const line = (seq: number, actor: string, action: string, from: string | null, to: string) =>
    db.run(
      `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [id, seq, AT, actor, action, from, to, from === null ? null : 1],
    );
  if (opts.created) {
    line(1, opts.created, "created", null, opts.created === "user" ? "verified" : "candidate");
    if (opts.created === "extraction" && status !== "candidate") {
      line(2, "user", status === "rejected" ? "reject" : "approve", "candidate", status);
    }
  }
  if (opts.basis) {
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, 1, 1)", [id]);
  }
  return id;
}
/** A user's rule change at v21: the line, then the row (the gate wants that order). */
function userChangesRule(name: string, rule: Rule): void {
  const row = db.all("SELECT id FROM ontology_elements WHERE name = ?", [name])[0];
  db.run(
    `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition)
     VALUES (?, 1, ?, 'user', 'change-rule', 'verified', 'verified', 1, 2)`,
    [row?.id as number, AT],
  );
  db.run("UPDATE ontology_elements SET rule = ?, edition = 2 WHERE name = ?", [
    JSON.stringify(rule),
    name,
  ]);
}

type Stored = {
  kind: string;
  name: string;
  rule: string;
  status: string;
  edition: number;
  origin: string;
};
const stored = (): Stored[] =>
  db
    .all(
      "SELECT element_kind AS kind, name, rule, status, edition, origin FROM ontology_elements ORDER BY id",
    )
    .map((r) => r as unknown as Stored);
const one = (name: string, kind?: string): Stored => {
  const found = stored().filter((r) => r.name === name && (kind === undefined || r.kind === kind));
  expect(found).toHaveLength(1);
  return found[0] as Stored;
};
const existingNames = (): string[] =>
  db.all("SELECT name FROM ontology_elements").map((r) => r.name as string);
/** The rows before the migration: the columns S01's schema has. */
const storedBefore = () =>
  db
    .all(
      "SELECT element_kind AS kind, name, rule, status, edition FROM ontology_elements ORDER BY id",
    )
    .map((r) => r as unknown as Omit<Stored, "origin">);
const sorted = (list: readonly string[]) => [...list].sort();
const canon = (rule: CatalogueRule | ElementRule): unknown =>
  rule.elementKind === "item-type"
    ? rule
    : rule.elementKind === "fact-kind"
      ? { ...rule, itemTypes: sorted(rule.itemTypes) }
      : { ...rule, subjectTypes: sorted(rule.subjectTypes), objectTypes: sorted(rule.objectTypes) };
const parse = (row: Stored) => JSON.parse(row.rule) as unknown;
const historyCount = () => db.all("SELECT count(*) AS n FROM ontology_history")[0]?.n;

const catalogueEntries = () =>
  [
    ...KNOWLEDGE_SCHEMA.knowledgeTypes,
    ...KNOWLEDGE_SCHEMA.relationTypes,
    ...KNOWLEDGE_SCHEMA.factKinds,
  ].flatMap((e) => (e.rule ? [{ name: e.name, rule: e.rule }] : []));

describe("schema.catalogue-migration", () => {
  it("is the migration after S01's, one step, and raises the schema to 22", () => {
    expect(migrations).toHaveLength(S01_SCHEMA + 1);
    migrate(db);
    expect(schemaVersion(db)).toBe(S01_SCHEMA + 1);
  });

  it("seeds everything the catalogue lacks as verified, origin seed, and keeps the existing rows", () => {
    const project = insertItem(db, { type: "Project", name: "P", ...attrs });
    const system = insertItem(db, { type: "System", name: "S", ...attrs });
    saveFact(db, { itemId: project, kind: "target_date", value: "2026-12-01", ...attrs });
    saveRelation(db, { subjectId: project, type: "DEPENDS_ON", objectId: system, ...attrs });
    const before = ["items", "facts", "relations", "item_history", "fact_history"].map((t) =>
      db.all(`SELECT * FROM ${t}`),
    );
    const revision = readKnowledgeRevision(db);

    migrate(db);

    expect(
      ["items", "facts", "relations", "item_history", "fact_history"].map((t) =>
        db.all(`SELECT * FROM ${t}`),
      ),
    ).toEqual(before);
    const rows = stored();
    expect(rows).toHaveLength(PRODUCT_SEED.length);
    for (const seed of PRODUCT_SEED) {
      const row = one(seed.name, seed.elementKind);
      expect(row.status).toBe("verified");
      expect(row.origin).toBe("seed");
    }
    for (const entry of catalogueEntries()) {
      expect(parse(one(entry.name, entry.rule.elementKind))).toEqual(canon(entry.rule));
    }
    expect(rows.filter((r) => r.kind === "item-type")).toHaveLength(13);
    expect(rows.filter((r) => r.kind === "relation-type")).toHaveLength(6);
    expect(rows.filter((r) => r.kind === "fact-kind")).toHaveLength(9);
    // a seed adds no history line, and the upgrade does not move the knowledge revision
    expect(historyCount()).toBe(0);
    expect(readKnowledgeRevision(db)).toBe(revision);
  });

  it("passes every added change through S01's checks as applicable", () => {
    // the registry reader selects `origin`, so the database gets that one column (S01's rows stay as they are
    // and none of the catalogue's additions or widenings is made: the checks judge them before they exist)
    db.exec("ALTER TABLE ontology_elements ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    const additions = catalogueEntries().filter((e) => existingNames().every((n) => n !== e.name));
    // item types first: the rules of the others name them
    const addChange = (e: { name: string; rule: CatalogueRule }): OntologyChange => ({
      op: "add",
      name: e.name,
      rule: e.rule as ElementRule,
    });
    const itemTypes = additions.filter((e) => e.rule.elementKind === "item-type");
    expect(itemTypes).toHaveLength(10);
    for (const e of itemTypes) {
      expect(checkOntologyChange(db, addChange(e)).applicable).toBe(true);
      rawElement("item-type", e.name, ITEM, "verified");
    }
    const rest = additions.filter((e) => e.rule.elementKind !== "item-type");
    expect(rest).toHaveLength(8);
    for (const e of rest) {
      const check = checkOntologyChange(db, addChange(e));
      expect({ name: e.name, ...check }).toMatchObject({ applicable: true, schemaErrors: [] });
    }
    // the three widened rules, as rule changes of the seeded elements
    for (const name of ["target_date", "completion_date", "DEPENDS_ON"]) {
      const entry = catalogueEntries().find((e) => e.name === name);
      const kind = entry?.rule.elementKind as "fact-kind" | "relation-type";
      const check = checkOntologyChange(db, {
        op: "change-rule",
        elementKind: kind,
        name,
        rule: entry?.rule as ElementRule,
      });
      expect({ name, applicable: check.applicable }).toEqual({ name, applicable: true });
    }
  });

  it("widens the three rules while they are S01's seed rule, edition +1, no history line", () => {
    migrate(db);
    for (const name of ["target_date", "completion_date"]) {
      const row = one(name);
      expect(row.edition).toBe(2);
      expect(parse(row)).toMatchObject({ itemTypes: ["Commitment", "Project", "System", "Task"] });
    }
    const depends = one("DEPENDS_ON");
    expect(depends.edition).toBe(2);
    expect(parse(depends)).toEqual({
      elementKind: "relation-type",
      subjectTypes: ["Commitment", "Project", "System", "Task"],
      objectTypes: ["Commitment", "Dependency", "Project", "System", "Task"],
      symmetric: false,
    });
    expect(historyCount()).toBe(0);
    // an element that is not widened keeps edition 1
    expect(one("definition").edition).toBe(1);
    expect(one("Person").edition).toBe(1);
  });

  it("leaves a rule the user changed, a retired one and its edition alone (and the list says so)", () => {
    userChangesRule("DEPENDS_ON", { ...S01_DEPENDS_ON, subjectTypes: ["Project"] });
    db.run(
      "INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition) SELECT id, 1, ?, 'user', 'retire', 'verified', 'superseded', 1, 2 FROM ontology_elements WHERE name = 'completion_date'",
      [AT],
    );
    db.run(
      "UPDATE ontology_elements SET status = 'superseded', edition = 2 WHERE name = 'completion_date'",
    );
    migrate(db);
    const depends = one("DEPENDS_ON");
    expect(depends.edition).toBe(2);
    expect(parse(depends)).toEqual({ ...S01_DEPENDS_ON, subjectTypes: ["Project"] });
    const retired = one("completion_date");
    expect([retired.status, retired.edition]).toEqual(["superseded", 2]);
    expect(parse(retired)).toMatchObject({ itemTypes: ["Project", "System"] });
    // the one that was S01's seed rule is still widened
    expect(one("target_date").edition).toBe(2);
    expect(one("DEPENDS_ON").origin).toBe("seed");
  });

  it("keeps a name that already exists whatever its status, and fills origin by the four steps", () => {
    // 1. a lineage row: source-proposed (a rejected candidate)
    rawElement("item-type", "Task", ITEM, "rejected", { created: "extraction", basis: true });
    // 2. created by the user: user, so a Person the user added before stays the user's
    rawElement("item-type", "Person", ITEM, "verified", { created: "user" });
    // 3. a name in the product seed that no user created (another spec's seed that ran before): seed
    rawElement("item-type", "Decision", ITEM, "verified");
    // 4. the rest: user
    rawElement("item-type", "Widget", ITEM, "verified");
    // a proposal whose source is gone (its lineage row went with it) is still the automated actor's
    rawElement("item-type", "Event", ITEM, "verified", { created: "extraction" });
    rawElement("item-type", "Gadget", ITEM, "candidate", { created: "extraction", basis: true });
    // a lineage row with no creation line is source-proposed too (step 1 reads the lineage itself)
    rawElement("item-type", "Plan", ITEM, "candidate", { basis: true });
    // R19's duplicate comparison: a user's `organization` stands for the catalogue's `Organization`
    rawElement("item-type", "organization", ITEM, "verified", { created: "user" });
    const touched = [
      "Task",
      "Person",
      "Decision",
      "Widget",
      "Event",
      "Gadget",
      "Plan",
      "organization",
    ];
    const before = storedBefore().filter((r) => touched.includes(r.name));

    migrate(db);

    expect(one("Task")).toMatchObject({
      status: "rejected",
      origin: "source-proposed",
      edition: 1,
    });
    expect(one("Person")).toMatchObject({ status: "verified", origin: "user", edition: 1 });
    expect(one("Decision")).toMatchObject({ status: "verified", origin: "seed" });
    expect(one("Widget")).toMatchObject({ origin: "user" });
    expect(one("Event")).toMatchObject({ origin: "source-proposed" });
    expect(one("Gadget")).toMatchObject({ status: "candidate", origin: "source-proposed" });
    expect(one("Plan")).toMatchObject({ origin: "source-proposed" });
    expect(one("organization")).toMatchObject({ origin: "user" });
    expect(stored().filter((r) => r.name.toLowerCase() === "organization")).toHaveLength(1);
    // S01's own seed
    expect(one("Project").origin).toBe("seed");
    expect(one("alias.synonym").origin).toBe("seed");
    for (const row of before) {
      const after = one(row.name, row.kind);
      expect([after.rule, after.status, after.edition]).toEqual([
        row.rule,
        row.status,
        row.edition,
      ]);
    }
    // nothing doubled: one row per (kind, name)
    const names = stored().map((r) => `${r.kind}:${r.name}`);
    expect(new Set(names).size).toBe(names.length);
    // a kind-qualified match: a fact kind that has an item type's seed name is not a seed
    expect(stored().filter((r) => r.name === "Task")).toHaveLength(1);
  });

  it("matches the seed by kind: a user's fact kind named like a seed item type is the user's", () => {
    rawElement(
      "fact-kind",
      "Concept",
      { elementKind: "fact-kind", itemTypes: ["Project"], valueType: "text", cardinality: "many" },
      "verified",
    );
    migrate(db);
    expect(one("Concept", "fact-kind").origin).toBe("user");
    expect(one("Concept", "item-type").origin).toBe("seed");
  });

  it("keeps origin fixed, closed and not null, and the lifecycle and revision gates in force", () => {
    migrate(db);
    expect(() =>
      db.run("UPDATE ontology_elements SET origin = 'user' WHERE name = 'Person'"),
    ).toThrow(/origin/);
    expect(() =>
      db.run(
        "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('item-type', 'Zed', '{\"elementKind\":\"item-type\"}', 'verified', 1, 'bogus')",
      ),
    ).toThrow();
    expect(() =>
      db.run(
        "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('item-type', 'Zed', '{\"elementKind\":\"item-type\"}', 'verified', 1, NULL)",
      ),
    ).toThrow();
    // the migration re-made the lifecycle gate: a status change with no history line is still refused
    expect(() =>
      db.run("UPDATE ontology_elements SET status = 'rejected' WHERE name = 'Person'"),
    ).toThrow(/ontology gate/);
    expect(() =>
      db.run(
        "UPDATE ontology_elements SET rule = '{\"elementKind\":\"item-type\"}', edition = edition + 1 WHERE name = 'Person'",
      ),
    ).toThrow(/ontology gate/);
    // and the revision triggers are back: a later change moves the knowledge revision
    const revision = readKnowledgeRevision(db);
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('item-type', 'Zed', '{\"elementKind\":\"item-type\"}', 'verified', 1, 'user')",
    );
    expect(readKnowledgeRevision(db)).toBe(revision + 1);
  });
});

// R3: written when the row is made. A new row takes the origin of who makes it, and nothing later changes it.
describe("schema.catalogue-migration: origin of a row made after the migration", () => {
  const FRESH: ElementRule = { elementKind: "item-type" };
  const originOf = (name: string) =>
    db.all("SELECT origin FROM ontology_elements WHERE name = ?", [name])[0]?.origin;

  it("is `user` for the user's add and `source-proposed` for a proposal, and approving keeps it", () => {
    migrate(db);
    registerConnectorInstance(db, "c", "test-fixtures");
    const saved = saveSourceRecord(db, "c", { externalId: "d", title: "t", body: "본문" });
    if (saved.status !== "created") throw new Error(saved.status);
    expect(applyUserOntologyChange(db, { op: "add", name: "UserTerm", rule: FRESH })).toMatchObject(
      {
        status: "applied",
      },
    );
    const proposed = applyOntologyChange(
      db,
      { op: "add", name: "ProposedTerm", rule: FRESH },
      "extraction",
      { sourceId: saved.sourceId, version: saved.version },
    );
    if (proposed.status !== "candidate") throw new Error(proposed.status);
    expect(originOf("UserTerm")).toBe("user");
    expect(originOf("ProposedTerm")).toBe("source-proposed");
    expect(userOntology.decide(db, proposed.id, "approve")).toMatchObject({ status: "applied" });
    expect(originOf("ProposedTerm")).toBe("source-proposed");
    // the seed's rows stay `seed` through a user's rule change
    expect(
      applyUserOntologyChange(db, {
        op: "change-rule",
        elementKind: "relation-type",
        name: "BELONGS_TO",
        rule: {
          elementKind: "relation-type",
          subjectTypes: ["Person"],
          objectTypes: ["Project"],
          symmetric: false,
        },
      }),
    ).toMatchObject({ status: "applied" });
    expect(originOf("BELONGS_TO")).toBe("seed");
  });

  it("takes the value type `identifier` as a fact kind's: a non-empty value fits, an empty one does not", () => {
    migrate(db);
    expect(valueFits("identifier", "ab@example.test")).toBe(true);
    expect(valueFits("identifier", "  ")).toBe(false);
    expect(
      applyUserOntologyChange(db, {
        op: "add",
        name: "identifier.badge",
        rule: {
          elementKind: "fact-kind",
          itemTypes: ["Person"],
          valueType: "identifier",
          cardinality: "one",
        },
      }),
    ).toMatchObject({ status: "applied" });
    expect(factValueFit(db, "identifier.email", "a@example.test")).toBe("fits");
    expect(factValueFit(db, "identifier.email", " ")).toBe("misfit");
  });
});

describe("schema.catalogue-migration: the list over a database that held same-named rows", () => {
  const listed = () => {
    const list = describeKnowledgeSchema(listOntologyElements(db));
    return (name: string) => {
      const found = list.entries.filter((e) => e.name === name);
      expect(found).toHaveLength(1);
      return found[0] as (typeof list.entries)[number];
    };
  };

  it("answers a rejected name unusable, a user's usable, a user-changed rule not the catalogue's, and a squash variant as the user's row", () => {
    rawElement("item-type", "Task", ITEM, "rejected", { created: "extraction", basis: true });
    rawElement("item-type", "Person", ITEM, "verified", { created: "user" });
    rawElement("item-type", "organization", ITEM, "verified", { created: "user" });
    userChangesRule("DEPENDS_ON", { ...S01_DEPENDS_ON, subjectTypes: ["Project"] });
    migrate(db);
    const entry = listed();
    expect(entry("Task")).toMatchObject({ usable: false, ruleMatches: true });
    expect(entry("Person")).toMatchObject({ usable: true, ruleMatches: true });
    expect(entry("DEPENDS_ON")).toMatchObject({ usable: true, ruleMatches: false });
    // the migration took `organization` for the same name (R19), so the list does too: the user's row, usable
    expect(entry("Organization")).toMatchObject({ usable: true, ruleMatches: true });
    expect(one("organization").origin).toBe("user");
  });
});

describe("schema.catalogue-migration: the migration's own rows", () => {
  it("re-makes the lifecycle gate with the text v21 gave it", () => {
    const gate = () =>
      db.all("SELECT sql FROM sqlite_master WHERE name = 'ontology_elements_lifecycle_gate'")[0]
        ?.sql;
    const before = gate();
    expect(before).toBeTypeOf("string");
    migrate(db);
    expect(gate()).toBe(before);
  });
});

describe("schema.reserved-names: a row that existed before the rule", () => {
  it("can come back from a retirement though its name is now reserved", () => {
    const id = rawElement("item-type", "Insight", ITEM, "verified", { created: "user" });
    db.run(
      `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition)
       VALUES (?, 2, ?, 'user', 'retire', 'verified', 'superseded', 1, 2)`,
      [id, AT],
    );
    db.run("UPDATE ontology_elements SET status = 'superseded', edition = 2 WHERE id = ?", [id]);
    migrate(db);
    expect(userOntology.undo(db, id)).toMatchObject({ status: "applied" });
    expect(one("Insight").status).toBe("verified");
  });
});
