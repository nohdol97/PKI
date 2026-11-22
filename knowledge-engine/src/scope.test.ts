// scope.inherit and scope.changed (I04-C1, R14, R15, I04-T09) on a real SQLite
// schema: a derivative's scope is computed from its lineage, never stored; a scope
// change keeps every row but judges the Insights again under the policy (one that
// can no longer be put together is resolved, and comes back as the same row when
// the scopes allow it), and queues the re-extraction of the sources whose items
// the policy once refused (`scope-drop`, target `scope-recompute:<record id>`).
import {
  addEvidence,
  clearScopePolicyDrops,
  createCommitScope,
  defaultScopePolicy,
  insertItem,
  listInvalidations,
  migrate,
  readChangeSeq,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SourceChange,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry, propagateCanonical } from "./canonical-kinds.ts";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";

const AT = "2026-11-22T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

/** Items can be put together only when every source has the same scope: a stand-in for a site's rule. */
const sameScopeOnly: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => new Set(scopes.map((s) => JSON.stringify(s))).size <= 1,
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

function source(externalId: string, body: string, scope: readonly string[] | null) {
  const saved = saveSourceRecord(db, "c1", { externalId, title: `제목 ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  setScope(saved.sourceId, scope);
  const versionRow = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  return { sourceId: saved.sourceId, version: saved.version, versionRow };
}
const setScope = (sourceId: number, scope: readonly string[] | null) =>
  db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
    scope === null ? null : JSON.stringify(scope),
    sourceId,
  ]);
const cite = (target: EvidenceTarget, v: { versionRow: number }) => {
  const body = db.all("SELECT body FROM source_versions WHERE id = ?", [v.versionRow])[0]
    ?.body as string;
  return addEvidence(db, {
    target,
    sourceVersionId: v.versionRow,
    start: 0,
    end: [...body].length,
    quote: body,
  });
};
const item = (name: string) => insertItem(db, { type: "Project", name, ...attrs });

const scopeChange = (sourceId: number): SourceChange => ({
  kind: "scope-changed",
  sourceId,
  from: null,
  to: ["changed"],
});

/**
 * X depends on Y; X's target date and the relation are quoted by `a`, Y's completion
 * date by `b`, and the rule's Insight holds all three: a and b are in its lineage.
 */
function dependencyWorld(scopeA: readonly string[] | null, scopeB: readonly string[] | null) {
  const a = source("a", "a의 본문", scopeA);
  const b = source("b", "b의 본문", scopeB);
  const x = item("X");
  const y = item("Y");
  const target = saveFact(db, { itemId: x, kind: TARGET_DATE, value: "2026-12-05", ...attrs }).id;
  const completion = saveFact(db, {
    itemId: y,
    kind: COMPLETION_DATE,
    value: "2026-12-10",
    ...attrs,
  }).id;
  const relation = saveRelation(db, { subjectId: x, type: DEPENDS_ON, objectId: y, ...attrs }).id;
  cite({ factId: target }, a);
  cite({ relationId: relation }, a);
  cite({ factId: completion }, b);
  return { a, b, x, y };
}
const insightOf = (x: number, y: number) =>
  readInsight(db, { rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const registry = () => createProductRegistry({ policy: sameScopeOnly });
const run = (change: SourceChange) => {
  const policed = registry();
  return db.transaction(() => propagateCanonical(db, change, AT, policed));
};
/** The rule as the extraction's commit runs it: under the registry's policy. */
const judge = (items: number[]) => {
  const policed = registry();
  db.transaction(() =>
    recomputeDependencyDelay(db, items, { combinable: (l) => policed.combinable(db, l) }),
  );
};

describe("scope.inherit: a derivative's scope is its lineage's (I04-R14)", () => {
  it("is the scopes of the sources of a fact's evidence, and drops a source that lost its access", () => {
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const a = source("a", "a의 본문", ["a"]);
    const b = source("b", "b의 본문", ["b"]);
    const x = item("X");
    const fact = saveFact(db, { itemId: x, kind: TARGET_DATE, value: "2026-12-05", ...attrs }).id;
    cite({ factId: fact }, a);
    cite({ factId: fact }, b);
    const ref = { kind: "fact", id: String(fact) };

    expect(registry.scopesOf(db, [ref])).toEqual([["a"], ["b"]]);
    expect(defaultScopePolicy.strictest(registry.scopesOf(db, [ref]))).toEqual({
      incomparable: [["a"], ["b"]],
    });
    expect(defaultScopePolicy.allows(registry.scopesOf(db, [ref]), "search")).toBe(true);

    // b's access is revoked: its versions and evidence go, and the fact keeps a's scope alone
    db.transaction(() =>
      propagateCanonical(
        db,
        {
          kind: "access-revoked",
          sourceId: b.sourceId,
          coversVersion: b.version,
          lastRevision: null,
        },
        AT,
        registry,
      ),
    );
    expect(registry.scopesOf(db, [ref])).toEqual([["a"]]);
    expect(defaultScopePolicy.strictest(registry.scopesOf(db, [ref]))).toEqual(["a"]);
  });

  it("takes a source whose scope is unknown as null, the strictest, and never stores a derivative's scope", () => {
    const registry = createProductRegistry({ policy: defaultScopePolicy });
    const a = source("a", "a의 본문", ["a"]);
    const b = source("b", "b의 본문", null);
    const x = item("X");
    const fact = saveFact(db, { itemId: x, kind: TARGET_DATE, value: "2026-12-05", ...attrs }).id;
    cite({ factId: fact }, a);
    cite({ factId: fact }, b);
    const scopes = registry.scopesOf(db, [{ kind: "fact", id: String(fact) }]);
    expect(scopes).toEqual([["a"], null]);
    expect(defaultScopePolicy.strictest(scopes)).toBeNull();
    // nothing in the knowledge tables names a scope
    expect(JSON.stringify(db.all("SELECT * FROM facts"))).not.toContain('"a"');
  });
});

describe("scope.changed: the rule is judged again under the policy (I04-R15)", () => {
  it("resolves an Insight whose sources can no longer be put together, and revives the same row when they can", () => {
    const { b, x, y } = dependencyWorld(["team"], ["team"]);
    judge([x, y]);
    const first = insightOf(x, y);
    expect(first).toMatchObject({ state: "active" });
    const id = first?.id;
    const evidence = first?.evidenceIds;
    const seq = readChangeSeq(db);
    const versions = db.all("SELECT count(*) AS n FROM source_versions")[0]?.n;

    // b narrows to another scope: nothing is deleted, the Insight is resolved in its row
    setScope(b.sourceId, ["other"]);
    const narrowed = run(scopeChange(b.sourceId));
    expect(insightOf(x, y)).toMatchObject({ id, state: "resolved", summary: null });
    expect(narrowed.propagation.recomputedByKind.insight).toBe(1);
    expect(narrowed.propagation.removedByKind).toMatchObject({ source: 0, evidence: 0, item: 0 });
    expect(db.all("SELECT count(*) AS n FROM source_versions")[0]?.n).toBe(versions);
    expect(readChangeSeq(db)).toBe(seq); // no new version, no change sequence
    expect(listInvalidations(db)[0]).toMatchObject({
      changeKind: "scope-changed",
      sourceId: b.sourceId,
    });

    // judged again with nothing different: nothing to recompute
    expect(run(scopeChange(b.sourceId)).propagation.recomputedByKind.insight).toBe(0);

    // b widens back: the resolved row has no evidence link, yet it is found and revived as the same row
    setScope(b.sourceId, ["team"]);
    const widened = run(scopeChange(b.sourceId));
    expect(insightOf(x, y)).toMatchObject({ id, state: "active", evidenceIds: evidence });
    expect(widened.propagation.recomputedByKind.insight).toBe(1);
    // the scope shown is the new value, from the lineage
    expect(registry().scopesOf(db, [{ kind: "insight", id: String(id) }])).toEqual([["team"]]);
  });

  it("judges by the sources of the Insight's evidence only: a source the Insight does not quote does not resolve it", () => {
    const { x, y } = dependencyWorld(["team"], ["team"]);
    const outsider = source("z", "z의 본문", ["z"]);
    judge([x, y]);
    run(scopeChange(outsider.sourceId));
    expect(insightOf(x, y)).toMatchObject({ state: "active" });
  });

  it("also holds when a source is deleted: the rows that stay are judged under the policy too", () => {
    // c quotes the relation as well, so its deletion makes the rule judge the pair again
    const { b, x, y } = dependencyWorld(["team"], ["team"]);
    const c = source("c", "c의 본문", ["team"]);
    judge([x, y]);
    expect(insightOf(x, y)).toMatchObject({ state: "active" });
    setScope(b.sourceId, ["other"]);
    // b's scope now blocks the pair; the deletion of c is what makes it be judged
    const relationId = db.all("SELECT id FROM relations")[0]?.id as number;
    cite({ relationId }, c);
    run({
      kind: "source-deleted",
      sourceId: c.sourceId,
      coversVersion: c.version,
      lastRevision: null,
    });
    expect(insightOf(x, y)).toMatchObject({ state: "resolved" });
  });
});

const drop = (sourceId: number, version: number, key: string) =>
  createCommitScope({ policy: defaultScopePolicy, now: () => AT }).recordDrop(
    db,
    { kind: "fact", itemKey: key, lineage: [], write: () => undefined },
    { sourceId, version },
  );
const jobs = () =>
  db.all(
    "SELECT kind, target, source_id AS sourceId, fence_version AS fence, status FROM jobs ORDER BY id",
  );

describe("scope.changed: the re-extraction of sources the policy left something out of (I04-R15)", () => {
  it("queues one extract job per source with a record, at its latest version, under a target of the record's id", () => {
    const a = source("a", "a의 본문", ["a"]);
    const b1 = source("b", "b의 본문 1", ["b"]);
    const b2 = source("b", "b의 본문 2", ["b"]); // a newer version of b
    const c = source("c", "c의 본문", ["c"]); // no record
    drop(b1.sourceId, 1, "k1");
    drop(b1.sourceId, 1, "k2");
    drop(a.sourceId, 1, "k3");
    const { propagation } = run(scopeChange(c.sourceId));

    expect(jobs()).toEqual([
      {
        kind: "extract",
        target: `scope-recompute:${propagation.invalidationId}`,
        sourceId: a.sourceId,
        fence: 1,
        status: "queued",
      },
      {
        kind: "extract",
        target: `scope-recompute:${propagation.invalidationId}`,
        sourceId: b2.sourceId,
        fence: 2,
        status: "queued",
      },
    ]);
    expect(propagation.recomputedByKind["scope-drop"]).toBe(2);
    expect(propagation.removedByKind["scope-drop"]).toBe(0);
    // the records stay until the re-extraction has run (it clears them)
    expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")[0]?.n).toBe(3);
  });

  it("queues nothing for a scope change when no record exists", () => {
    const a = source("a", "a의 본문", ["a"]);
    const { propagation } = run(scopeChange(a.sourceId));
    expect(jobs()).toEqual([]);
    expect(propagation.recomputedByKind["scope-drop"]).toBe(0);
  });

  it("queues again, under another target, when the first extraction's job row still holds its own key and when a second widening follows", () => {
    const b = source("b", "b의 본문", ["b"]);
    // the first extraction's job: the same (kind, source, version) as the re-extraction's, target ''
    db.run(
      `INSERT INTO jobs (kind, target, source_id, fence_version, status, run_after, fairness_key,
         registered_change_seq, created_at, updated_at) VALUES ('extract', '', ?, 1, 'succeeded', 0, 'c1', 0, 0, 0)`,
      [b.sourceId],
    );
    drop(b.sourceId, 1, "k");
    const first = run(scopeChange(b.sourceId)).propagation.invalidationId;
    const second = run(scopeChange(b.sourceId)).propagation.invalidationId;
    expect(first).not.toBe(second);
    expect(jobs().map((j) => [j.target, j.status])).toEqual([
      ["", "succeeded"],
      [`scope-recompute:${first}`, "queued"],
      [`scope-recompute:${second}`, "queued"],
    ]);
  });

  it("keeps the records when the job rows are deleted (the jobs' retention clean-up)", () => {
    const b = source("b", "b의 본문", ["b"]);
    drop(b.sourceId, 1, "k");
    run(scopeChange(b.sourceId));
    db.run("DELETE FROM jobs");
    expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")[0]?.n).toBe(1);
  });

  it("queues no job for a source whose versions are all gone", () => {
    const b = source("b", "b의 본문", ["b"]);
    const other = source("o", "o의 본문", ["o"]);
    drop(b.sourceId, 1, "k");
    db.run("DELETE FROM source_versions WHERE source_id = ?", [b.sourceId]);
    run(scopeChange(other.sourceId));
    expect(jobs()).toEqual([]);
  });
});

describe("the registered kind scope-drop (I04-R3, R11)", () => {
  it("deletes a deleted source's records, and only that source's", () => {
    const a = source("a", "a의 본문", ["a"]);
    const b = source("b", "b의 본문", ["b"]);
    drop(a.sourceId, 1, "k1");
    drop(a.sourceId, 1, "k2");
    drop(b.sourceId, 1, "k3");
    const { propagation } = run({
      kind: "source-deleted",
      sourceId: a.sourceId,
      coversVersion: a.version,
      lastRevision: null,
    });
    expect(propagation.removedByKind["scope-drop"]).toBe(2);
    expect(db.all("SELECT source_id FROM scope_policy_drops")).toEqual([{ source_id: b.sourceId }]);
  });

  it("leaves the records alone for a new version", () => {
    const a = source("a", "a의 본문", ["a"]);
    drop(a.sourceId, 1, "k");
    const { propagation } = run({ kind: "new-version", sourceId: a.sourceId, version: 1 });
    expect(propagation.removedByKind["scope-drop"]).toBe(0);
    expect(propagation.recomputedByKind["scope-drop"]).toBe(0);
    expect(clearScopePolicyDrops(db, a.sourceId)).toBe(1);
  });
});

describe("allows: a use the policy refuses is not shown (I04-R13, R14)", () => {
  it("keeps, in order, the versions whose scopes the policy allows for the purpose, wherever the refused one stands", () => {
    const a = source("a", "a의 본문", ["open"]);
    const b = source("b", "b의 본문", ["secret"]);
    const c = source("c", "c의 본문", ["open"]);
    const d = source("d", "d의 본문", null);
    const policy: ScopePolicy = {
      ...defaultScopePolicy,
      allows: (scopes, purpose) =>
        purpose === "search" && scopes.every((s) => s !== null && !s.includes("secret")),
    };
    const registry = createProductRegistry({ policy });
    const refs = [b, a, d, c].map((v) => ({ kind: "source", id: String(v.versionRow) }));
    expect(registry.visible(db, refs, "search").map((r) => r.id)).toEqual([
      String(a.versionRow),
      String(c.versionRow),
    ]);
    // another purpose is another question
    expect(registry.visible(db, refs, "notify")).toEqual([]);
    // the default policy shows them all
    expect(
      createProductRegistry({ policy: defaultScopePolicy }).visible(db, refs, "search"),
    ).toHaveLength(4);
  });
});

describe("allows: only true shows a row (fail closed, I04-R13, R14)", () => {
  it.each([
    ["a string", "yes"],
    ["a number", 1],
    ["a promise", Promise.resolve(false)],
    ["undefined", undefined],
  ])("hides every row when the policy answers %s", (_name, answer) => {
    const a = source("a", "a의 본문", ["open"]);
    const b = source("b", "b의 본문", ["open"]);
    const policy = { ...defaultScopePolicy, allows: () => answer } as unknown as ScopePolicy;
    const refs = [a, b].map((v) => ({ kind: "source", id: String(v.versionRow) }));
    expect(createProductRegistry({ policy }).visible(db, refs, "search")).toEqual([]);
  });
});
