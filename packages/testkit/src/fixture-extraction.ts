// Per-fixture extraction double (V02-R17, V02-T05, S01-T08, S02-T02, S03-T07): what a Provider of kind
// `test-double` answers to an extraction request for a V02, S01, S02 or S03 fixture. The answer
// is fixed in fixtures/v02-expected.json (the facts and relations), fixtures/s01-expected.json
// (the surface forms and definitions of the glossary) and fixtures/s02-expected.json (identifiers,
// the six relations, a statement and a type proposal) and fixtures/s03-expected.json (the analytical facts
// and relation of a Metric page, in the shape of v02-expected.json) whose evidence is the requested
// document's record, with their quotes. It names an existing item only by picking it
// from the candidates the request carried (same name); otherwise the item is new. A
// document that is no fixture gets an empty answer. It always quotes exactly and gives
// no confidence, so it proves nothing about real extraction (A21, S32).
import type { StructuredRequest } from "@pki/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");

interface Evidence {
  record_id: string;
  quote: string;
}
interface Expected {
  entities: Record<string, { type: string; name: string }>;
  sets: Record<
    string,
    {
      facts: { entity: string; attribute: string; value: string; evidence: Evidence }[];
      relations: { subject: string; type: string; object: string; evidence: Evidence }[];
    }
  >;
}

interface ExpectedGlossary {
  entities: Record<string, { type: string; name: string }>;
  sets: Record<
    string,
    {
      terms: { entity: string; form: string; kind: string; evidence: Evidence }[];
      definitions: {
        entity: string;
        value: string;
        context: string;
        evidence: Evidence;
      }[];
    }
  >;
}

interface ExpectedEntities {
  entities: Record<string, { type: string; name: string }>;
  sets: Record<
    string,
    {
      facts: {
        entity: string;
        attribute: string;
        value: string;
        context?: string;
        evidence: Evidence;
      }[];
      relations: { subject: string; type: string; object: string; evidence: Evidence }[];
      statements: { entity: string; value: string; context: string; evidence: Evidence }[];
      proposedTypes: { kind: string; name: string; evidence: Evidence }[];
    }
  >;
}

/** The extraction output (schema version 5, providers/src/tasks.ts). */
export interface FixtureExtraction {
  items: { ref: string; type: string; name: string; existingItemId: string | null }[];
  facts: {
    item: string;
    kind: string;
    value: string;
    epistemic: "explicit";
    quote: string;
    context?: string;
  }[];
  relations: { subject: string; type: string; object: string; quote: string }[];
  terms: { item: string; form: string; kind: string; quote: string }[];
  definitions: {
    item: string;
    kind?: string;
    quote: string;
    context: string;
    epistemic: "explicit";
  }[];
  proposedTypes: { kind: string; name: string; quote: string }[];
}

function load() {
  // v02 and s03 share one shape: entities, and sets of facts and relations with their evidence
  const [expected, analytical] = ["v02-expected.json", "s03-expected.json"].map(
    (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Expected,
  ) as [Expected, Expected];
  /** Fixture content -> record id. */
  const records = new Map<string, string>();
  for (const file of readdirSync(FIXTURES).filter((f) => /^(v02|s01|s02|s03)-.*\.jsonl$/.test(f))) {
    for (const line of readFileSync(resolve(FIXTURES, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as { id: string; content: string };
      records.set(record.content, record.id);
    }
  }
  const facts = new Map<string, Expected["sets"][string]["facts"][number]>();
  const relations = new Map<string, Expected["sets"][string]["relations"][number]>();
  for (const set of [...Object.values(expected.sets), ...Object.values(analytical.sets)]) {
    for (const f of set.facts) facts.set(`${f.evidence.record_id}|${f.entity}|${f.attribute}`, f);
    for (const r of set.relations) {
      relations.set(`${r.evidence.record_id}|${r.subject}|${r.type}|${r.object}`, r);
    }
  }
  const glossary = JSON.parse(
    readFileSync(resolve(FIXTURES, "s01-expected.json"), "utf8"),
  ) as ExpectedGlossary;
  const terms = new Map<string, ExpectedGlossary["sets"][string]["terms"][number]>();
  const definitions = new Map<string, ExpectedGlossary["sets"][string]["definitions"][number]>();
  for (const set of Object.values(glossary.sets)) {
    for (const t of set.terms) terms.set(`${t.evidence.record_id}|${t.entity}|${t.form}`, t);
    for (const d of set.definitions) definitions.set(`${d.evidence.record_id}|${d.value}`, d);
  }
  const organisation = JSON.parse(
    readFileSync(resolve(FIXTURES, "s02-expected.json"), "utf8"),
  ) as ExpectedEntities;
  const entityFacts = new Map<string, ExpectedEntities["sets"][string]["facts"][number]>();
  const entityRelations = new Map<string, ExpectedEntities["sets"][string]["relations"][number]>();
  const statements = new Map<string, ExpectedEntities["sets"][string]["statements"][number]>();
  const proposed = new Map<string, ExpectedEntities["sets"][string]["proposedTypes"][number]>();
  for (const set of Object.values(organisation.sets)) {
    for (const f of set.facts)
      entityFacts.set(`${f.evidence.record_id}|${f.entity}|${f.attribute}`, f);
    for (const r of set.relations) {
      entityRelations.set(`${r.evidence.record_id}|${r.subject}|${r.type}|${r.object}`, r);
    }
    for (const d of set.statements) statements.set(`${d.evidence.record_id}|${d.value}`, d);
    for (const p of set.proposedTypes) proposed.set(`${p.evidence.record_id}|${p.name}`, p);
  }
  return {
    entities: {
      ...expected.entities,
      ...analytical.entities,
      ...glossary.entities,
      ...organisation.entities,
    },
    records,
    facts: [...facts.values()],
    relations: [...relations.values()],
    terms: [...terms.values()],
    definitions: [...definitions.values()],
    entityFacts: [...entityFacts.values()],
    entityRelations: [...entityRelations.values()],
    statements: [...statements.values()],
    proposedTypes: [...proposed.values()],
  };
}

/** The extraction a fixture document gets; use as `new FakeProvider({ answer: fixtureExtraction() })`. */
export function fixtureExtraction(): (request: StructuredRequest) => FixtureExtraction {
  const {
    entities,
    records,
    facts,
    relations,
    terms,
    definitions,
    entityFacts,
    entityRelations,
    statements,
    proposedTypes,
  } = load();
  return (request) => {
    const document = request.input.untrustedDocuments[0];
    const recordId = document && records.get(document.body);
    const out: FixtureExtraction = {
      items: [],
      facts: [],
      relations: [],
      terms: [],
      definitions: [],
      proposedTypes: [],
    };
    if (recordId === undefined) return out;
    const refs = new Set<string>();
    const use = (ref: string) => {
      if (refs.has(ref)) return;
      refs.add(ref);
      const entity = entities[ref] as { type: string; name: string };
      const existing = request.input.candidates.find((c) => c.name === entity.name);
      out.items.push({ ref, ...entity, existingItemId: existing?.id ?? null });
    };
    for (const f of facts.filter((f) => f.evidence.record_id === recordId)) {
      use(f.entity);
      out.facts.push({
        item: f.entity,
        kind: f.attribute,
        value: f.value,
        epistemic: "explicit",
        quote: f.evidence.quote,
      });
    }
    for (const r of relations.filter((r) => r.evidence.record_id === recordId)) {
      use(r.subject);
      use(r.object);
      out.relations.push({
        subject: r.subject,
        type: r.type,
        object: r.object,
        quote: r.evidence.quote,
      });
    }
    for (const t of terms.filter((t) => t.evidence.record_id === recordId)) {
      use(t.entity);
      out.terms.push({ item: t.entity, form: t.form, kind: t.kind, quote: t.evidence.quote });
    }
    for (const d of definitions.filter((d) => d.evidence.record_id === recordId)) {
      use(d.entity);
      out.definitions.push({
        item: d.entity,
        quote: d.evidence.quote,
        context: d.context,
        epistemic: "explicit",
      });
    }
    for (const f of entityFacts.filter((f) => f.evidence.record_id === recordId)) {
      use(f.entity);
      out.facts.push({
        item: f.entity,
        kind: f.attribute,
        value: f.value,
        epistemic: "explicit",
        quote: f.evidence.quote,
        ...(f.context === undefined ? {} : { context: f.context }),
      });
    }
    for (const r of entityRelations.filter((r) => r.evidence.record_id === recordId)) {
      use(r.subject);
      use(r.object);
      out.relations.push({
        subject: r.subject,
        type: r.type,
        object: r.object,
        quote: r.evidence.quote,
      });
    }
    for (const d of statements.filter((d) => d.evidence.record_id === recordId)) {
      use(d.entity);
      out.definitions.push({
        item: d.entity,
        kind: "statement",
        quote: d.evidence.quote,
        context: d.context,
        epistemic: "explicit",
      });
    }
    for (const p of proposedTypes.filter((p) => p.evidence.record_id === recordId)) {
      out.proposedTypes.push({ kind: p.kind, name: p.name, quote: p.evidence.quote });
    }
    return out;
  };
}
