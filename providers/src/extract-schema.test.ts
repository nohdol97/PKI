// S01-T08 `extract.v3` (schema part; S01-R17): the extraction answer of schema version 3 holds
// items (with the type `Concept`), facts, relations, `terms` (surface forms) and `definitions`,
// and every fact, relation, term and definition may carry a `confidence`. The schema checks the
// shape only; what the numbers and quotes mean is judged by the handler (knowledge-engine). All
// data is synthetic.
import { describe, expect, it } from "vitest";
import {
  EXTRACT_ALIAS_FACT_KINDS,
  EXTRACT_DEFINITION_FACT_KIND,
  EXTRACT_DEFINITION_MAX_CODE_POINTS,
  EXTRACT_FACT_KINDS,
  EXTRACT_ITEM_TYPES,
  EXTRACT_RELATION_TYPES,
  EXTRACT_SCHEMA_VERSION,
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

describe("extract.v3: the schema", () => {
  it("is version 3, the only extract version listed (a request for 2 is an unlisted version)", () => {
    expect(EXTRACT_SCHEMA_VERSION).toBe(3);
    expect(Object.keys(TASKS.extract)).toEqual(["3"]);
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
    expect([...EXTRACT_ITEM_TYPES].sort()).toEqual(["Concept", "Project", "System"]);
    expect([...EXTRACT_FACT_KINDS].sort()).toEqual(["completion_date", "target_date"]);
    expect([...EXTRACT_RELATION_TYPES]).toEqual(["DEPENDS_ON"]);
    expect([...EXTRACT_TERM_KINDS]).toEqual(["synonym", "abbreviation", "translation"]);
    expect([...EXTRACT_ALIAS_FACT_KINDS]).toEqual([
      "alias.synonym",
      "alias.abbreviation",
      "alias.translation",
    ]);
    expect(EXTRACT_DEFINITION_FACT_KIND).toBe("definition");
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
    ["an item type the prompt does not list", { items: [{ ...concept, type: "Person" }] }],
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
