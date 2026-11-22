// S02-T01 `schema.catalogue` (S02-R1, C1): the versioned knowledge-schema catalogue. The edition is 1, the
// knowledge types are exactly the sixteen of issue #23's S02-C1, the relation types exactly the eleven of the
// original design's section 7, and every name has a place. `checkCatalogue` is the guard: it returns the
// problems of a catalogue, and the red cases below show it fails when a name is dropped or a place emptied.
import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_SCHEMA,
  PRODUCT_SEED,
  RESERVED_NAMES,
  checkCatalogue,
  type KnowledgeCatalogue,
} from "./knowledge-schema.ts";

// literal copies of the two sources, so a drift of the catalogue fails here
const KNOWLEDGE_TYPES = [
  "Person",
  "Organization",
  "Project",
  "System",
  "Concept",
  "Document",
  "Fact",
  "Decision",
  "Task",
  "Commitment",
  "Event",
  "Issue",
  "Dependency",
  "BusinessRule",
  "OpenQuestion",
  "Insight",
  // edition 2 (S03-R2)
  "Dataset",
  "Metric",
  "Join",
];
const RELATION_TYPES = [
  "BELONGS_TO",
  "RESPONSIBLE_FOR",
  "DEPENDS_ON",
  "RELATED_TO",
  "DECIDED",
  "CAUSED_BY",
  "MENTIONS",
  "SUPPORTS",
  "DERIVED_FROM",
  "SUPERSEDES",
  "CONTRADICTS",
  // edition 2 (S03-R2)
  "MEASURED_ON",
  "JOIN_LEFT",
  "JOIN_RIGHT",
  "USES_JOIN",
];
type Mutable = { -readonly [K in keyof KnowledgeCatalogue]: Mutable2<KnowledgeCatalogue[K]> };
type Mutable2<T> = T extends readonly (infer E)[] ? E[] : T;
const clone = (): Mutable => ({
  edition: KNOWLEDGE_SCHEMA.edition,
  knowledgeTypes: [...KNOWLEDGE_SCHEMA.knowledgeTypes],
  relationTypes: [...KNOWLEDGE_SCHEMA.relationTypes],
  factKinds: [...KNOWLEDGE_SCHEMA.factKinds],
});

describe("schema.catalogue", () => {
  it("is edition 2 with exactly nineteen knowledge types and fifteen relation types", () => {
    expect(KNOWLEDGE_SCHEMA.edition).toBe(2);
    expect(KNOWLEDGE_SCHEMA.knowledgeTypes.map((e) => e.name)).toEqual(KNOWLEDGE_TYPES);
    expect(KNOWLEDGE_SCHEMA.relationTypes.map((e) => e.name)).toEqual(RELATION_TYPES);
    expect(KNOWLEDGE_SCHEMA.knowledgeTypes).toHaveLength(19);
    expect(KNOWLEDGE_SCHEMA.relationTypes).toHaveLength(15);
  });

  it("gives every name a place, and the places the spec's tables name", () => {
    const place = (list: readonly { name: string; place: string }[]) =>
      Object.fromEntries(list.map((e) => [e.name, e.place]));
    const types = place(KNOWLEDGE_SCHEMA.knowledgeTypes);
    expect(types.Document).toBe("sources");
    expect(types.Fact).toBe("facts");
    expect(types.Insight).toBe("insights");
    expect(Object.values(types).filter((p) => p === "type-definition")).toHaveLength(16);
    const relations = place(KNOWLEDGE_SCHEMA.relationTypes);
    for (const name of RELATION_TYPES.slice(0, 6)) expect(relations[name]).toBe("type-definition");
    expect(relations.MENTIONS).toBe("computed");
    expect(relations.SUPPORTS).toBe("computed");
    expect(relations.DERIVED_FROM).toBe("computed");
    expect(relations.SUPERSEDES).toBe("assertion-links");
    expect(relations.CONTRADICTS).toBe("assertion-links");
    expect(checkCatalogue(KNOWLEDGE_SCHEMA)).toEqual([]);
  });

  it("carries the relation directions of the spec's table", () => {
    const rule = (name: string) =>
      KNOWLEDGE_SCHEMA.relationTypes.find((e) => e.name === name)?.rule;
    expect(rule("DECIDED")).toEqual({
      elementKind: "relation-type",
      subjectTypes: ["Person", "Organization"],
      objectTypes: ["Decision"],
      symmetric: false,
    });
    expect(rule("RELATED_TO")).toMatchObject({ symmetric: true });
    expect(rule("DEPENDS_ON")).toMatchObject({
      subjectTypes: ["Project", "System", "Task", "Commitment"],
      objectTypes: ["Project", "System", "Task", "Commitment", "Dependency"],
    });
    for (const name of RELATION_TYPES.filter((n) => n !== "RELATED_TO").slice(0, 5)) {
      expect(rule(name)).toMatchObject({ symmetric: false });
    }
  });

  it("derives the product seed and the reserved names from the catalogue alone", () => {
    const seeded = PRODUCT_SEED.map((e) => `${e.elementKind}:${e.name}`);
    expect(new Set(seeded).size).toBe(seeded.length);
    expect(PRODUCT_SEED.filter((e) => e.elementKind === "item-type")).toHaveLength(16);
    expect(PRODUCT_SEED.filter((e) => e.elementKind === "relation-type")).toHaveLength(10);
    expect(PRODUCT_SEED.filter((e) => e.elementKind === "fact-kind").map((e) => e.name)).toEqual([
      "target_date",
      "completion_date",
      "definition",
      "alias.synonym",
      "alias.abbreviation",
      "alias.translation",
      "identifier.email",
      "identifier.key",
      "statement",
      "dataset.column",
      "dataset.role",
      "dataset.grain",
      "dataset.measure",
      "dataset.dimension",
      "dataset.time_dimension",
      "metric.calculation",
      "metric.unit",
      "metric.version",
      "metric.currency",
      "metric.period",
      "join.keys",
      "join.cardinality",
    ]);
    expect([...RESERVED_NAMES].sort()).toEqual(
      [
        "MENTIONS",
        "SUPPORTS",
        "DERIVED_FROM",
        "SUPERSEDES",
        "CONTRADICTS",
        "Document",
        "Fact",
        "Insight",
      ].sort(),
    );
    // a name that has a place outside the type definitions is never seeded
    expect(seeded.some((s) => RESERVED_NAMES.includes(s.split(":")[1] as string))).toBe(false);
  });

  it("fails when a name is dropped (red case)", () => {
    const dropped = clone();
    dropped.knowledgeTypes = dropped.knowledgeTypes.filter((e) => e.name !== "Person");
    expect(checkCatalogue(dropped).length).toBeGreaterThan(0);
    const droppedRelation = clone();
    droppedRelation.relationTypes = droppedRelation.relationTypes.slice(1);
    expect(checkCatalogue(droppedRelation).length).toBeGreaterThan(0);
  });

  it("fails when a place is emptied (red case)", () => {
    const emptied = clone();
    emptied.knowledgeTypes = emptied.knowledgeTypes.map((e) =>
      e.name === "Document" ? { ...e, place: "" as never } : e,
    );
    expect(checkCatalogue(emptied).length).toBeGreaterThan(0);
    const ruleless = clone();
    ruleless.knowledgeTypes = ruleless.knowledgeTypes.map((e) =>
      e.name === "Person" ? { ...e, rule: null } : e,
    );
    expect(checkCatalogue(ruleless).length).toBeGreaterThan(0);
  });

  it("fails on a wrong edition or a repeated name (red case)", () => {
    expect(checkCatalogue({ ...clone(), edition: 0 }).length).toBeGreaterThan(0);
    const repeated = clone();
    repeated.factKinds = [...repeated.factKinds, ...repeated.factKinds.slice(0, 1)];
    expect(checkCatalogue(repeated).length).toBeGreaterThan(0);
  });
});
