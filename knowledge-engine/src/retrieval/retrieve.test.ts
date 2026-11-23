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
  writeWikiPage,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { describe, expect, it } from "vitest";
import { createProductRegistry } from "../canonical-kinds.ts";
import { locateQuote } from "../quote.ts";
import { renderWikiPages } from "../wiki-render.ts";
import {
  DEFAULT_ENABLED_STRATEGIES,
  retrieve,
  type PreferenceSignal,
  type StrategyName,
} from "./index.ts";

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

describe("X01-R6 R7 notes and links", () => {
  it("marks a conflict between shown hits, a past version as stale, and links a hit to the items it supports", async () => {
    const w = world();
    const conflict = await ask(w, "checkDay");
    const tue = w.version.get("wiki-x01-0003");
    const thu = w.version.get("messenger-x01-0006");
    expect(conflict.notes).toEqual(
      expect.arrayContaining([
        { kind: "conflict", versionId: tue },
        { kind: "conflict", versionId: thu },
      ]),
    );
    expect(conflict.hits.find((h) => h.versionId === tue)?.related.map((l) => l.name)).toEqual([
      "별빛 시스템",
    ]);

    const release = await ask(w, "releaseDate");
    const stale = release.notes.filter((n) => n.kind === "stale");
    expect(stale).toEqual([{ kind: "stale", versionId: w.version.get("mail-x01-0004") }]);
  });

  it("says insufficient when nothing is found", async () => {
    const w = world();
    const none = await retrieve(w.db, registry, "존재하지않는낱말", {});
    expect(none.hits).toEqual([]);
    expect(none.notes).toEqual([{ kind: "insufficient" }]);
  });
});

describe("X01-R1 R2 R5 the other strategies", () => {
  it("concept finds a source through an alias; the default list leaves it off", async () => {
    const w = world();
    const ops = w.version.get("wiki-x01-0003");
    expect((await ask(w, "alias")).hits.map((h) => h.versionId)).not.toContain(ops);
    const withConcept = await ask(w, "alias", ["keyword", "metadata", "concept", "rerank"]);
    expect(withConcept.route.concept.status).toBe("used");
    expect(withConcept.hits.find((h) => h.versionId === ops)?.strategies).toContain("concept");
    expect(DEFAULT_ENABLED_STRATEGIES).toEqual(["keyword", "metadata", "rerank"]);
  });

  it("temporal puts the replacing fact's source first for a question about a change; wiki follows the item's page", async () => {
    const w = world();
    const changed = await retrieve(
      w.db,
      registry,
      "물결 프로젝트 배포일이 바뀐 건",
      {},
      { enabled: ["temporal"] },
    );
    expect(changed.route.temporal.status).toBe("used");
    const newest = w.version.get("mail-x01-0004-v2");
    expect(changed.hits.find((h) => h.versionId === newest)?.strategies).toContain("temporal");

    for (const page of renderWikiPages(w.db)) writeWikiPage(w.db, page, "2026-11-23T00:00:00.000Z");
    const wiki = await retrieve(
      w.db,
      registry,
      "물결 프로젝트 전체 정리",
      {},
      { enabled: ["wiki"] },
    );
    const codename = w.version.get("wiki-x01-0002");
    expect(wiki.hits.find((h) => h.versionId === codename)?.strategies).toContain("wiki");
    expect(wiki.hits.find((h) => h.versionId === codename)?.related[0]?.wikiKey).toMatch(
      /^projects\//,
    );
  });

  it("vector reports unavailable with its reason, runs through the adapters when ready, and never fakes", async () => {
    const w = world();
    const none = await retrieve(w.db, registry, "별빛 시스템", {}, { enabled: ["vector"] });
    expect(none.route.vector).toEqual({
      status: "unavailable",
      reason: "no embedding provider or vector index is configured",
    });
    const sourceId = w.db.all("SELECT source_id AS s FROM source_versions WHERE id = ?", [
      w.version.get("wiki-x01-0007") as number,
    ])[0]?.s;
    const ready = {
      embedding: {
        status: async () => "ready" as const,
        embed: async () => [new Float32Array([1])],
      },
      index: {
        status: async () => "ready" as const,
        search: async () => [{ ref: `source-version:${String(sourceId)}:1`, score: 1 }],
      },
    };
    const hit = await retrieve(
      w.db,
      registry,
      "무관한 문장",
      {},
      { enabled: ["vector"], vector: ready },
    );
    expect(hit.route.vector.status).toBe("used");
    expect(hit.hits.map((h) => h.versionId)).toEqual([w.version.get("wiki-x01-0007")]);
    const rebuilding = await retrieve(
      w.db,
      registry,
      "x",
      {},
      {
        enabled: ["vector"],
        vector: { ...ready, index: { ...ready.index, status: async () => "rebuilding" as const } },
      },
    );
    expect(rebuilding.route.vector).toEqual({
      status: "unavailable",
      reason: "vector index: rebuilding",
    });
  });

  it("metadata filters every list by collector and by the origin system's time", async () => {
    const w = world();
    const mail = await retrieve(w.db, registry, "물결 프로젝트", {
      connectorIds: ["conn-x01-mail"],
    });
    expect(mail.hits.map((h) => h.versionId).sort()).toEqual(
      [w.version.get("mail-x01-0004"), w.version.get("mail-x01-0004-v2")].sort(),
    );
    const recent = await retrieve(w.db, registry, "물결 프로젝트", {
      from: "2026-11-10T00:00:00+09:00",
    });
    expect(recent.hits.map((h) => h.versionId)).toEqual([w.version.get("mail-x01-0004-v2")]);
    expect(recent.route.metadata.status).toBe("used");
  });
});

describe("X01-R12 what a search hides takes no hit slot", () => {
  it("returns the hits of the visible sources only, as many and in the order as without the hidden ones", async () => {
    const denying = createProductRegistry({
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("denied")),
      },
    });
    const hitsWith = async (hidden: number) => {
      const db: SqlDriver = openBetterSqlite3(":memory:");
      migrate(db);
      registerConnectorInstance(db, "c1", "test-fixtures");
      const add = (mark: string, scope: string[], extra: string) =>
        saveSourceRecord(db, "c1", {
          externalId: mark,
          title: mark,
          body: `프로브낱말 ${mark} ${extra}`,
          accessScope: scope,
        });
      for (let i = 0; i < 25; i++) add(`open-${i}`, ["open"], "");
      for (let i = 0; i < hidden; i++) add(`denied-${i}`, ["denied"], "프로브낱말 프로브낱말");
      const found = await retrieve(db, denying, "프로브낱말");
      const titles = found.hits.map(
        (h) => db.all("SELECT title FROM source_versions WHERE id = ?", [h.versionId])[0]?.title,
      );
      db.close();
      return titles;
    };
    const without = await hitsWith(0);
    expect(without).toHaveLength(20);
    expect(await hitsWith(10)).toEqual(without);
  });
});

describe("X01-R6 R12 a hidden newer version leaves no trace in the marks", () => {
  it("does not mark a visible past version stale because a newer version the registry hides exists", async () => {
    const w = world();
    const newer = String(w.version.get("mail-x01-0004-v2"));
    const hiding: typeof registry = {
      ...registry,
      visible: (db, refs, purpose) =>
        registry
          .visible(db, refs, purpose)
          .filter((r) => !(purpose === "search" && r.kind === "source" && r.id === newer)),
    };
    const found = await retrieve(w.db, hiding, expected.questions.releaseDate?.text as string, {});
    expect(found.hits.map((h) => h.versionId)).toContain(w.version.get("mail-x01-0004"));
    expect(found.hits.map((h) => h.versionId)).not.toContain(Number(newer));
    expect(found.notes.filter((n) => n.kind === "stale")).toEqual([]);
    // the control: with the newer version shown, the same past version is stale
    const shown = await retrieve(
      w.db,
      registry,
      expected.questions.releaseDate?.text as string,
      {},
    );
    expect(shown.notes).toContainEqual({
      kind: "stale",
      versionId: w.version.get("mail-x01-0004"),
    });
  });
});

describe("X01-R12 the visibility check comes before the strategy cut", () => {
  it("keeps the visible hits a strategy would cut off behind the hidden ones", async () => {
    const denying = createProductRegistry({
      policy: {
        ...defaultScopePolicy,
        allows: (scopes) => !scopes.some((s) => s?.includes("denied")),
      },
    });
    const db: SqlDriver = openBetterSqlite3(":memory:");
    migrate(db);
    registerConnectorInstance(db, "c1", "test-fixtures");
    const add = (mark: string, scope: string[], body: string) =>
      saveSourceRecord(db, "c1", { externalId: mark, title: mark, body, accessScope: scope });
    for (let i = 0; i < 60; i++) add(`denied-${i}`, ["denied"], "프로브낱말 프로브낱말 프로브낱말");
    for (let i = 0; i < 5; i++) add(`open-${i}`, ["open"], "프로브낱말");
    const found = await retrieve(db, denying, "프로브낱말");
    expect(found.hits).toHaveLength(5);
    expect(found.route.keyword).toEqual({ status: "used", count: 5 });
    db.close();
  });
});
