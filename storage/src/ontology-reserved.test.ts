// S02-T01 `schema.reserved-names` (S02-R3, C1): the names the product keeps for what is computed or stored
// elsewhere cannot be added as type definitions. The shape check refuses them with `reserved-name`, for a
// name that differs only in case or separators, and a check-only call answers the same. Nothing is written.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import {
  applyOntologyChange,
  applyUserOntologyChange,
  checkOntologyChange,
  listOntologyElements,
  type ElementRule,
  type OntologyChange,
} from "./ontology.ts";
import { readKnowledgeRevision } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { memoryDbTemplate } from "@pki/testkit";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => db.close());

const ITEM: ElementRule = { elementKind: "item-type" };
const RELATION: ElementRule = {
  elementKind: "relation-type",
  subjectTypes: ["Project"],
  objectTypes: ["System"],
  symmetric: false,
};
const FACT: ElementRule = {
  elementKind: "fact-kind",
  itemTypes: ["Project"],
  valueType: "text",
  cardinality: "many",
};
const add = (name: string, rule: ElementRule): OntologyChange => ({ op: "add", name, rule });

const RELATION_NAMES = ["MENTIONS", "SUPPORTS", "DERIVED_FROM", "SUPERSEDES", "CONTRADICTS"];
const ITEM_NAMES = ["Document", "Fact", "Insight"];
// the same names with only case or separators changed: R19's duplicate comparison drops both
const VARIANTS = [
  "mentions",
  "Supports",
  "derived_from",
  "DerivedFrom",
  "super.sedes",
  "contradicts",
  "document",
  "F_act",
  "INSIGHT",
];

describe("schema.reserved-names", () => {
  it.each(RELATION_NAMES)("refuses %s as a relation type", (name) => {
    expect(checkOntologyChange(db, add(name, RELATION))).toMatchObject({
      applicable: false,
      schemaErrors: ["reserved-name"],
    });
  });

  it.each(ITEM_NAMES)("refuses %s as an item type", (name) => {
    expect(checkOntologyChange(db, add(name, ITEM))).toMatchObject({
      applicable: false,
      schemaErrors: ["reserved-name"],
    });
  });

  it.each(VARIANTS)("refuses the variant %s", (name) => {
    for (const rule of [ITEM, RELATION]) {
      expect(checkOntologyChange(db, add(name, rule)).schemaErrors).toContain("reserved-name");
    }
  });

  it("refuses them as a fact kind too (a type definition of any kind cannot take the name)", () => {
    expect(checkOntologyChange(db, add("Fact", FACT)).schemaErrors).toContain("reserved-name");
  });

  it("adds nothing and writes no history when the user or an automated actor tries", () => {
    const before = listOntologyElements(db);
    const revision = readKnowledgeRevision(db);
    for (const name of [...RELATION_NAMES, ...ITEM_NAMES]) {
      const rule = RELATION_NAMES.includes(name) ? RELATION : ITEM;
      expect(applyUserOntologyChange(db, add(name, rule))).toMatchObject({
        status: "refused",
        reason: "schema-invalid",
        schemaErrors: ["reserved-name"],
      });
    }
    const saved = saveSourceRecord(db, "c", { externalId: "doc", title: "t", body: "본문" });
    if (saved.status !== "created") throw new Error(saved.status);
    const automated = applyOntologyChange(db, add("SUPPORTS", RELATION), "extraction", {
      sourceId: saved.sourceId,
      version: saved.version,
    });
    expect(automated).toMatchObject({ status: "refused", reason: "schema-invalid" });
    expect(listOntologyElements(db)).toEqual(before);
    expect(db.all("SELECT count(*) AS n FROM ontology_history")[0]?.n).toBe(0);
    expect(readKnowledgeRevision(db)).toBe(revision);
  });

  it("does not refuse a name that only looks like one (the contrast the guard needs)", () => {
    for (const [name, rule] of [
      ["Documents", ITEM],
      ["FactSheet", ITEM],
      ["SUPPORTED_BY", RELATION],
      ["Insights", ITEM],
    ] as const) {
      expect(checkOntologyChange(db, add(name, rule))).toMatchObject({
        schemaErrors: [],
        applicable: true,
      });
    }
  });

  it("leaves an existing row of a reserved name alone: only an add is judged", () => {
    // a user may have added such a name before the rule existed; it stays, and a change of its rule is not a new name
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES ('item-type', 'Fact', '{\"elementKind\":\"item-type\"}', 'verified', 1, 'user')",
    );
    expect(
      checkOntologyChange(db, { op: "retire", elementKind: "item-type", name: "Fact" })
        .schemaErrors,
    ).toEqual([]);
  });
});
