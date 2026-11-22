// The versioned knowledge-schema catalogue (S02-R1): one code constant naming every knowledge type,
// relation type and fact kind the product knows, the place each is stored, and, for the ones kept as type
// definitions (S01-R18), the rule they are seeded with. A later spec adds to this catalogue and raises
// the edition; the migration that follows writes the rows. The product seed constant and the names a
// type definition may not take are derived from it, so the three never disagree.

/** Where a name is stored: a type definition (`ontology_elements`), or one of the canonical tables. */
export const KNOWLEDGE_PLACES = [
  "type-definition",
  "sources",
  "facts",
  "insights",
  "computed",
  "assertion-links",
] as const;
export type KnowledgePlace = (typeof KNOWLEDGE_PLACES)[number];

/** A type definition's rule (S01-R18). Plain lists, so the catalogue is data. */
export type CatalogueRule =
  | { elementKind: "item-type" }
  | {
      elementKind: "fact-kind";
      itemTypes: readonly string[];
      valueType: "date" | "text" | "surface-form" | "identifier";
      cardinality: "one" | "many";
    }
  | {
      elementKind: "relation-type";
      subjectTypes: readonly string[];
      objectTypes: readonly string[];
      symmetric: boolean;
    };

export interface CatalogueEntry {
  name: string;
  place: KnowledgePlace;
  /** The seed rule when the place is a type definition, otherwise null. */
  rule: CatalogueRule | null;
}
export interface KnowledgeCatalogue {
  edition: number;
  knowledgeTypes: readonly CatalogueEntry[];
  relationTypes: readonly CatalogueEntry[];
  factKinds: readonly CatalogueEntry[];
}

const itemType = (name: string): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: { elementKind: "item-type" },
});
const elsewhere = (name: string, place: KnowledgePlace): CatalogueEntry => ({
  name,
  place,
  rule: null,
});
const relation = (
  name: string,
  subjectTypes: readonly string[],
  objectTypes: readonly string[],
  symmetric = false,
): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: { elementKind: "relation-type", subjectTypes, objectTypes, symmetric },
});
const factKind = (
  name: string,
  itemTypes: readonly string[],
  valueType: "date" | "text" | "surface-form" | "identifier",
  cardinality: "one" | "many",
): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: { elementKind: "fact-kind", itemTypes, valueType, cardinality },
});

/** The thirteen item types that are type definitions. */
const ITEM_TYPES = [
  "Person",
  "Organization",
  "Project",
  "System",
  "Concept",
  "Decision",
  "Task",
  "Commitment",
  "Event",
  "Issue",
  "Dependency",
  "BusinessRule",
  "OpenQuestion",
] as const;
const STATEMENT_TYPES = [
  "Decision",
  "Task",
  "Commitment",
  "Event",
  "Issue",
  "Dependency",
  "BusinessRule",
  "OpenQuestion",
];

export const KNOWLEDGE_SCHEMA: KnowledgeCatalogue = {
  edition: 1,
  knowledgeTypes: [
    itemType("Person"),
    itemType("Organization"),
    itemType("Project"),
    itemType("System"),
    itemType("Concept"),
    elsewhere("Document", "sources"),
    elsewhere("Fact", "facts"),
    itemType("Decision"),
    itemType("Task"),
    itemType("Commitment"),
    itemType("Event"),
    itemType("Issue"),
    itemType("Dependency"),
    itemType("BusinessRule"),
    itemType("OpenQuestion"),
    elsewhere("Insight", "insights"),
  ],
  relationTypes: [
    relation(
      "BELONGS_TO",
      ["Person", "Organization", "Project", "System", "Task"],
      ["Organization", "Project"],
    ),
    relation(
      "RESPONSIBLE_FOR",
      ["Person", "Organization"],
      ["Project", "System", "Task", "Commitment", "Issue", "Decision"],
    ),
    relation(
      "DEPENDS_ON",
      ["Project", "System", "Task", "Commitment"],
      ["Project", "System", "Task", "Commitment", "Dependency"],
    ),
    relation("RELATED_TO", ITEM_TYPES, ITEM_TYPES, true),
    relation("DECIDED", ["Person", "Organization"], ["Decision"]),
    relation(
      "CAUSED_BY",
      ["Issue", "Event", "Decision", "Task"],
      ["Issue", "Event", "Decision", "Dependency", "BusinessRule"],
    ),
    elsewhere("MENTIONS", "computed"),
    elsewhere("SUPPORTS", "computed"),
    elsewhere("DERIVED_FROM", "computed"),
    elsewhere("SUPERSEDES", "assertion-links"),
    elsewhere("CONTRADICTS", "assertion-links"),
  ],
  factKinds: [
    factKind("target_date", ["Project", "System", "Task", "Commitment"], "date", "one"),
    factKind("completion_date", ["Project", "System", "Task", "Commitment"], "date", "one"),
    factKind("definition", ["Concept"], "text", "many"),
    factKind("alias.synonym", ["Concept", "Project", "System"], "surface-form", "many"),
    factKind("alias.abbreviation", ["Concept", "Project", "System"], "surface-form", "many"),
    factKind("alias.translation", ["Concept", "Project", "System"], "surface-form", "many"),
    factKind("identifier.email", ["Person", "Organization"], "identifier", "many"),
    factKind("identifier.key", ITEM_TYPES, "identifier", "one"),
    factKind("statement", STATEMENT_TYPES, "text", "many"),
  ],
};

// What the catalogue must hold, written out literally: the sixteen of issue #23's S02-C1 and the eleven
// "representative relations" of the original design's section 7. `checkCatalogue` is the guard that keeps
// the catalogue from losing a name or a place; a later spec that adds a type edits these lists with it.
const REQUIRED_KNOWLEDGE_TYPES = [
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
];
const REQUIRED_RELATION_TYPES = [
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
];

/** The problems of a catalogue as fixed codes with the name: empty when it is sound. */
export function checkCatalogue(catalogue: KnowledgeCatalogue): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(catalogue.edition) || catalogue.edition < 1) problems.push("edition");
  const groups = [
    ["item-type", "knowledgeTypes", REQUIRED_KNOWLEDGE_TYPES],
    ["relation-type", "relationTypes", REQUIRED_RELATION_TYPES],
    ["fact-kind", "factKinds", null],
  ] as const;
  for (const [elementKind, key, required] of groups) {
    const entries = catalogue[key];
    const names = entries.map((e) => e.name);
    if (new Set(names).size !== names.length) problems.push(`${key}: repeated name`);
    for (const name of required ?? []) {
      if (!names.includes(name)) problems.push(`${key}: missing ${name}`);
    }
    for (const entry of entries) {
      if (!KNOWLEDGE_PLACES.includes(entry.place))
        problems.push(`${key}: no place for ${entry.name}`);
      else if ((entry.place === "type-definition") !== (entry.rule !== null)) {
        problems.push(`${key}: place and rule disagree for ${entry.name}`);
      } else if (entry.rule && entry.rule.elementKind !== elementKind) {
        problems.push(`${key}: rule of another kind for ${entry.name}`);
      }
    }
  }
  return problems;
}

/** The product seed (S02-R1, R3): every name the product puts into the type definitions, by kind. */
export const PRODUCT_SEED: readonly {
  elementKind: "item-type" | "fact-kind" | "relation-type";
  name: string;
}[] = [KNOWLEDGE_SCHEMA.knowledgeTypes, KNOWLEDGE_SCHEMA.relationTypes, KNOWLEDGE_SCHEMA.factKinds]
  .flat()
  .flatMap((entry) =>
    entry.rule ? [{ elementKind: entry.rule.elementKind, name: entry.name }] : [],
  );

/** The names no type definition may take (S02-R3): those stored or computed elsewhere. */
export const RESERVED_NAMES: readonly string[] = [
  KNOWLEDGE_SCHEMA.knowledgeTypes,
  KNOWLEDGE_SCHEMA.relationTypes,
].flatMap((list) => list.filter((entry) => entry.place !== "type-definition").map((e) => e.name));
