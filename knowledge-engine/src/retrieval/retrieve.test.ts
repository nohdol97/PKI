// X01-T1 `retrieve` (X01-R1~R7, C1a): the routed strategies, the rank-reciprocal merge, the read-only preference signal,
// the gap notes and the related-knowledge links. Few cases by the test-slimming rules: one or two per proof.
// The data is the synthetic fixtures/x01-ask.jsonl, its knowledge planted from the labels in fixtures/x01-expected.json.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addEvidence,
  defaultScopePolicy,
  insertAssertionLink,
  insertItem,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { locateQuote } from "../quote.ts";
import { retrieve, type PreferenceSignal, type StrategyName } from "./index.ts";

const FIXTURES = resolve(import.meta.dirname, "../../../fixtures");
const lines = readFileSync(resolve(FIXTURES, "x01-ask.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Record<string, string | number | string[]>);
const expected = JSON.parse(readFileSync(resolve(FIXTURES, "x01-expected.json"), "utf8")) as {
  entities: Record<string, { type: string; name: string }>;
  relations: { subject: string; type: string; object: string; evidence: Evidence }[];
  facts: Record<
    string,
    { entity: string; attribute: string; value: string; valid_at?: string; evidence: Evidence }
  >;
  links: { type: "SUPERSEDES" | "CONTRADICTS"; from: string; to: string }[];
  questions: Record<string, { text: string }>;
};
interface Evidence {
  record_id: string;
  quote: string;
}

const registry = createProductRegistry({ policy: defaultScopePolicy });
const attrs = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
} as const;

/** The fixture world: every record stored, the labelled knowledge planted. `version` maps a record id to its row id. */
function world() {
  const db: SqlDriver = openBetterSqlite3(":memory:");
  migrate(db);
  const version = new Map<string, number>();
  for (const l of lines) {
    const instance = l.connector_instance_id as string;
    registerConnectorInstance(db, instance, "test-fixtures");
    saveSourceRecord(db, instance, {
      externalId: l.external_id as string,
      title: l.title as string,
      body: l.content as string,
      accessScope: l.access_scope as string[],
      provenance: { createdAt: l.created_at, updatedAt: l.updated_at },
    });
    version.set(
      l.id as string,
      db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number,
    );
  }
  const cite = (target: { factId: number } | { relationId: number }, e: Evidence) => {
    const id = version.get(e.record_id) as number;
    const body = db.all("SELECT body FROM source_versions WHERE id = ?", [id])[0]?.body as string;
    const span = locateQuote(body, e.quote);
    if ("dropped" in span) throw new Error(`fixture quote not found: ${e.quote}`);
    addEvidence(db, { target, sourceVersionId: id, quote: e.quote, ...span });
  };
  const item = new Map(
    Object.entries(expected.entities).map(([key, e]) => [
      key,
      insertItem(db, { type: e.type, name: e.name, ...attrs }),
    ]),
  );
  for (const r of expected.relations) {
    const id = saveRelation(db, {
      subjectId: item.get(r.subject) as number,
      type: r.type,
      objectId: item.get(r.object) as number,
      ...attrs,
    }).id;
    cite({ relationId: id }, r.evidence);
  }
  const fact = new Map<string, number>();
  for (const [key, f] of Object.entries(expected.facts)) {
    const id = saveFact(db, {
      itemId: item.get(f.entity) as number,
      kind: f.attribute,
      value: f.value,
      ...attrs,
      validAt: f.valid_at ?? null,
    }).id;
    fact.set(key, id);
    cite({ factId: id }, f.evidence);
  }
  for (const l of expected.links) {
    insertAssertionLink(db, {
      type: l.type,
      fromFactId: fact.get(l.from) as number,
      toFactId: fact.get(l.to) as number,
      createdBy: "rule",
      at: "2026-11-23T00:00:00.000Z",
    });
  }
  const counts = () =>
    ["items", "facts", "relations", "evidence"].map(
      (t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n,
    );
  return { db, version, counts };
}

const ask = (w: ReturnType<typeof world>, key: string, enabled?: readonly StrategyName[]) =>
  retrieve(w.db, registry, expected.questions[key]?.text as string, {}, enabled ? { enabled } : {});
const usedOf = (route: Record<string, { status: string }>) =>
  Object.entries(route)
    .filter(([, r]) => r.status === "used")
    .map(([name]) => name);

describe("X01-C1a retrieve", () => {
  it("① a plain question runs keyword only; a dependency question runs graph and finds the source keyword cannot", async () => {
    const w = world();
    const everything: StrategyName[] = [
      "keyword",
      "metadata",
      "concept",
      "graph",
      "temporal",
      "wiki",
      "rerank",
    ];
    const plain = await ask(w, "plain", everything);
    expect(usedOf(plain.route).filter((n) => !["metadata", "rerank"].includes(n))).toEqual([
      "keyword",
    ]);
    expect(plain.hits.map((h) => h.versionId)).toContain(w.version.get("wiki-x01-0001"));

    const codename = w.version.get("wiki-x01-0002");
    const keywordOnly = await ask(w, "dependency");
    expect(keywordOnly.route.graph.status).toBe("off");
    expect(keywordOnly.hits.map((h) => h.versionId)).not.toContain(codename);

    const withGraph = await ask(w, "dependency", ["keyword", "metadata", "graph", "rerank"]);
    expect(withGraph.route.graph.status).toBe("used");
    const found = withGraph.hits.find((h) => h.versionId === codename);
    expect(found?.strategies).toEqual(["graph"]);
  });

  it("② a preference weight of 2 lifts a source's rank and changes neither the hit set nor the knowledge rows", async () => {
    const w = world();
    const before = w.counts();
    const base = await ask(w, "checkDay");
    const target = w.version.get("wiki-x01-0007") as number;
    const baseRank = base.hits.find((h) => h.versionId === target)?.rank as number;
    expect(baseRank).toBeGreaterThan(1);

    const favour: PreferenceSignal = { weight: (h) => (h.versionId === target ? 2 : 1) };
    const lifted = await retrieve(
      w.db,
      registry,
      expected.questions.checkDay?.text as string,
      {},
      { preference: favour },
    );
    expect(lifted.hits.find((h) => h.versionId === target)?.rank).toBeLessThan(baseRank);
    expect(new Set(lifted.hits.map((h) => h.versionId))).toEqual(
      new Set(base.hits.map((h) => h.versionId)),
    );
    expect(w.counts()).toEqual(before);
  });
});
