// S01-T08 `extract.v3` and S02-T02 `extract.v4` (schema part; S01-R17, S02-R4): the extraction answer
// of schema version 4 holds items (thirteen types), facts (the dates and the identifiers, with the
// validity interval and the context tag), the six relations, `terms` (surface forms), `definitions`
// (of the kind definition or statement) and `proposedTypes`, and every fact, relation, term and
// definition may carry a `confidence`. The schema checks the shape only; what the numbers and quotes
// mean is judged by the handler (knowledge-engine). The names the instruction lists, the response
// schema's closed lists, the knowledge-schema catalogue and the seed are compared here. All data is
// synthetic.
import { KNOWLEDGE_SCHEMA } from "@pki/contracts";
import { describe, expect, it } from "vitest";
import {
  EXTRACT_ALIAS_FACT_KINDS,
  EXTRACT_DEFINITION_FACT_KIND,
  EXTRACT_DEFINITION_KINDS,
  EXTRACT_DEFINITION_MAX_CODE_POINTS,
  EXTRACT_FACT_KINDS,
  EXTRACT_IDENTIFIER_FACT_KINDS,
  EXTRACT_ITEM_TYPES,
  EXTRACT_MAX_PROPOSED_TYPES,
  EXTRACT_RELATION_TYPES,
  EXTRACT_SCHEMA_VERSION,
  EXTRACT_STATEMENT_FACT_KIND,
  EXTRACT_TERM_KINDS,
  TASKS,
  type ExtractionOutput,
} from "./index.ts";

const task = TASKS.extract[EXTRACT_SCHEMA_VERSION];
const parse = (value: unknown) => task.output.safeParse(value);
const concept = { ref: "c", type: "Concept", name: "미리내 용어", existingItemId: null };
const v3 = {
  items: [concept],
  facts: [],
  relations: [],
  terms: [{ item: "c", form: "ML", kind: "abbreviation", quote: "미리내 용어(ML)" }],
  definitions: [
    { item: "c", quote: "미리내 용어는 예시다", context: "결제", epistemic: "explicit" },
  ],
};

describe("extract.v4: the schema", () => {
  it("is version 4, the only extract version listed (a request for 3 is an unlisted version)", () => {
    expect(EXTRACT_SCHEMA_VERSION).toBe(4);
    expect(Object.keys(TASKS.extract)).toEqual(["4"]);
    expect(EXTRACT_DEFINITION_MAX_CODE_POINTS).toBe(500);
  });

  it("reads an answer with terms and definitions", () => {
    const result = parse(v3);
    expect(result.success).toBe(true);
    const data = result.data as ExtractionOutput;
    expect(data.terms[0]).toEqual(v3.terms[0]);
    expect(data.definitions[0]).toEqual(v3.definitions[0]);
  });

  it("rejects a version-2-shaped answer and one missing either list: an answer that found none carries []", () => {
    expect(parse({ items: [], facts: [], relations: [] }).success).toBe(false);
    const withoutTerms: Record<string, unknown> = { ...v3 };
    delete withoutTerms.terms;
    const withoutDefinitions: Record<string, unknown> = { ...v3 };
    delete withoutDefinitions.definitions;
    expect(parse(withoutTerms).success).toBe(false);
    expect(parse(withoutDefinitions).success).toBe(false);
    expect(parse({ items: [], facts: [], relations: [], terms: [], definitions: [] }).success).toBe(
      true,
    );
  });

  it("names the types and kinds the prompt lists, the seed's own names", () => {
    expect([...EXTRACT_ITEM_TYPES].sort()).toEqual(
      [
        "BusinessRule",
        "Commitment",
        "Concept",
        "Decision",
        "Dependency",
        "Event",
        "Issue",
        "OpenQuestion",
        "Organization",
        "Person",
        "Project",
        "System",
        "Task",
      ].sort(),
    );
    expect([...EXTRACT_FACT_KINDS].sort()).toEqual(["completion_date", "target_date"]);
    expect([...EXTRACT_IDENTIFIER_FACT_KINDS]).toEqual(["identifier.email", "identifier.key"]);
    expect([...EXTRACT_RELATION_TYPES].sort()).toEqual(
      ["BELONGS_TO", "CAUSED_BY", "DECIDED", "DEPENDS_ON", "RELATED_TO", "RESPONSIBLE_FOR"].sort(),
    );
    expect([...EXTRACT_TERM_KINDS]).toEqual(["synonym", "abbreviation", "translation"]);
    expect([...EXTRACT_ALIAS_FACT_KINDS]).toEqual([
      "alias.synonym",
      "alias.abbreviation",
      "alias.translation",
    ]);
    expect(EXTRACT_DEFINITION_FACT_KIND).toBe("definition");
    expect(EXTRACT_STATEMENT_FACT_KIND).toBe("statement");
    expect([...EXTRACT_DEFINITION_KINDS]).toEqual(["definition", "statement"]);
    expect(EXTRACT_MAX_PROPOSED_TYPES).toBe(5);
  });

  it("takes confidence where S01-R17 puts it, and leaves its range to the handler", () => {
    const withConfidence = {
      items: [concept, { ...concept, ref: "p", type: "Project", name: "미리내" }],
      facts: [
        {
          item: "p",
          kind: "target_date",
          value: "2026-12-01",
          epistemic: "explicit",
          quote: "q",
          confidence: 0.4,
        },
      ],
      relations: [{ subject: "p", type: "DEPENDS_ON", object: "p", quote: "q", confidence: 0 }],
      terms: [{ ...v3.terms[0], confidence: 1 }],
      definitions: [{ ...v3.definitions[0], confidence: 7 }],
    };
    expect(parse(withConfidence).success).toBe(true);
    expect(parse({ ...v3, terms: [{ ...v3.terms[0], confidence: null }] }).success).toBe(true);
  });

  it.each([
    ["a term kind outside the three", { terms: [{ ...v3.terms[0], kind: "nickname" }] }],
    [
      "a term kind written as the fact kind",
      { terms: [{ ...v3.terms[0], kind: "alias.synonym" }] },
    ],
    ["a term without its quote", { terms: [{ item: "c", form: "ML", kind: "synonym" }] }],
    ["a term with an empty form", { terms: [{ ...v3.terms[0], form: "" }] }],
    [
      "a term whose confidence is not a number",
      { terms: [{ ...v3.terms[0], confidence: "high" }] },
    ],
    ["a definition without its quote", { definitions: [{ item: "c", epistemic: "explicit" }] }],
    ["a definition with an empty quote", { definitions: [{ ...v3.definitions[0], quote: "" }] }],
    [
      "a definition with an epistemic type outside explicit and hypothesis",
      { definitions: [{ ...v3.definitions[0], epistemic: "inferred" }] },
    ],
    [
      "a definition whose context is not text",
      { definitions: [{ ...v3.definitions[0], context: 3 }] },
    ],
    ["an item type the prompt does not list", { items: [{ ...concept, type: "Metric" }] }],
    [
      "a fact kind the facts array does not list",
      {
        facts: [{ item: "c", kind: "definition", value: "x", epistemic: "explicit", quote: "x" }],
      },
    ],
    ["a term list that is not a list", { terms: "ML" }],
    ["a field the schema does not have, at the top", { glossary: [] }],
  ])("rejects %s", (_name, patch) => {
    expect(parse({ ...v3, ...patch }).success).toBe(false);
  });

  it("sends the Provider a JSON Schema that asks for the two lists and leaves confidence optional", () => {
    const schema = task.outputJsonSchema as {
      required: string[];
      properties: {
        terms: { items: { required: string[]; properties: Record<string, unknown> } };
        definitions: { items: { required: string[] } };
      };
    };
    expect(schema.required).toEqual(
      expect.arrayContaining(["items", "facts", "relations", "terms", "definitions"]),
    );
    expect(schema.properties.terms.items.required).not.toContain("confidence");
    expect(schema.properties.terms.items.properties).toHaveProperty("confidence");
    expect(schema.properties.definitions.items.required).not.toContain("context");
  });

  it("tells the Provider about the surface forms, the definitions and their limits", () => {
    const text = task.instructions;
    for (const needle of ["Concept", "terms", "definitions", "500", "confidence", "data"]) {
      expect(text).toContain(needle);
    }
  });
});

// S02-R4: what the instruction lists, what the response schema allows, the catalogue and the seed are the
// same names. The catalogue's entries of edition 1 that extraction writes are the seed this schema names.
const seedNames = (list: readonly { name: string; since?: number; notExtracted?: true }[]) =>
  list.filter((e) => (e.since ?? 1) <= 1 && !e.notExtracted).map((e) => e.name);
const factKindNames = [
  ...EXTRACT_FACT_KINDS,
  ...EXTRACT_IDENTIFIER_FACT_KINDS,
  ...EXTRACT_ALIAS_FACT_KINDS,
  EXTRACT_DEFINITION_FACT_KIND,
  EXTRACT_STATEMENT_FACT_KIND,
];
interface JsonSchema {
  properties: Record<
    string,
    {
      items?: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> };
    }
  >;
}
const schema = task.outputJsonSchema as unknown as JsonSchema;

describe("extract.v4: the instruction, the response schema, the catalogue and the seed are one list", () => {
  it("lists in the instruction every seeded name extraction writes, and no more than the seed's", () => {
    const text = task.instructions;
    for (const name of [
      ...EXTRACT_ITEM_TYPES,
      ...EXTRACT_RELATION_TYPES,
      ...EXTRACT_IDENTIFIER_FACT_KINDS,
      ...EXTRACT_FACT_KINDS,
      EXTRACT_STATEMENT_FACT_KIND,
    ]) {
      expect(text, name).toContain(name);
    }
    // a name of the catalogue that extraction does not write (S03's analytical types) is not in it
    for (const e of [
      ...KNOWLEDGE_SCHEMA.knowledgeTypes,
      ...KNOWLEDGE_SCHEMA.relationTypes,
      ...KNOWLEDGE_SCHEMA.factKinds,
    ].filter((e) => (e.since ?? 1) > 1)) {
      expect(text, e.name).not.toContain(e.name);
    }
  });

  it("closes the response schema's item types, relation types and fact kinds on the same names", () => {
    const items = schema.properties.items?.items?.properties.type?.enum;
    const relations = schema.properties.relations?.items?.properties.type?.enum;
    const facts = schema.properties.facts?.items?.properties.kind?.enum;
    expect([...(items ?? [])].sort()).toEqual([...EXTRACT_ITEM_TYPES].sort());
    expect([...(relations ?? [])].sort()).toEqual([...EXTRACT_RELATION_TYPES].sort());
    expect([...(facts ?? [])].sort()).toEqual(
      [...EXTRACT_FACT_KINDS, ...EXTRACT_IDENTIFIER_FACT_KINDS].sort(),
    );
  });

  it("equals the catalogue's names of edition 1 that extraction writes, which are the seed (S01-R18)", () => {
    expect([...EXTRACT_ITEM_TYPES].sort()).toEqual(
      seedNames(
        KNOWLEDGE_SCHEMA.knowledgeTypes.filter((e) => e.place === "type-definition"),
      ).sort(),
    );
    expect([...EXTRACT_RELATION_TYPES].sort()).toEqual(
      seedNames(KNOWLEDGE_SCHEMA.relationTypes.filter((e) => e.place === "type-definition")).sort(),
    );
    expect([...factKindNames].sort()).toEqual(seedNames(KNOWLEDGE_SCHEMA.factKinds).sort());
  });
});

describe("extract.v4: the new fields", () => {
  const person = { ref: "p", type: "Person", name: "한서윤", existingItemId: null };
  const key = {
    item: "p",
    kind: "identifier.key",
    value: "K-0417",
    epistemic: "explicit",
    quote: "사번은 K-0417이다",
    context: "인사",
    validFrom: "2026-01-01",
    validUntil: null,
  };
  const base = { items: [person], facts: [key], relations: [], terms: [], definitions: [] };

  it("reads identifiers with a context tag, a validity interval on facts and relations, a statement kind and proposals", () => {
    const full = {
      ...base,
      relations: [
        {
          subject: "p",
          type: "BELONGS_TO",
          object: "p",
          quote: "q",
          validFrom: "2026-01-01",
          validUntil: "2026-12-31",
        },
      ],
      definitions: [{ item: "p", kind: "statement", quote: "q", epistemic: "explicit" }],
      proposedTypes: [
        {
          kind: "relation-type",
          name: "MENTORS",
          subjectTypes: ["Person"],
          objectTypes: ["Person"],
          quote: "q",
        },
        { kind: "item-type", name: "Milestone", quote: "q" },
      ],
    };
    const result = parse(full);
    expect(result.success).toBe(true);
    const data = result.data as ExtractionOutput;
    expect(data.facts[0]).toEqual(key);
    expect(data.definitions[0]?.kind).toBe("statement");
    expect(data.proposedTypes).toHaveLength(2);
  });

  it("takes an answer without proposedTypes or a definition kind, and gives more than five proposals to the handler to drop", () => {
    expect(parse(base).success).toBe(true);
    const many = Array.from({ length: 9 }, (_, i) => ({
      kind: "item-type",
      name: `T${i}`,
      quote: "q",
    }));
    expect(parse({ ...base, proposedTypes: many }).success).toBe(true);
  });

  it.each([
    [
      "a proposal kind outside the two",
      { proposedTypes: [{ kind: "fact-kind", name: "X", quote: "q" }] },
    ],
    ["a proposal without its quote", { proposedTypes: [{ kind: "item-type", name: "X" }] }],
    [
      "a proposal with an empty name",
      { proposedTypes: [{ kind: "item-type", name: "", quote: "q" }] },
    ],
    [
      "a definition kind outside the two",
      { definitions: [{ item: "p", kind: "rule", quote: "q", epistemic: "explicit" }] },
    ],
    [
      "a relation type outside the six",
      { relations: [{ subject: "p", type: "MENTIONS", object: "p", quote: "q" }] },
    ],
    ["a validity end that is not text", { facts: [{ ...key, validUntil: 2026 }] }],
    ["an item type of S03", { items: [{ ...person, type: "Dataset" }] }],
  ])("rejects %s", (_name, patch) => {
    expect(parse({ ...base, ...patch }).success).toBe(false);
  });

  it("sends the Provider a JSON Schema in which the new fields are optional", () => {
    const text = JSON.stringify(task.outputJsonSchema);
    expect(text).toContain("proposedTypes");
    const top = task.outputJsonSchema as { required: string[] };
    expect(top.required).not.toContain("proposedTypes");
  });
});
