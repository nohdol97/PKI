// Per-fixture extraction double (V02-R17, V02-T05): what a Provider of kind
// `test-double` answers to an extraction request for a V02 fixture. The answer
// is fixed in fixtures/v02-expected.json: the facts and relations whose evidence
// is the requested document's record, with their quotes. It names an existing
// item only by picking it from the candidates the request carried (same name);
// otherwise the item is new. A document that is no V02 fixture gets an empty
// answer. It always quotes exactly, so it proves nothing about real extraction (A21).
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

/** The V02 extraction output (schema version 2, providers/src/tasks.ts). */
export interface FixtureExtraction {
  items: { ref: string; type: string; name: string; existingItemId: string | null }[];
  facts: { item: string; kind: string; value: string; epistemic: "explicit"; quote: string }[];
  relations: { subject: string; type: string; object: string; quote: string }[];
}

function load() {
  const expected = JSON.parse(
    readFileSync(resolve(FIXTURES, "v02-expected.json"), "utf8"),
  ) as Expected;
  /** Fixture content -> record id. */
  const records = new Map<string, string>();
  for (const file of readdirSync(FIXTURES).filter((f) => /^v02-.*\.jsonl$/.test(f))) {
    for (const line of readFileSync(resolve(FIXTURES, file), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line) as { id: string; content: string };
      records.set(record.content, record.id);
    }
  }
  const facts = new Map<string, Expected["sets"][string]["facts"][number]>();
  const relations = new Map<string, Expected["sets"][string]["relations"][number]>();
  for (const set of Object.values(expected.sets)) {
    for (const f of set.facts) facts.set(`${f.evidence.record_id}|${f.entity}|${f.attribute}`, f);
    for (const r of set.relations) {
      relations.set(`${r.evidence.record_id}|${r.subject}|${r.type}|${r.object}`, r);
    }
  }
  return {
    entities: expected.entities,
    records,
    facts: [...facts.values()],
    relations: [...relations.values()],
  };
}

/** The extraction a fixture document gets; use as `new FakeProvider({ answer: fixtureExtraction() })`. */
export function fixtureExtraction(): (request: StructuredRequest) => FixtureExtraction {
  const { entities, records, facts, relations } = load();
  return (request) => {
    const document = request.input.untrustedDocuments[0];
    const recordId = document && records.get(document.body);
    const out: FixtureExtraction = { items: [], facts: [], relations: [] };
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
    return out;
  };
}
