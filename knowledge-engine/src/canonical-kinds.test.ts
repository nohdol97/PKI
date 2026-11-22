// I04-T03: the six canonical derivative kinds registered in the product registry
// (I04-R1), run through the testkit contract suite on the real schema
// (`derivatives.contract`, real implementations), with the closed list of the
// cases a kind may declare not applicable; `propagate.two-phase` over the
// schema's own cascades (I04-R2); and `reevaluate` (I04-R8, C3). A deletion and
// a new version reach the kinds only through the entries, applyTombstone and
// propagateNewVersion, which run the registry (their own tests are
// tombstone-entry.test.ts, deletion.test.ts and propagation.test.ts). Here a
// deletion is run through the registry directly (`deleteSource` below) so a test
// can read the registry's report, which the entry does not return.
import {
  addEvidence,
  insertItem,
  isFenceCurrent,
  listInvalidations,
  migrate,
  migrations,
  readChangeSeq,
  readInsight,
  readKnowledgeRevision,
  readTombstoneState,
  registerConnectorInstance,
  saveFact,
  saveInsight,
  saveRelation,
  saveSourceRecord,
  searchKeyword,
  setKnowledgeStatus,
  createDerivativeRegistry,
  type DerivativeKind,
  type DerivedRef,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SourceChange,
  type SourceVersionRef,
  type SqlDriver,
  type TombstoneReason,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  derivativeKindContract,
  seedLegacyTombstone,
  type DerivativeContractSubject,
} from "@pki/testkit";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CANONICAL_KINDS,
  derivativeRegistry,
  propagateCanonical,
  type CanonicalReport,
} from "./canonical-kinds.ts";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";
import { propagateNewVersion } from "./propagation.ts";

const AT = "2026-11-22T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

const permissive: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: () => true,
  allows: () => true,
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** Stores a version of `externalId`: its source and version row ids, and its product version. */
function version(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "c1", { externalId, title: `제목 ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const id = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, id, version: saved.version };
}
/** Evidence quoting the whole body of version row `versionId`. */
function cite(target: EvidenceTarget, versionId: number): number {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [versionId])[0]
    ?.body as string;
  return addEvidence(db, {
    target,
    sourceVersionId: versionId,
    start: 0,
    end: [...body].length,
    quote: body,
  });
}
const item = (name: string) => insertItem(db, { type: "Project", name, ...attrs });
const fact = (
  itemId: number,
  kind: string,
  value: string,
  extra: Partial<KnowledgeAttributes> = {},
) => saveFact(db, { itemId, kind, value, ...attrs, ...extra }).id;
const relation = (subjectId: number, objectId: number) =>
  saveRelation(db, { subjectId, type: DEPENDS_ON, objectId, ...attrs }).id;
const ids = (table: string) => db.all(`SELECT id FROM ${table} ORDER BY id`).map((r) => r.id);

const TABLES: Record<string, string> = {
  source: "source_versions",
  evidence: "evidence",
  fact: "facts",
  relation: "relations",
  item: "items",
  insight: "insights",
};
const exists = (ref: DerivedRef) =>
  db.all(`SELECT 1 FROM ${TABLES[ref.kind]} WHERE id = ?`, [Number(ref.id)]).length === 1;

/**
 * One state holding, for every kind, a row built from `a` only, one from `a` and
 * `b` (where the kind can have one) and one without lineage, and what built each.
 */
function world() {
  const a = version("a", "a의 본문 qzcanary");
  const b = version("b", "b의 본문");
  const lineA = [{ sourceId: a.sourceId, version: a.version }];
  const lineAB = [...lineA, { sourceId: b.sourceId, version: b.version }];

  const [xA, yA, xS, yS, xN, yN] = ["XA", "YA", "XS", "YS", "XN", "YN"].map(item) as number[];
  const fA = fact(xA as number, TARGET_DATE, "2026-12-05");
  const eA = cite({ factId: fA }, a.id);
  const rA = relation(xA as number, yA as number);
  const erA = cite({ relationId: rA }, a.id);
  const fS = fact(xS as number, TARGET_DATE, "2026-12-06");
  const efSa = cite({ factId: fS }, a.id);
  const efSb = cite({ factId: fS }, b.id);
  const rS = relation(xS as number, yS as number);
  const erSa = cite({ relationId: rS }, a.id);
  const erS = cite({ relationId: rS }, b.id);
  const fN = fact(xN as number, TARGET_DATE, "2026-12-07");
  const rN = relation(xN as number, yN as number);
  const key = (x: number, y: number) => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
  const iA = saveInsight(db, key(xA as number, yA as number), {
    state: "active",
    summary: "추론 qzcanary",
    evidenceIds: [eA, erA],
  });
  const iS = saveInsight(db, key(xS as number, yS as number), {
    state: "active",
    summary: "추론",
    evidenceIds: [efSa, efSb, erSa, erS],
  });
  const iN = saveInsight(db, key(xN as number, yN as number), { state: "resolved" });

  const rows: Record<
    string,
    { onlyA: number; shared: number | null; withoutLineage: number | null }
  > = {
    source: { onlyA: a.id, shared: null, withoutLineage: null },
    evidence: { onlyA: eA, shared: null, withoutLineage: null },
    fact: { onlyA: fA, shared: fS, withoutLineage: fN },
    relation: { onlyA: rA, shared: rS, withoutLineage: rN },
    item: { onlyA: xA as number, shared: xS as number, withoutLineage: xN as number },
    insight: { onlyA: iA, shared: iS, withoutLineage: iN },
  };
  const built = new Map<string, readonly SourceVersionRef[]>();
  for (const [kind, r] of Object.entries(rows)) {
    built.set(`${kind}:${r.onlyA}`, lineA);
    if (r.shared !== null) built.set(`${kind}:${r.shared}`, lineAB);
    if (r.withoutLineage !== null) built.set(`${kind}:${r.withoutLineage}`, []);
  }
  return { a, b, rows, built };
}

/**
 * A source's deletion as the entry does it, minus the entry's own steps (jobs,
 * hashing): the tombstone covering its latest version, then the registry's
 * propagation, whose report the entry does not return. Nothing to do once no
 * version is left.
 */
function deleteSource(
  target: SqlDriver,
  sourceId: number,
  { reason, at }: { reason: TombstoneReason; at: string },
):
  | { outcome: "unchanged" }
  | {
      outcome: "deleted";
      version: number;
      purge: Omit<CanonicalReport, "insights">;
      insights: CanonicalReport["insights"];
    } {
  return target.transaction(() => {
    const latest = target.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number | null;
    if (latest === null) return { outcome: "unchanged" as const };
    seedLegacyTombstone(target, { sourceId, version: latest, at, reason });
    const { insights, ...purge } = propagateCanonical(
      target,
      { kind: reason, sourceId, coversVersion: latest, lastRevision: null },
      at,
    ).report;
    return { outcome: "deleted" as const, version: latest, purge, insights };
  });
}

/** A tombstone change covering the source's versions, as the entry writes it. */
const deletionOf = (sourceId: number): SourceChange => ({
  kind: "source-deleted",
  sourceId,
  coversVersion: readTombstoneState(db, sourceId)?.coversVersion ?? 0,
  lastRevision: null,
});

/** The next row id a table gives (none is stored under it yet). */
const nextId = (table: string) =>
  ((db.all(`SELECT max(id) AS id FROM ${table}`)[0]?.id as number | null) ?? 0) + 1;

function subject(kind: DerivativeKind, has: { shared: boolean; withoutLineage: boolean }) {
  return {
    kind,
    has,
    setup: () => {
      const w = world();
      const ref = (id: number | null) => (id === null ? null : { kind: kind.kind, id: String(id) });
      const r = w.rows[kind.kind];
      if (!r) throw new Error(`no fixture rows for ${kind.kind}`);
      return {
        db,
        sources: { a: w.a.sourceId, b: w.b.sourceId },
        rows: {
          onlyA: ref(r.onlyA) as DerivedRef,
          shared: has.shared ? ref(r.shared) : null,
          withoutLineage: has.withoutLineage ? ref(r.withoutLineage) : null,
        },
        builtFrom: (row: DerivedRef) => w.built.get(`${row.kind}:${row.id}`) ?? [],
        exists,
        // The deletion through the registry (deleteSource above) and this
        // kind's counts from the record it left. A source deleteSource finds purged
        // already is left unchanged without propagating, so applying the same change
        // again goes through the registry itself (④ asks the kind, not the entry).
        remove: (sourceId: number) => {
          const deletion = deleteSource(db, sourceId, { reason: "source-deleted", at: AT });
          const record =
            deletion.outcome === "deleted"
              ? listInvalidations(db, 1)[0]
              : db.transaction(() => derivativeRegistry.propagate(db, deletionOf(sourceId)));
          return {
            removed: record?.removedByKind[kind.kind] ?? -1,
            recomputed: record?.recomputedByKind[kind.kind] ?? -1,
          };
        },
        // V02's fence (isFenceCurrent, the one closeJob writes a result behind)
        // stands in for commitDerived until I04-T06; a source version arrives
        // through saveSourceRecord, whose tombstone door blocks it. The write
        // behind the fence fails if it is ever reached.
        staleInput: () =>
          kind.kind === "source"
            ? {
                ref: { kind: "source", id: String(nextId("source_versions")) },
                attempt: () => {
                  const saved = saveSourceRecord(db, "c1", {
                    externalId: "a",
                    title: "제목 a",
                    body: "늦게 온 본문",
                  });
                  return saved.status === "blocked" ? { status: "stale", cause: "covered" } : saved;
                },
              }
            : {
                ref: { kind: kind.kind, id: String(nextId(TABLES[kind.kind] as string)) },
                attempt: () =>
                  isFenceCurrent(db, { sourceId: w.a.sourceId, fenceVersion: w.a.version })
                    ? (() => {
                        throw new Error("a result was written past the fence");
                      })()
                    : { status: "stale", cause: "covered" },
              },
        dataDirectory: null,
        canary: "qzcanary",
      };
    },
  } satisfies DerivativeContractSubject<SqlDriver>;
}

/**
 * The closed list of "기준별 증명 테스트" `derivatives.contract`: only these kinds
 * may declare ② or ③ not applicable; every other kind must have both rows.
 */
const NOT_APPLICABLE: Record<string, { shared: boolean; withoutLineage: boolean }> = {
  source: { shared: false, withoutLineage: false },
  evidence: { shared: false, withoutLineage: false },
};
const BOTH = { shared: true, withoutLineage: true };

const SUBJECTS: Record<string, { shared: boolean; withoutLineage: boolean }> = {
  source: { shared: false, withoutLineage: false },
  evidence: { shared: false, withoutLineage: false },
  fact: BOTH,
  relation: BOTH,
  item: BOTH,
  insight: BOTH,
};
for (const kind of CANONICAL_KINDS) {
  derivativeKindContract(`canonical kind ${kind.kind}`, subject(kind, SUBJECTS[kind.kind] ?? BOTH));
}

describe("the product registry's canonical kinds (I04-R1)", () => {
  it("registers the six canonical kinds in phase-2 order, each in the canonical transaction", () => {
    expect(derivativeRegistry.kinds.map((k) => [k.kind, k.layer, k.storage])).toEqual([
      ["source", "source", "canonical"],
      ["evidence", "evidence", "canonical"],
      ["fact", "knowledge", "canonical"],
      ["relation", "knowledge", "canonical"],
      ["item", "item", "canonical"],
      ["insight", "insight", "canonical"],
    ]);
    expect(CANONICAL_KINDS.every((k) => k.dataPaths.length === 0)).toBe(true);
  });

  it("declares not applicable only what the closed list allows, for every registered kind", () => {
    const canonical = derivativeRegistry.kinds.filter((k) => k.storage === "canonical");
    expect(Object.keys(SUBJECTS).sort()).toEqual(canonical.map((k) => k.kind).sort());
    for (const k of canonical) {
      expect(SUBJECTS[k.kind], k.kind).toEqual(NOT_APPLICABLE[k.kind] ?? BOTH);
    }
  });

  it("refuses old-versions-pruned until I04-T12 defines it, instead of counting zero", () => {
    const { a } = world();
    const change: SourceChange = { kind: "old-versions-pruned", sourceId: a.sourceId, version: 1 };
    expect(() => db.transaction(() => derivativeRegistry.propagate(db, change))).toThrow(
      /old-versions-pruned/,
    );
    expect(listInvalidations(db)).toEqual([]);
  });
});

describe("scope-changed (I04-R15): nothing is deleted, the source's Insights are judged again", () => {
  const scopeChange = (sourceId: number): SourceChange => ({
    kind: "scope-changed",
    sourceId,
    from: null,
    to: ["team"],
  });
  const counts = () =>
    ["source_versions", "evidence", "facts", "relations", "items", "insights"].map(
      (t) => db.all(`SELECT count(*) AS n FROM ${t}`)[0]?.n,
    );

  it("collects only the Insights whose lineage holds the source and changes no content", () => {
    const { b, rows } = world();
    const before = counts();
    const statuses = db.all(
      "SELECT id, status FROM facts UNION ALL SELECT id, status FROM relations",
    );
    const seq = readChangeSeq(db);
    const collected = new Map(
      CANONICAL_KINDS.map((k) => [
        k.kind,
        k.affected(db, scopeChange(b.sourceId)).map((r) => r.ref.id),
      ]),
    );
    expect(Object.fromEntries(collected)).toEqual({
      source: [],
      evidence: [],
      fact: [],
      relation: [],
      item: [],
      insight: [String(rows.insight?.shared)],
    });

    const { propagation } = db.transaction(() => propagateCanonical(db, scopeChange(b.sourceId)));

    expect(counts()).toEqual(before);
    expect(
      db.all("SELECT id, status FROM facts UNION ALL SELECT id, status FROM relations"),
    ).toEqual(statuses);
    expect(readChangeSeq(db)).toBe(seq);
    expect(listInvalidations(db)).toMatchObject([
      {
        id: propagation.invalidationId,
        changeKind: "scope-changed",
        removedByKind: { source: 0, evidence: 0, fact: 0, relation: 0, item: 0, insight: 0 },
      },
    ]);
  });

  it("recomputes those Insights by the rule, in their own rows", () => {
    const { b, rows } = world();
    const id = rows.insight?.shared as number;
    // the rule resolves the stored row on its items (no completion date on YS)
    const { propagation } = db.transaction(() => propagateCanonical(db, scopeChange(b.sourceId)));
    expect(propagation.recomputedByKind.insight).toBe(1);
    expect(db.all("SELECT id, state, summary FROM insights WHERE id = ?", [id])).toEqual([
      { id, state: "resolved", summary: null },
    ]);
    // judged again with nothing different: nothing to recompute
    const again = db.transaction(() => propagateCanonical(db, scopeChange(b.sourceId)));
    expect(again.propagation.recomputedByKind.insight).toBe(0);
  });
});

describe("propagateCanonical's report (I04-T03)", () => {
  it("notes the ids whatever driver object the kinds are handed", () => {
    const { a, rows } = world();
    const wrapped: SqlDriver = { ...db };
    const { report } = db.transaction(() =>
      propagateCanonical(wrapped, deletionOf(a.sourceId), AT),
    );
    expect(report).toMatchObject({
      versions: 1,
      facts: [rows.fact?.onlyA],
      relations: [rows.relation?.onlyA],
    });
    expect(listInvalidations(db)[0]?.at).toBe(AT);
  });

  it("fails, rolling back, when the kinds noted another propagation's record", () => {
    const { a, b } = world();
    let nested = false;
    const meddling: SqlDriver = {
      ...db,
      run: (sql, params) => {
        if (!nested && /^\s*DELETE FROM source_versions/i.test(sql)) {
          nested = true;
          derivativeRegistry.propagate(db, {
            kind: "user-deleted",
            sourceId: b.sourceId,
            coversVersion: 1,
            lastRevision: null,
          });
        }
        return db.run(sql, params);
      },
    };
    expect(() =>
      db.transaction(() => propagateCanonical(meddling, deletionOf(a.sourceId))),
    ).toThrow(/noted records/);
    expect(listInvalidations(db)).toEqual([]);
  });
});

describe("propagate.two-phase over the real schema's cascades (I04-R2)", () => {
  /** The canonical kinds with each call logged, and DELETEs logged through the handed transaction. */
  function logged(log: string[]) {
    const kinds = CANONICAL_KINDS.map((k): DerivativeKind => ({
      ...k,
      affected: (tx, change) => {
        log.push(`affected:${k.kind}`);
        return k.affected(tx, change);
      },
      invalidate: (ctx, snapshot, change) => {
        log.push(`invalidate:${k.kind}`);
        return k.invalidate(ctx, snapshot, change);
      },
    }));
    const tx: SqlDriver = {
      ...db,
      run: (sql, params) => {
        if (/^\s*DELETE/i.test(sql)) log.push("sql:DELETE");
        return db.run(sql, params);
      },
    };
    return { kinds, tx };
  }

  it("collects every kind before the first DELETE, then runs the layers in order", () => {
    const { a, rows } = world();
    const log: string[] = [];
    const { kinds, tx } = logged(log);
    // the product registry's list, logged: same kinds, same order
    const registry = createDerivativeRegistry({ kinds, policy: permissive });
    expect(registry.kinds.map((k) => k.kind)).toEqual(derivativeRegistry.kinds.map((k) => k.kind));
    const result = db.transaction(() => {
      seedLegacyTombstone(db, {
        sourceId: a.sourceId,
        version: 1,
        at: AT,
        reason: "source-deleted",
      });
      return registry.propagate(tx, deletionOf(a.sourceId)).removedByKind;
    });
    const firstDelete = log.indexOf("sql:DELETE");
    expect(log.filter((e) => e.startsWith("affected:"))).toHaveLength(6);
    expect(log.findLastIndex((e) => e.startsWith("affected:"))).toBeLessThan(firstDelete);
    expect(log.filter((e) => e.startsWith("invalidate:"))).toEqual(
      ["source", "evidence", "fact", "relation", "item", "insight"].map((k) => `invalidate:${k}`),
    );
    // evidence and the Insight left through the cascades of the lower layers'
    // deletes; each kind counts the rows of its own collection that are gone
    expect(result).toEqual({ source: 1, evidence: 4, fact: 1, relation: 1, item: 2, insight: 1 });
    expect(exists({ kind: "insight", id: String((rows.insight as { onlyA: number }).onlyA) })).toBe(
      false,
    );
  });

  it("runs the product registry with one record of every kind's counts", () => {
    const { a } = world();
    const seq = readChangeSeq(db);
    deleteSource(db, a.sourceId, { reason: "access-revoked", at: AT });
    expect(listInvalidations(db)).toEqual([
      {
        id: expect.any(Number),
        changeSeq: seq + 1,
        sourceId: a.sourceId,
        changeKind: "access-revoked",
        removedByKind: { source: 1, evidence: 4, fact: 1, relation: 1, item: 2, insight: 1 },
        // fS keeps b's current evidence (not superseded); iS is judged again
        recomputedByKind: { source: 0, evidence: 0, fact: 0, relation: 0, item: 0, insight: 1 },
        at: expect.any(String),
      },
    ]);
  });

  it("leaves the canonical state, tombstone, record and sequence as they were when a kind throws midway", () => {
    const { a } = world();
    db.exec(`CREATE TEMP TRIGGER fail_resolve BEFORE UPDATE ON insights
             BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    const seq = readChangeSeq(db);
    const before = ["source_versions", "evidence", "facts", "relations", "items", "insights"].map(
      ids,
    );
    expect(() => deleteSource(db, a.sourceId, { reason: "source-deleted", at: AT })).toThrow(
      /injected/,
    );
    expect(
      ["source_versions", "evidence", "facts", "relations", "items", "insights"].map(ids),
    ).toEqual(before);
    expect(readTombstoneState(db, a.sourceId)).toBeUndefined();
    expect(listInvalidations(db)).toEqual([]);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("records a new version's propagation too, with what it superseded and judged again", () => {
    const x = item("X");
    const v1 = version("a", "v1");
    const f = fact(x, TARGET_DATE, "2026-12-05");
    cite({ factId: f }, v1.id);
    version("a", "v2");
    propagateNewVersion(db, v1.sourceId);
    expect(listInvalidations(db)).toMatchObject([
      {
        sourceId: v1.sourceId,
        changeKind: "new-version",
        removedByKind: { source: 0, evidence: 0, fact: 0, relation: 0, item: 0, insight: 0 },
        recomputedByKind: { source: 0, evidence: 0, fact: 1, relation: 0, item: 0, insight: 0 },
      },
    ]);
    // the previous version and its evidence stay (I04-R10)
    expect(db.all("SELECT version FROM source_versions ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });
});

// Ported from storage purge.test.ts (purgeSourceContent, V02-R12 "T02가 넘기는 것"
// 5), now the canonical kinds' work behind the tombstone entry; the assertions are kept.
describe("a source's purge through the canonical kinds (V02-R12)", () => {
  const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
  const purge = (sourceId: number) => {
    const deletion = deleteSource(db, sourceId, { reason: "source-deleted", at: AT });
    if (deletion.outcome !== "deleted") throw new Error(deletion.outcome);
    return deletion.purge;
  };

  it("deletes every version of the source, its evidence and its keyword index rows", () => {
    const a1 = version("a", "첫 판 qzvold");
    const a2 = version("a", "둘째 판 jwxnew");
    const b1 = version("b", "다른 원본");
    const x = item("X");
    cite({ factId: fact(x, TARGET_DATE, "2026-12-05") }, a1.id);
    cite({ factId: fact(x, TARGET_DATE, "2026-12-06") }, a2.id);
    cite({ factId: fact(x, TARGET_DATE, "2026-12-07") }, b1.id);
    const seq = readChangeSeq(db);

    const result = purge(a1.sourceId);

    expect(result.versions).toBe(2);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: b1.sourceId }]);
    expect(db.all("SELECT source_version_id FROM evidence")).toEqual([
      { source_version_id: b1.id },
    ]);
    expect(searchKeyword(db, "qzvold")).toEqual([]);
    expect(searchKeyword(db, "jwxnew")).toEqual([]);
    expect(searchKeyword(db, "다른")).toHaveLength(1);
    // the sources row (identifier only) stays for the tombstone, which alone raises the sequence
    expect(count("sources")).toBe(2);
    expect(readChangeSeq(db)).toBe(seq + 1);
  });

  it("deletes the facts and relations it left without evidence, superseded ones included", () => {
    const a1 = version("a", "v1");
    const a2 = version("a", "v2");
    const b1 = version("b", "b");
    const [x, y, z] = [item("X"), item("Y"), item("Z")] as [number, number, number];
    const old = fact(x, TARGET_DATE, "2026-12-10");
    cite({ factId: old }, a1.id);
    setKnowledgeStatus(db, "fact", old, "superseded");
    const current = fact(x, TARGET_DATE, "2026-12-12");
    cite({ factId: current }, a2.id);
    const shared = fact(y, TARGET_DATE, "2026-12-05");
    cite({ factId: shared }, a2.id);
    cite({ factId: shared }, b1.id);
    const dependsOn = relation(x, y);
    cite({ relationId: dependsOn }, a1.id);
    const kept = relation(y, z);
    cite({ relationId: kept }, b1.id);

    const result = purge(a1.sourceId);

    expect(result.facts).toEqual([old, current]);
    expect(result.relations).toEqual([dependsOn]);
    expect(ids("facts")).toEqual([shared]);
    expect(ids("relations")).toEqual([kept]);
    expect(db.all("SELECT count(*) AS n FROM evidence WHERE fact_id = ?", [shared])).toEqual([
      { n: 1 },
    ]);
  });

  it("deletes only collected items left without facts and relations, never an unrelated one", () => {
    const a1 = version("a", "a");
    const b1 = version("b", "b");
    const [x, y, keptByB, unrelated] = [item("X"), item("Y"), item("K"), item("U")] as number[];
    cite({ factId: fact(x as number, TARGET_DATE, "2026-12-05") }, a1.id);
    cite({ relationId: relation(x as number, y as number) }, a1.id);
    cite({ factId: fact(keptByB as number, TARGET_DATE, "2026-12-01") }, b1.id);
    cite({ relationId: relation(keptByB as number, y as number) }, a1.id);
    // an Insight on X (deleted) and one on K and Y (both stay)
    saveInsight(
      db,
      { rule: "r", xItemId: x as number, yItemId: y as number },
      { state: "resolved" },
    );
    saveInsight(
      db,
      { rule: "r", xItemId: keptByB as number, yItemId: y as number },
      {
        state: "resolved",
      },
    );

    const result = purge(a1.sourceId);

    expect(result.items).toEqual([x, y]);
    expect(result.remainingItemIds).toEqual([keptByB]);
    expect(ids("items")).toEqual([keptByB, unrelated]);
    expect(db.all("SELECT x_item_id, y_item_id FROM insights")).toEqual([]);
  });

  it("never touches a fact or relation without evidence that the source did not reach (review A-S2)", () => {
    const a1 = version("a", "a");
    const [x, y] = [item("X"), item("Y")] as [number, number];
    cite({ factId: fact(x, TARGET_DATE, "2026-12-05") }, a1.id);
    const bare = fact(y, TARGET_DATE, "2026-12-09");
    const bareRelation = relation(y, x);

    const result = purge(a1.sourceId);

    expect(result.facts).not.toContain(bare);
    expect(ids("facts")).toEqual([bare]);
    expect(ids("relations")).toEqual([bareRelation]);
    expect(ids("items")).toEqual([x, y]);
  });

  it("keeps an item another source's relation still points at", () => {
    const a1 = version("a", "a");
    const b1 = version("b", "b");
    const [x, y] = [item("X"), item("Y")] as [number, number];
    cite({ factId: fact(y, TARGET_DATE, "2026-12-10") }, a1.id);
    cite({ relationId: relation(x, y) }, b1.id);
    saveInsight(
      db,
      { rule: "r", xItemId: x, yItemId: y },
      { state: "active", summary: "추론", evidenceIds: [] },
    );

    const result = purge(a1.sourceId);

    expect(result.items).toEqual([]);
    expect(result.remainingItemIds).toEqual([y]);
    expect(ids("items")).toEqual([x, y]);
    expect(count("insights")).toBe(1);
  });

  it("leaves no word of a version indexed before a v8 upgrade in the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pki-purge-"));
    const file = join(dir, "upgraded.sqlite");
    const old = openBetterSqlite3(file);
    try {
      migrate(old, migrations.slice(0, 8));
      registerConnectorInstance(old, "c1", "test-fixtures");
      // Written as a v8 build wrote it: today's saveSourceRecord names a namespace (v12).
      old.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c1', 'a')");
      old.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 1, 'h', 'zkqtitle', '합성 vbnbody')",
      );
      expect(readFileSync(file).includes("vbnbody")).toBe(true);
      migrate(old);
      deleteSource(old, 1, { reason: "source-deleted", at: AT });
      const bytes = readFileSync(file);
      expect(["zkqtitle", "vbnbody"].filter((c) => bytes.includes(c))).toEqual([]);
    } finally {
      old.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Ported from storage knowledge.test.ts ("a new version's propagation",
// supersedeUnsupported, V02-R11), now the fact and relation kinds behind
// propagateNewVersion; the assertions are kept.
describe("a new version's propagation through the canonical kinds (V02-R11)", () => {
  const statusOf = (table: "facts" | "relations", id: number) =>
    db.all(`SELECT status FROM ${table} WHERE id = ?`, [id])[0]?.status;

  it("supersedes what the source's newer version leaves without current evidence, keeping the evidence on its version", () => {
    const [a, b, c] = [item("A"), item("B"), item("C")] as [number, number, number];
    const v1 = version("msg-1", "B API는 12월 10일");
    const other = version("wiki-1", "B API는 12월 10일");
    const unrelated = version("mail-1", "C는 12월 5일");
    const onlyHere = fact(b, "completion", "12-10");
    const shared = fact(b, "name", "B API");
    const rejected = fact(b, "owner", "x", { status: "rejected" });
    const dependsOn = relation(a, b);
    const elsewhere = fact(c, "target", "12-05");
    const old = cite({ factId: onlyHere }, v1.id);
    cite({ factId: shared }, v1.id);
    cite({ factId: shared }, other.id);
    cite({ factId: rejected }, v1.id);
    cite({ relationId: dependsOn }, v1.id);
    cite({ factId: elsewhere }, unrelated.id);

    const v2 = version("msg-1", "B API는 12월 3일");
    const seq = readChangeSeq(db);
    const revision = readKnowledgeRevision(db);
    expect(propagateNewVersion(db, v1.sourceId)).toMatchObject({
      facts: [onlyHere],
      relations: [dependsOn],
    });

    expect(statusOf("facts", onlyHere)).toBe("superseded");
    expect(statusOf("relations", dependsOn)).toBe("superseded");
    expect(statusOf("facts", shared)).toBe("candidate"); // another source's evidence is current
    expect(statusOf("facts", rejected)).toBe("rejected"); // a rejection is not overwritten
    expect(statusOf("facts", elsewhere)).toBe("candidate");
    // the evidence is not taken off: it stays on version 1 as past evidence
    expect(
      db.all("SELECT id, source_version_id FROM evidence WHERE fact_id = ?", [onlyHere]),
    ).toEqual([{ id: old, source_version_id: v1.id }]);
    expect(v2.id).toBeGreaterThan(v1.id);
    // the triggers count: two rows changed, no source version stored
    expect(readKnowledgeRevision(db)).toBe(revision + 2);
    expect(readChangeSeq(db)).toBe(seq);
    // nothing is left to supersede the second time; the cited rows' items are still collected
    expect(propagateNewVersion(db, v1.sourceId)).toMatchObject({ facts: [], relations: [] });
    const item_ = CANONICAL_KINDS.find((k) => k.kind === "item") as DerivativeKind;
    const change: SourceChange = { kind: "new-version", sourceId: v1.sourceId, version: 2 };
    expect(item_.affected(db, change).map((r) => Number(r.ref.id))).toEqual([a, b]);
    expect(readKnowledgeRevision(db)).toBe(revision + 2);
  });

  it("supersedes nothing while the cited version is still the source's latest", () => {
    const factId = fact(item("B"), "k", "v");
    const v1 = version("msg-1", "B API");
    cite({ factId }, v1.id);
    expect(propagateNewVersion(db, v1.sourceId).facts).toEqual([]);
    expect(statusOf("facts", factId)).toBe("candidate");
  });
});

describe("reevaluate (I04-R8, C3)", () => {
  it("judges the knowledge left by a deletion again, deletes what lost all its evidence, and recomputes its Insight", () => {
    const [x, y] = [item("미리내"), item("물결")] as [number, number];
    const a1 = version("a", "a 원본 완료 12-12");
    const b1 = version("b", "b 원본");
    const c1 = version("c", "c 원본");
    // X targets 12-05 and depends on Y (b); Y completes 12-10 (b, current) and 12-12 (a only)
    const target = fact(x, TARGET_DATE, "2026-12-05");
    cite({ factId: target }, b1.id);
    const dependsOn = relation(x, y);
    cite({ relationId: dependsOn }, b1.id);
    const late = fact(y, COMPLETION_DATE, "2026-12-12");
    cite({ factId: late }, a1.id);
    const kept = fact(y, COMPLETION_DATE, "2026-12-10");
    cite({ factId: kept }, b1.id);
    cite({ factId: kept }, a1.id);
    // cited by c v1 and a; c moves on, so only past evidence of c is left after a goes
    const past = fact(y, "owner", "팀", { epistemic: "inferred" });
    cite({ factId: past }, c1.id);
    cite({ factId: past }, a1.id);
    version("c", "c 원본 둘째 판");
    // a user-approved value whose only evidence is a's
    const approved = fact(x, "owner", "나", { epistemic: "user-approved" });
    cite({ factId: approved }, a1.id);
    // no lineage at all: never collected, so never judged
    const bare = fact(x, "note", "근거 없음");
    recomputeDependencyDelay(db, [x, y]);
    const key = { rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y };
    const before = readInsight(db, key);
    expect(before?.summary).toContain("2026-12-12");

    const result = deleteSource(db, a1.sourceId, { reason: "user-deleted", at: AT });

    const row = (id: number) =>
      db.all("SELECT status, epistemic FROM facts WHERE id = ?", [id])[0] ?? null;
    expect(row(kept)).toEqual({ status: "candidate", epistemic: "explicit" }); // b is current
    expect(row(past)).toEqual({ status: "superseded", epistemic: "inferred" }); // type kept
    expect(row(late)).toBeNull();
    expect(row(approved)).toBeNull();
    expect(row(bare)).toEqual({ status: "candidate", epistemic: "explicit" });
    expect(result).toMatchObject({ insights: [{ key, outcome: "updated" }] });
    // the same row, its explanation recomputed without the deleted source's date
    const after = readInsight(db, key);
    expect(after).toMatchObject({ id: before?.id, state: "active" });
    expect(after?.summary).toContain("2026-12-10");
    expect(after?.summary).not.toContain("2026-12-12");
  });
});
