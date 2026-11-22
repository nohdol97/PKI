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

/** The value types a fact kind's rule may name: S01's three, S02's `identifier`, S03-R3's nine. */
export const FACT_VALUE_TYPES = [
  "date",
  "text",
  "surface-form",
  "identifier",
  "header",
  "column",
  "column-set",
  "calculation",
  "key-pairs",
  "join-cardinality",
  "period",
  "currency",
  "dataset-role",
] as const;
export type FactValueType = (typeof FACT_VALUE_TYPES)[number];
/** The checks a rule may require of a row before it can be `verified` (S03-R13). */
export const DATA_CHECK_NAMES = ["schema", "grain", "join-cardinality", "aggregation"] as const;
export type DataCheckName = (typeof DATA_CHECK_NAMES)[number];

/** A type definition's rule (S01-R18). Plain lists, so the catalogue is data. */
export type CatalogueRule =
  | { elementKind: "item-type" }
  | {
      elementKind: "fact-kind";
      itemTypes: readonly string[];
      valueType: FactValueType;
      cardinality: "one" | "many";
      /** S03-R13: the checks the row needs; absent or empty means none. */
      dataChecks?: readonly DataCheckName[];
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
  /** The edition that added the name; absent means 1. A migration of that edition writes the row. */
  since?: number;
  /** The edition that widened the rule of a name an earlier edition added; the migration of that edition does it. */
  widenedAt?: number;
  /** The name is seeded but extraction never writes it: the instruction and the response schema leave it out (S03-R2). */
  notExtracted?: true;
}
export interface KnowledgeCatalogue {
  edition: number;
  knowledgeTypes: readonly CatalogueEntry[];
  relationTypes: readonly CatalogueEntry[];
  factKinds: readonly CatalogueEntry[];
}

const itemType = (name: string, since?: number): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: { elementKind: "item-type" },
  ...(since === undefined ? {} : { since }),
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
  since?: number,
): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: { elementKind: "relation-type", subjectTypes, objectTypes, symmetric },
  ...(since === undefined ? {} : { since }),
});
const factKind = (
  name: string,
  itemTypes: readonly string[],
  valueType: FactValueType,
  cardinality: "one" | "many",
  extra: {
    dataChecks?: readonly DataCheckName[];
    since?: number;
    widenedAt?: number;
    notExtracted?: true;
  } = {},
): CatalogueEntry => ({
  name,
  place: "type-definition",
  rule: {
    elementKind: "fact-kind",
    itemTypes,
    valueType,
    cardinality,
    ...(extra.dataChecks ? { dataChecks: extra.dataChecks } : {}),
  },
  ...(extra.since === undefined ? {} : { since: extra.since }),
  ...(extra.widenedAt === undefined ? {} : { widenedAt: extra.widenedAt }),
  ...(extra.notExtracted ? { notExtracted: true as const } : {}),
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
  edition: 2,
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
    itemType("Dataset", 2),
    itemType("Metric", 2),
    itemType("Join", 2),
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
    relation("MEASURED_ON", ["Metric"], ["Dataset"], false, 2),
    relation("JOIN_LEFT", ["Join"], ["Dataset"], false, 2),
    relation("JOIN_RIGHT", ["Join"], ["Dataset"], false, 2),
    relation("USES_JOIN", ["Metric"], ["Join"], false, 2),
  ],
  factKinds: [
    factKind("target_date", ["Project", "System", "Task", "Commitment"], "date", "one"),
    factKind("completion_date", ["Project", "System", "Task", "Commitment"], "date", "one"),
    factKind("definition", ["Concept", "Metric", "Dataset"], "text", "many", { widenedAt: 2 }),
    factKind(
      "alias.synonym",
      ["Concept", "Project", "System", "Metric", "Dataset"],
      "surface-form",
      "many",
      { widenedAt: 2 },
    ),
    factKind(
      "alias.abbreviation",
      ["Concept", "Project", "System", "Metric", "Dataset"],
      "surface-form",
      "many",
      { widenedAt: 2 },
    ),
    factKind(
      "alias.translation",
      ["Concept", "Project", "System", "Metric", "Dataset"],
      "surface-form",
      "many",
      { widenedAt: 2 },
    ),
    factKind("identifier.email", ["Person", "Organization"], "identifier", "many"),
    factKind("identifier.key", ITEM_TYPES, "identifier", "one"),
    factKind("statement", STATEMENT_TYPES, "text", "many"),
    // S03-R2 (edition 2): the analytical type definitions
    factKind("dataset.column", ["Dataset"], "header", "many", { since: 2, notExtracted: true }),
    factKind("dataset.role", ["Dataset"], "dataset-role", "one", { since: 2 }),
    factKind("dataset.grain", ["Dataset"], "column-set", "one", {
      since: 2,
      dataChecks: ["schema", "grain"],
    }),
    factKind("dataset.measure", ["Dataset"], "column", "many", {
      since: 2,
      dataChecks: ["schema"],
    }),
    factKind("dataset.dimension", ["Dataset"], "column", "many", {
      since: 2,
      dataChecks: ["schema"],
    }),
    factKind("dataset.time_dimension", ["Dataset"], "column", "many", {
      since: 2,
      dataChecks: ["schema"],
    }),
    factKind("metric.calculation", ["Metric"], "calculation", "one", {
      since: 2,
      dataChecks: ["schema", "aggregation"],
    }),
    factKind("metric.unit", ["Metric"], "text", "one", { since: 2 }),
    factKind("metric.version", ["Metric"], "text", "one", { since: 2 }),
    factKind("metric.currency", ["Metric"], "currency", "one", { since: 2 }),
    factKind("metric.period", ["Metric"], "period", "one", { since: 2 }),
    factKind("join.keys", ["Join"], "key-pairs", "one", { since: 2, dataChecks: ["schema"] }),
    factKind("join.cardinality", ["Join"], "join-cardinality", "one", {
      since: 2,
      dataChecks: ["join-cardinality"],
    }),
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
  "Dataset",
  "Metric",
  "Join",
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
  "MEASURED_ON",
  "JOIN_LEFT",
  "JOIN_RIGHT",
  "USES_JOIN",
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

/**
 * The product seed (S02-R1, R3): every name the product puts into the type definitions, by kind, with the
 * edition that added it (`since`, 1 when the catalogue does not say).
 */
export const PRODUCT_SEED: readonly {
  elementKind: "item-type" | "fact-kind" | "relation-type";
  name: string;
  since: number;
}[] = [KNOWLEDGE_SCHEMA.knowledgeTypes, KNOWLEDGE_SCHEMA.relationTypes, KNOWLEDGE_SCHEMA.factKinds]
  .flat()
  .flatMap((entry) =>
    entry.rule
      ? [{ elementKind: entry.rule.elementKind, name: entry.name, since: entry.since ?? 1 }]
      : [],
  );

/** The seeded names extraction never writes (S03-R2): left out of the instruction and the response schema. */
export const NOT_EXTRACTED_NAMES: readonly string[] = [
  KNOWLEDGE_SCHEMA.knowledgeTypes,
  KNOWLEDGE_SCHEMA.relationTypes,
  KNOWLEDGE_SCHEMA.factKinds,
]
  .flat()
  .filter((entry) => entry.notExtracted)
  .map((entry) => entry.name);

/** The names no type definition may take (S02-R3): those stored or computed elsewhere. */
export const RESERVED_NAMES: readonly string[] = [
  KNOWLEDGE_SCHEMA.knowledgeTypes,
  KNOWLEDGE_SCHEMA.relationTypes,
].flatMap((list) => list.filter((entry) => entry.place !== "type-definition").map((e) => e.name));
