// S02-T05 `resolution.group-reads` (S02-R13): the rule "의존 업무 지연" and the kind `insight` read a merge group as one
// item. The groups are made by merge lines written directly where a test is about the pure rule, and by the user's
// entry where it is about the notification. All data is synthetic.
import {
  addEvidence,
  automatedLifecycle,
  createUserDecisions,
  defaultScopePolicy,
  insertItem,
  listInvalidations,
  mayCombine,
  migrate,
  readInsight,
  registerConnectorInstance,
  saveFact,
  saveRelation,
  saveSourceRecord,
  scopesOfVersions,
  type KnowledgeAttributes,
  type ScopePolicy,
  type SourceChange,
  type TombstoneReason,
  type SqlDriver,
  type UserDecisions,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { seedLegacyTombstone, memoryDbTemplate } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry, propagateCanonical } from "./canonical-kinds.ts";
import {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
} from "./dependency-delay.ts";
import { insightsReceiver } from "./insight-code-rules.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const item = (name: string) => {
  const id = insertItem(db, { type: "Project", name, ...attrs });
  automatedLifecycle.created(db, { kind: "item", id }, "extraction", { sourceId: 1, version: 1 });
  return id;
};

/** Stores `body` as the next version of source `externalId`; returns that version's row id. */
function version(externalId: string, body: string): number {
  saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  return db.all(
    `SELECT max(v.id) AS id FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE s.external_id = ?`,
    [externalId],
  )[0]?.id as number;
}
function quote(
  target: { factId: number } | { relationId: number },
  externalId: string,
  body: string,
) {
  addEvidence(db, {
    target,
    sourceVersionId: version(externalId, body),
    start: 0,
    end: body.length,
    quote: body,
  });
}
function fact(itemId: number, kind: string, value: string, externalId: string) {
  const id = saveFact(db, { itemId, kind, value, ...attrs }).id;
  quote({ factId: id }, externalId, `${kind} ${value}`);
  return id;
}
function dependsOn(subjectId: number, objectId: number, externalId: string) {
  const id = saveRelation(db, { subjectId, type: DEPENDS_ON, objectId, ...attrs }).id;
  quote({ relationId: id }, externalId, `${subjectId} depends on ${objectId}`);
  return id;
}
/** A merge line as the user's entry leaves it, written directly: the member is the representative's. */
const line = (member: number, representative: number, active = 1) =>
  db.run("INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, ?, ?)", [
    member,
    representative,
    active,
    "2026-11-23T00:00:00.000Z",
  ]);
const key = (x: number, y: number) => ({ rule: DEPENDENCY_DELAY, xItemId: x, yItemId: y });
const rows = () => db.all("SELECT x_item_id, y_item_id, state FROM insights ORDER BY id");
const live = () => rows().filter((r) => r.state === "active");

/** X (target 12-05) depends on Y; Y′ holds the completion date (12-10), so only a group makes it late. */
function lateThroughMember() {
  const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
  fact(x, TARGET_DATE, "2026-12-05", "s-target");
  dependsOn(x, y, "s-dep");
  const completion = fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
  return { x, y, yPrime, completion };
}

describe("resolution.group-reads: the rule reads a group as one item (S02-R13)", () => {
  it("makes no Insight before the merge and one keyed by the representative after it", () => {
    const { x, y, yPrime } = lateThroughMember();
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([]);
    expect(rows()).toEqual([]);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
    ]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    expect(readInsight(db, key(x, y))?.summary).toContain("2026-12-10");
  });

  it("resolves an Insight keyed by a member and makes the representative's", () => {
    const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, yPrime, "s-dep");
    fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
    expect(recomputeDependencyDelay(db, [x])).toEqual([
      { key: key(x, yPrime), outcome: "created" },
    ]);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [yPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
      { key: key(x, yPrime), outcome: "resolved" },
    ]);
    expect(rows()).toEqual([
      { x_item_id: x, y_item_id: yPrime, state: "resolved" },
      { x_item_id: x, y_item_id: y, state: "active" },
    ]);
  });

  it("reads the dependency from any member of X's group to any member of Y's group", () => {
    const [x, xPrime, y, yPrime] = [item("X"), item("X′"), item("Y"), item("Y′")] as const;
    const t = fact(x, TARGET_DATE, "2026-12-05", "s-target");
    const r = dependsOn(xPrime, yPrime, "s-dep");
    const c = fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
    line(xPrime, x);
    line(yPrime, y);
    expect(recomputeDependencyDelay(db, [xPrime])).toEqual([
      { key: key(x, y), outcome: "created" },
    ]);
    const used = [
      ...db.all("SELECT id FROM evidence WHERE fact_id = ?", [t]),
      ...db.all("SELECT id FROM evidence WHERE relation_id = ?", [r]),
      ...db.all("SELECT id FROM evidence WHERE fact_id = ?", [c]),
    ]
      .map((e) => e.id as number)
      .sort((a, b) => a - b);
    expect(readInsight(db, key(x, y))?.evidenceIds).toEqual(used);
  });

  it("takes the earliest target and the latest completion across the members", () => {
    const [x, xPrime, y, yPrime] = [item("X"), item("X′"), item("Y"), item("Y′")] as const;
    fact(x, TARGET_DATE, "2026-12-20", "s-t1");
    fact(xPrime, TARGET_DATE, "2026-12-05", "s-t2");
    dependsOn(x, y, "s-dep");
    fact(y, COMPLETION_DATE, "2026-12-08", "s-c1");
    fact(yPrime, COMPLETION_DATE, "2026-12-12", "s-c2");
    line(xPrime, x);
    line(yPrime, y);
    recomputeDependencyDelay(db, [x]);
    const summary = readInsight(db, key(x, y))?.summary ?? "";
    expect(summary).toContain("2026-12-12");
    expect(summary).toContain("2026-12-05");
    expect(summary).not.toContain("2026-12-20");
    expect(summary).not.toContain("2026-12-08");
  });

  it("skips a pair whose two ends are one group: the stored row is resolved and no (X, X) row is made", () => {
    const { x, y } = lateThroughMember();
    line(db.all("SELECT id FROM items WHERE name = 'Y′'")[0]?.id as number, y);
    recomputeDependencyDelay(db, [x]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    line(y, x);
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(x, y), outcome: "resolved" }]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
  });

  it("does not read a resting line: the members are judged alone", () => {
    const { x, y, yPrime } = lateThroughMember();
    line(yPrime, y, 0);
    expect(recomputeDependencyDelay(db, [x, y, yPrime])).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("control: with no merge line the outcomes are those of the item-keyed rule", () => {
    const [x, y] = [item("X"), item("Y")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, y, "s-dep");
    fact(y, COMPLETION_DATE, "2026-12-10", "s-completion");
    expect(recomputeDependencyDelay(db, [x])).toEqual([{ key: key(x, y), outcome: "created" }]);
    expect(recomputeDependencyDelay(db, [y])).toEqual([{ key: key(x, y), outcome: "unchanged" }]);
  });
});

const AT = "2026-11-23T00:00:00.000Z";
/** The user's entry with the rule's receiver, the way the composition root builds it; `combinable` is its scope policy. */
const entryWith = (combinable: (lineageSize: number) => boolean = () => true): UserDecisions =>
  createUserDecisions({
    combinable: (_tx, lineage) => combinable(lineage.length),
    listeners: [insightsReceiver],
  });
const mergeThrough = (entry: UserDecisions, member: number, into: number) => {
  const done = db.transaction(() => entry.entities.merge(db, member, into, AT));
  if (done.status !== "applied") throw new Error(`merge: ${done.reason}`);
  return done.mergeId;
};

describe("resolution.group-reads: merge and unmerge recompute the rule (S02-R13)", () => {
  it("merging Y′ into Y makes the Insight keyed by the representative, in the merge's own transaction", () => {
    const { x, y, yPrime } = lateThroughMember();
    expect(rows()).toEqual([]);
    mergeThrough(entryWith(), yPrime, y);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
  });

  it("unmerging resolves it and the resolved row stays", () => {
    const { x, y, yPrime } = lateThroughMember();
    const entry = entryWith();
    const id = mergeThrough(entry, yPrime, y);
    db.transaction(() => entry.entities.unmerge(db, id, true, AT));
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
    expect(readInsight(db, key(x, y))?.evidenceIds).toEqual([]);
  });

  it("a split's moved rows: the Insight that relied on them is resolved and one is made for the new item when it holds", () => {
    const [x, y] = [item("X"), item("Y")] as const;
    const target = fact(x, TARGET_DATE, "2026-12-05", "s-target");
    const dep = dependsOn(x, y, "s-dep");
    fact(y, COMPLETION_DATE, "2026-12-10", "s-completion");
    fact(x, "note", "stays on X", "s-note"); // a split leaves the item something
    recomputeDependencyDelay(db, [x]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    const done = db.transaction(() =>
      entryWith().entities.split(
        db,
        x,
        [
          { kind: "fact", id: target },
          { kind: "relation", id: dep },
        ],
        "X′",
        AT,
      ),
    );
    if (done.status !== "applied") throw new Error(done.reason);
    expect(rows()).toEqual([
      { x_item_id: x, y_item_id: y, state: "resolved" },
      { x_item_id: done.created, y_item_id: y, state: "active" },
    ]);
  });

  it("a receiver is handed the action's scope: sources the policy will not put together make no Insight (the merge itself is allowed)", () => {
    const { yPrime, y } = lateThroughMember();
    // the merge's group lineage is at most two source versions; the Insight's evidence quotes three
    mergeThrough(
      entryWith((size) => size <= 2),
      yPrime,
      y,
    );
    expect(db.all("SELECT count(*) AS n FROM item_merges")[0]?.n).toBe(1);
    expect(rows()).toEqual([]);
  });
});

// ---- the kind `insight` through the group: a member's source goes, a scope changes (S02-R13) ----

/** A policy that will not put a source of scope "secret" together with any other scope. */
const apart: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => !(scopes.length > 1 && scopes.some((s) => s?.includes("secret"))),
};
const registryOf = (policy: ScopePolicy = defaultScopePolicy) =>
  createProductRegistry({ policy, membershipListeners: [insightsReceiver] });
const entryUnder = (policy: ScopePolicy) =>
  createUserDecisions({
    combinable: (tx, lineage) => mayCombine(policy, scopesOfVersions(tx, lineage)),
    listeners: [insightsReceiver],
  });
const sourceId = (externalId: string) =>
  db.all("SELECT id FROM sources WHERE external_id = ?", [externalId])[0]?.id as number;
const record = () => listInvalidations(db, 1)[0];

/** A source's deletion as the entry does it: the tombstone, then the registry's propagation in one transaction. */
function deleteSource(
  id: number,
  reason: TombstoneReason = "source-deleted",
  policy: ScopePolicy = defaultScopePolicy,
) {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      id,
    ])[0]?.v as number;
    seedLegacyTombstone(db, { sourceId: id, version: latest, at: AT, reason });
    return propagateCanonical(
      db,
      { kind: reason, sourceId: id, coversVersion: latest, lastRevision: null },
      AT,
      registryOf(policy),
    );
  });
}

/**
 * X (target 12-05, in "s-target") depends on Y; Y has a fact of its own ("s-y"); Y′ is Y's member and holds
 * the completion date (12-10, in "s-completion"). The merge is made through the entry with the rule's receiver,
 * so the Insight keyed by Y is the receiver's.
 */
function mergedWorld(policy: ScopePolicy = defaultScopePolicy) {
  const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
  fact(x, TARGET_DATE, "2026-12-05", "s-target");
  dependsOn(x, y, "s-dep");
  fact(y, "note", "Y's own fact", "s-y");
  fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
  mergeThrough(entryUnder(policy), yPrime, y);
  expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
  return { x, y, yPrime };
}

describe("resolution.group-reads: a member's source goes (S02-R13)", () => {
  it.each(["source-deleted", "access-revoked", "user-deleted"] as const)(
    "deleting the source of the member's completion date resolves the representative's Insight in the same propagation (%s)",
    (reason) => {
      const { x, y } = mergedWorld();
      expect(readInsight(db, key(x, y))?.summary).toContain("2026-12-10");
      deleteSource(sourceId("s-completion"), reason);
      expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
      // red case (spec 491): were the collection blind to the group, the date would stay in the explanation
      expect(db.all("SELECT summary FROM insights")[0]?.summary).toBeNull();
      expect(db.all("SELECT count(*) AS n FROM insight_evidence")[0]?.n).toBe(0);
      expect(record()?.recomputedByKind.insight).toBeGreaterThanOrEqual(1);
    },
  );

  it("deleting the representative's only source keeps the surviving member's Insight: it is keyed by the member afterwards", () => {
    const [x, y, yPrime] = [item("X"), item("Y"), item("Y′")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, yPrime, "s-dep");
    fact(yPrime, COMPLETION_DATE, "2026-12-10", "s-completion");
    fact(y, "note", "Y only", "s-y");
    mergeThrough(entryUnder(defaultScopePolicy), yPrime, y);
    expect(live()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
    deleteSource(sourceId("s-y"));
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [y])).toEqual([]);
    expect(live()).toEqual([{ x_item_id: x, y_item_id: yPrime, state: "active" }]);
  });

  it("does the same when an old version's prune takes the member's date", () => {
    const { x, y } = mergedWorld();
    const next = saveSourceRecord(db, "c1", {
      externalId: "s-completion",
      title: "s-completion",
      body: "a newer body that cites nothing",
    });
    if (next.status !== "created") throw new Error(next.status);
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "old-versions-pruned", sourceId: next.sourceId, version: next.version },
        AT,
        registryOf(),
      ),
    );
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
    expect(db.all("SELECT summary FROM insights")[0]?.summary).toBeNull();
  });

  it("a new version of the member's source that moves the date updates the representative's Insight", () => {
    const { x, y, yPrime } = mergedWorld();
    const next = saveSourceRecord(db, "c1", {
      externalId: "s-completion",
      title: "s-completion",
      body: `${COMPLETION_DATE} 2026-12-20`,
    });
    if (next.status !== "created") throw new Error(next.status);
    const moved = saveFact(db, {
      itemId: yPrime,
      kind: COMPLETION_DATE,
      value: "2026-12-20",
      ...attrs,
    }).id;
    const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    addEvidence(db, {
      target: { factId: moved },
      sourceVersionId: versionId,
      start: 0,
      end: `${COMPLETION_DATE} 2026-12-20`.length,
      quote: `${COMPLETION_DATE} 2026-12-20`,
    });
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "new-version", sourceId: next.sourceId, version: next.version },
        AT,
        registryOf(),
      ),
    );
    expect(readInsight(db, key(x, y))?.summary).toContain("2026-12-20");
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
  });
});

describe("resolution.scope (Insight part): a group rests and wakes with the scope (S02-R13)", () => {
  const narrow = (id: number, to: string[] | null): SourceChange => ({
    kind: "scope-changed",
    sourceId: id,
    from: to === null ? ["secret"] : null,
    to,
  });

  it("a scope change that rests the group resolves the representative's Insight, and widening again brings it back", () => {
    const { x, y } = mergedWorld(apart);
    const anchor = sourceId("s-y");
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      anchor,
    ]);
    db.transaction(() => propagateCanonical(db, narrow(anchor, ["secret"]), AT, registryOf(apart)));
    expect(db.all("SELECT active FROM item_merges")).toEqual([{ active: 0 }]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "resolved" }]);
    expect(record()?.recomputedByKind.insight).toBeGreaterThanOrEqual(1);
    db.run("UPDATE sources SET access_scope = NULL WHERE id = ?", [anchor]);
    db.transaction(() => propagateCanonical(db, narrow(anchor, null), AT, registryOf(apart)));
    expect(db.all("SELECT active FROM item_merges")).toEqual([{ active: 1 }]);
    expect(rows()).toEqual([{ x_item_id: x, y_item_id: y, state: "active" }]);
  });

  /** A, B, C merged (C on top), X depends on A, B holds the date: the Insight is the group {A, B, C}'s. C's source is secret. */
  function restingWorld() {
    const [x, a, b, c] = [item("X"), item("A"), item("B"), item("C")] as const;
    fact(x, TARGET_DATE, "2026-12-05", "s-target");
    dependsOn(x, a, "s-dep");
    fact(a, "note", "A's fact", "s-a");
    fact(b, COMPLETION_DATE, "2026-12-10", "s-b");
    fact(c, "note", "C's fact", "s-c");
    const entry = entryUnder(apart);
    mergeThrough(entry, a, b);
    mergeThrough(entry, b, c);
    // the dependency names A, a member of C's group: the Insight is keyed by C
    expect(live()).toEqual([{ x_item_id: x, y_item_id: c, state: "active" }]);
    const secret = sourceId("s-c");
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      secret,
    ]);
    db.transaction(() => propagateCanonical(db, narrow(secret, ["secret"]), AT, registryOf(apart)));
    expect(db.all("SELECT active FROM item_merges")).toEqual([{ active: 0 }, { active: 0 }]);
    expect(live()).toEqual([]);
    return { x, a, b, c };
  }

  it.each(["source-deleted", "access-revoked", "user-deleted"] as const)(
    "deleting the source that makes {A, B, C} rest wakes A and B and the Insight returns in that propagation (%s)",
    (reason) => {
      const { x, b } = restingWorld();
      deleteSource(sourceId("s-c"), reason, apart);
      expect(db.all("SELECT active FROM item_merges")).toEqual([{ active: 1 }]);
      // C's own line went, A's line to B stays: B is the top, so the Insight is keyed by B
      expect(live()).toEqual([{ x_item_id: x, y_item_id: b, state: "active" }]);
      // the tally pins D7: the Insight the receiver made is in the record's insight count
      expect(record()?.recomputedByKind.insight).toBeGreaterThanOrEqual(1);
      expect(record()?.recomputedByKind["entity-merge"]).toBeGreaterThanOrEqual(1);
    },
  );

  it("wakes A and B when an old version's prune takes the resting item's only evidence", () => {
    const { x, b } = restingWorld();
    const next = saveSourceRecord(db, "c1", {
      externalId: "s-c",
      title: "s-c",
      body: "a newer body that cites nothing",
    });
    if (next.status !== "created") throw new Error(next.status);
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "old-versions-pruned", sourceId: next.sourceId, version: next.version },
        AT,
        registryOf(apart),
      ),
    );
    expect(live()).toEqual([{ x_item_id: x, y_item_id: b, state: "active" }]);
  });

  it("the receiver does not throw inside a deletion's propagation: the record is made and nothing is rolled back", () => {
    restingWorld();
    expect(() => deleteSource(sourceId("s-c"), "source-deleted", apart)).not.toThrow();
    expect(record()).toBeDefined();
    expect(db.all("SELECT 1 FROM tombstones")).toHaveLength(1);
  });
});
