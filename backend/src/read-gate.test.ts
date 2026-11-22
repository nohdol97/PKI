// I04-C1 `read-gate` (R13): the read paths that send derived rows out (the Sources list, the keyword
// search, Home's Insight list, an Insight's evidence list, the source an evidence row opens) show a
// row only if the registry's `visible` does, for the purpose the path names. A row whose source
// version is covered by a tombstone while it is still stored, or whose scopes the policy does not
// allow, is left out; a registry that cannot judge fails the call. Hidden rows are left out of the
// answer whole, so nothing of them shows in a count, an ordering or an error.
import { createProductRegistry } from "@pki/knowledge-engine";
import {
  addEvidence,
  createDerivativeRegistry,
  insertItem,
  recordTombstone,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveSourceRecord,
  type DerivativeRegistry,
  type ScopePolicy,
  type ScopePurpose,
  type SqlDriver,
  defaultScopePolicy,
} from "@pki/storage";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCanonicalDb } from "./composition.ts";
import { createReadGate } from "./read-gate.ts";

let dir: string;
let db: SqlDriver;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-read-gate-"));
  db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = ["secret"];

/** A policy that allows every scope set but the ones naming "secret"; it records each purpose asked. */
function policy(asked: ScopePurpose[] = []): ScopePolicy {
  return {
    ...defaultScopePolicy,
    allows: (scopes, purpose) => {
      asked.push(purpose);
      return !scopes.some((s) => s?.includes("secret"));
    },
  };
}

function registryOf(p: ScopePolicy): DerivativeRegistry {
  return createDerivativeRegistry({
    kinds: createProductRegistry({ policy: defaultScopePolicy }).kinds,
    policy: p,
  });
}

const throwing: ScopePolicy = {
  ...defaultScopePolicy,
  allows: () => {
    throw new Error("cannot judge");
  },
};

function source(externalId: string, accessScope: string[] | null = null, body = "합성 등대") {
  const saved = saveSourceRecord(db, "c", {
    externalId,
    title: `제목 ${externalId}`,
    body,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const version = db.all("SELECT max(id) AS id FROM source_versions WHERE source_id = ?", [
    saved.sourceId,
  ])[0]?.id as number;
  return { sourceId: saved.sourceId, versionId: version };
}

/** A tombstone that covers the source while its version rows are still stored: the record without the purge. */
const cover = (sourceId: number) =>
  recordTombstone(db, sourceId, {
    reason: "user-deleted",
    lastRevision: null,
    at: "2026-11-22T00:00:00Z",
  });

const titles = (rows: readonly { title: string }[]) => rows.map((r) => r.title);

const attrs = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-22T00:00:00Z",
} as const;

/** An active Insight whose evidence quotes `sourceVersionIds` one each. */
function insight(name: string, sourceVersionIds: number[]) {
  const x = insertItem(db, { ...attrs, type: "Project", name: `X${name}` });
  const y = insertItem(db, { ...attrs, type: "System", name: `Y${name}` });
  const fact = saveFact(db, { ...attrs, itemId: x, kind: "target_date", value: "2026-12-05" });
  const evidenceIds = sourceVersionIds.map((sourceVersionId) =>
    addEvidence(db, {
      target: { factId: fact.id },
      sourceVersionId,
      start: 0,
      end: 2,
      quote: "합성",
    }),
  );
  saveInsight(
    db,
    { rule: "dependency_delay", xItemId: x, yItemId: y },
    { state: "active", summary: `요약 ${name}`, evidenceIds },
  );
  const id = db.all("SELECT id FROM insights WHERE summary = ?", [`요약 ${name}`])[0]?.id as number;
  return { id, evidenceIds };
}

describe("read-gate: the Sources list and the keyword search", () => {
  it("leaves out a source the policy denies and one a tombstone covers, wherever they stand in the list", () => {
    source("a");
    const b = source("b", SECRET);
    source("c");
    const d = source("d");
    source("e", SECRET);
    cover(d.sourceId);
    const gate = createReadGate(db, registryOf(policy()));
    // newest first: e (secret), d (covered), c, b (secret), a
    expect(titles(gate.sources())).toEqual(["제목 c", "제목 a"]);
    expect(titles(gate.searchSources("등대"))).toHaveLength(2);
    expect(new Set(titles(gate.searchSources("등대")))).toEqual(new Set(["제목 c", "제목 a"]));
    expect(b.sourceId).toBeGreaterThan(0);
  });

  it("keeps the order of what it shows", () => {
    for (const id of ["a", "b", "c", "d"]) source(id);
    cover(source("e").sourceId);
    const open = createReadGate(db, registryOf(policy()));
    expect(titles(open.sources())).toEqual(["제목 d", "제목 c", "제목 b", "제목 a"]);
  });

  it("fills the limit from what is shown: hidden rows do not use up its places", () => {
    for (const id of ["a", "b"]) source(id);
    for (const id of ["c", "d", "e"]) source(id, SECRET);
    const gate = createReadGate(db, registryOf(policy()), { sourcesLimit: 2, searchLimit: 2 });
    expect(titles(gate.sources())).toEqual(["제목 b", "제목 a"]);
    expect(titles(gate.searchSources("등대"))).toHaveLength(2);
  });

  it("asks for the purposes display (the list) and search (the keyword search)", () => {
    source("a");
    const asked: ScopePurpose[] = [];
    const gate = createReadGate(db, registryOf(policy(asked)));
    gate.sources();
    expect(new Set(asked)).toEqual(new Set(["display"]));
    asked.length = 0;
    gate.searchSources("등대");
    expect(new Set(asked)).toEqual(new Set(["search"]));
  });

  it("fails the call when the registry cannot judge, with nothing of a row in the error", () => {
    source("a", null, "민감한 본문");
    const gate = createReadGate(db, registryOf(throwing));
    expect(() => gate.sources()).toThrow("cannot judge");
    expect(() => gate.searchSources("민감한")).toThrow("cannot judge");
  });
});

describe("read-gate: the window that fills a limit", () => {
  it("never reads past the cap and judges each row once", () => {
    for (let i = 0; i < 30; i++) source(`h${i}`, SECRET);
    const asked: string[] = [];
    const base = registryOf(policy());
    const counting: DerivativeRegistry = {
      ...base,
      visible: (d, refs, purpose) => {
        asked.push(...refs.map((r) => r.id));
        return base.visible(d, refs, purpose);
      },
    };
    const gate = createReadGate(db, counting, { sourcesLimit: 2, maxScan: 20 });
    expect(gate.sources()).toEqual([]);
    // windows 2, 8, 20: the cap holds and no row is asked about twice
    expect(asked).toHaveLength(20);
    expect(new Set(asked).size).toBe(20);
  });
});

describe("read-gate: Home's Insights, their evidence and an evidence row's source", () => {
  it("lists only the Insights whose whole lineage is shown, wherever they stand", () => {
    const a = source("a");
    const b = source("b", SECRET);
    const c = source("c");
    const covered = source("d");
    const e = source("e");
    insight("a", [a.versionId]);
    insight("b", [b.versionId]);
    insight("c", [c.versionId]);
    insight("d", [covered.versionId]);
    insight("mix", [e.versionId, b.versionId]); // one hidden source hides the Insight
    insight("e", [e.versionId]);
    cover(covered.sourceId);
    const gate = createReadGate(db, registryOf(policy()));
    expect(gate.insights().map((i) => i.summary)).toEqual(["요약 a", "요약 c", "요약 e"]);
  });

  it("opens an Insight's evidence, but a hidden Insight is not found, as an absent one is", () => {
    const a = source("a");
    const b = source("b", SECRET);
    const shown = insight("a", [a.versionId]);
    const hidden = insight("b", [b.versionId]);
    const gate = createReadGate(db, registryOf(policy()));
    expect(gate.insightEvidence(shown.id)?.evidence.map((e) => e.id)).toEqual(shown.evidenceIds);
    expect(gate.insightEvidence(hidden.id)).toBeUndefined();
    expect(gate.insightEvidence(9999)).toBeUndefined();
  });

  it("leaves a hidden evidence row out of a shown Insight's list, wherever it stands", () => {
    const a = source("a");
    const b = source("b");
    const c = source("c");
    const mixed = insight("m", [a.versionId, b.versionId, c.versionId]);
    // the Insight as a whole is allowed (a policy that judges the scope sets it is given), one row's source alone is not
    const bScope = ["only-b"];
    saveSourceRecord(db, "c", {
      externalId: "b",
      title: "제목 b",
      body: "합성 등대",
      accessScope: bScope,
    });
    const odd: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes) => !(scopes.length === 1 && scopes[0]?.[0] === "only-b"),
    };
    const gate = createReadGate(db, registryOf(odd));
    const listed = gate.insightEvidence(mixed.id);
    expect(listed?.evidence.map((e) => e.id)).toEqual([mixed.evidenceIds[0], mixed.evidenceIds[2]]);
    // the count the API gives is of the rows it returns, never of the stored links (3)
    expect(listed?.insight.evidenceCount).toBe(2);
    expect(gate.insights().find((i) => i.id === mixed.id)?.evidenceCount).toBe(2);
  });

  it("opens the source of an evidence row only while it is shown", () => {
    const a = source("a");
    const b = source("b", SECRET);
    const covered = source("c");
    const shown = insight("a", [a.versionId]);
    const hidden = insight("b", [b.versionId]);
    const gone = insight("c", [covered.versionId]);
    cover(covered.sourceId);
    const gate = createReadGate(db, registryOf(policy()));
    expect(gate.evidenceSource(shown.evidenceIds[0] as number)?.sourceVersion.title).toBe("제목 a");
    expect(gate.evidenceSource(hidden.evidenceIds[0] as number)).toBeUndefined();
    expect(gate.evidenceSource(gone.evidenceIds[0] as number)).toBeUndefined();
    expect(gate.evidenceSource(9999)).toBeUndefined();
  });

  it("asks for the purpose display on each of the three", () => {
    const a = source("a");
    const one = insight("a", [a.versionId]);
    const asked: ScopePurpose[] = [];
    const gate = createReadGate(db, registryOf(policy(asked)));
    gate.insights();
    gate.insightEvidence(one.id);
    gate.evidenceSource(one.evidenceIds[0] as number);
    expect(asked.length).toBeGreaterThanOrEqual(4);
    expect(new Set(asked)).toEqual(new Set(["display"]));
  });

  it("fails the call when the registry cannot judge", () => {
    const a = source("a");
    const one = insight("a", [a.versionId]);
    const gate = createReadGate(db, registryOf(throwing));
    expect(() => gate.insights()).toThrow("cannot judge");
    expect(() => gate.insightEvidence(one.id)).toThrow("cannot judge");
    expect(() => gate.evidenceSource(one.evidenceIds[0] as number)).toThrow("cannot judge");
  });
});
