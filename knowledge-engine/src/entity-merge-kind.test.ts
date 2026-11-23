// S02-T04 `resolution.merge-unmerge` and `resolution.scope` (the merge part), through the real propagation (S02-R13,
// R14): the derivative kind `entity-merge` mends the chain around an item that a deletion, a revocation or a prune
// is about to delete, removes what an item's deletion takes, and rests or wakes a group when a scope or a lineage
// changes, announcing the change to the fixed list of listeners in the propagation's own transaction. The generic
// contract (`derivatives.contract`) for both kinds runs in canonical-kinds.test.ts. All data is synthetic; the
// groups are made by the user's entry, never by SQL, except where a test says so.
import {
  addEvidence,
  createUserDecisions,
  defaultScopePolicy,
  insertItem,
  listInvalidations,
  mayCombine,
  migrate,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  scopesOfVersions,
  type KnowledgeAttributes,
  type MembershipChange,
  type MembershipListener,
  type ScopePolicy,
  type SourceChange,
  type SqlDriver,
  type TombstoneReason,
  userDecisions,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry, propagateCanonical } from "./canonical-kinds.ts";

const AT = "2026-11-23T00:00:00.000Z";
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** A policy that will not put a source of scope "secret" together with any other scope. */
const apart: ScopePolicy = {
  ...defaultScopePolicy,
  combinable: (scopes) => !(scopes.length > 1 && scopes.some((s) => s?.includes("secret"))),
};

const announced: MembershipChange[] = [];
const spy: MembershipListener = (_tx, change) => announced.push(change);
beforeEach(() => {
  announced.length = 0;
});
const registryOf = (policy: ScopePolicy, listeners: readonly MembershipListener[] = [spy]) =>
  createProductRegistry({ policy, membershipListeners: listeners });

/** The user's entry under `policy`, as the composition root builds it. */
const entryUnder = (policy: ScopePolicy) =>
  createUserDecisions({
    combinable: (tx, lineage) => mayCombine(policy, scopesOfVersions(tx, lineage)),
    listeners: [],
  });

/** A source with one item that a fact of it built, so the item's lineage is that source. */
function itemFrom(externalId: string, accessScope: string[] | null = null) {
  const saved = saveSourceRecord(db, "c1", {
    externalId,
    title: `t-${externalId}`,
    body: `body of ${externalId}`,
    accessScope,
  });
  if (saved.status !== "created") throw new Error(saved.status);
  const versionId = db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
  const item = insertItem(db, { type: "Project", name: `item-${externalId}`, ...attrs });
  const fact = saveFact(db, {
    itemId: item,
    kind: "target_date",
    value: "2026-12-05",
    ...attrs,
  }).id;
  addEvidence(db, {
    target: { factId: fact },
    sourceVersionId: versionId,
    start: 0,
    end: 4,
    quote: "body",
  });
  return { item, sourceId: saved.sourceId, version: saved.version };
}

function merge(member: number, into: number, policy: ScopePolicy = defaultScopePolicy) {
  const merged = db.transaction(() => entryUnder(policy).entities.merge(db, member, into, AT));
  if (merged.status !== "applied") throw new Error(`merge refused: ${merged.reason}`);
}
const lines = () =>
  db.all("SELECT member_id, representative_id, active FROM item_merges ORDER BY member_id");
const flags = () => lines().map((l) => l.active);

/** A source's deletion as the entry does it: the tombstone, then the registry's propagation in one transaction. */
function deleteSource(
  sourceId: number,
  policy: ScopePolicy = defaultScopePolicy,
  reason: TombstoneReason = "source-deleted",
  listeners: readonly MembershipListener[] = [spy],
) {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number;
    seedLegacyTombstone(db, { sourceId, version: latest, at: AT, reason });
    return propagateCanonical(
      db,
      { kind: reason, sourceId, coversVersion: latest, lastRevision: null },
      AT,
      registryOf(policy, listeners),
    );
  });
}
const record = () => listInvalidations(db, 1)[0];

describe("resolution.merge-unmerge: a deleted item in a chain (S02-R14)", () => {
  it("joins the chain around the middle: A->B->C with B's source deleted is A->C, counted as recomputed, and A stays in C's group", () => {
    const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
    merge(a.item, b.item);
    merge(b.item, c.item);
    deleteSource(b.sourceId);
    expect(lines()).toEqual([{ member_id: a.item, representative_id: c.item, active: 1 }]);
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [b.item])).toEqual([]);
    // B's own line is the one that went; A's line, pointed at C instead, is the one recomputed
    expect(record()?.removedByKind["entity-merge"]).toBe(1);
    expect(record()?.recomputedByKind["entity-merge"]).toBe(1);
  });

  it("makes the smallest member the top when the top is deleted, and the others follow it", () => {
    const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
    merge(a.item, c.item);
    merge(b.item, c.item); // A->C, B->C
    deleteSource(c.sourceId);
    // A (the smaller id) leads; B joins it
    expect(lines()).toEqual([{ member_id: b.item, representative_id: a.item, active: 1 }]);
    expect(record()?.recomputedByKind["entity-merge"]).toBe(1);
  });

  it("leaves a group of two whose only line goes with the item, and leaves the survivor alone", () => {
    const [a, b] = [itemFrom("a"), itemFrom("b")] as const;
    merge(a.item, b.item);
    deleteSource(a.sourceId);
    expect(lines()).toEqual([]);
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [b.item])).toHaveLength(1);
  });

  it("takes the distinct marks and split records of a deleted item, and counts them with the line", () => {
    const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
    const mine = userDecisions.add(db, { kind: "item", type: "Project", name: "옮겨 받은 항목" });
    if (mine.status !== "applied") throw new Error("add");
    userDecisions.entities.setDistinct(db, a.item, c.item, true, AT);
    userDecisions.entities.setDistinct(db, b.item, c.item, true, AT);
    merge(a.item, b.item);
    // a split record (S02-T07 writes them): a row once on a, now on the user's item
    const moved = saveFact(db, {
      itemId: mine.ref.id,
      kind: "target_date",
      value: "2027-01-02",
      ...attrs,
    }).id;
    db.run("INSERT INTO item_split_moves (from_item_id, to_item_id, fact_id) VALUES (?, ?, ?)", [
      a.item,
      mine.ref.id,
      moved,
    ]);
    deleteSource(a.sourceId);
    // a is deleted with its source: its mark and the record that names it go, b's mark stays, the moved row stays
    expect(db.all("SELECT item_a, item_b FROM item_distinct")).toEqual([
      { item_a: b.item, item_b: c.item },
    ]);
    expect(db.all("SELECT 1 FROM item_split_moves")).toEqual([]);
    expect(db.all("SELECT 1 FROM facts WHERE id = ?", [moved])).toHaveLength(1);
    // the line, the mark and the split record of the collection are gone
    expect(record()?.removedByKind["entity-merge"]).toBe(3);
  });

  it("does the same for a revocation and for a user's deletion, and does nothing a second time", () => {
    for (const reason of ["access-revoked", "user-deleted"] as const) {
      db.run("DELETE FROM tombstones");
      db.run("DELETE FROM item_merges");
      const [a, b, c] = [
        itemFrom(`a-${reason}`),
        itemFrom(`b-${reason}`),
        itemFrom(`c-${reason}`),
      ] as const;
      merge(a.item, b.item);
      merge(b.item, c.item);
      deleteSource(b.sourceId, defaultScopePolicy, reason);
      expect(lines(), reason).toEqual([
        { member_id: a.item, representative_id: c.item, active: 1 },
      ]);
      // the same change again counts nothing
      const again = db.transaction(() =>
        registryOf(defaultScopePolicy).propagate(db, {
          kind: reason,
          sourceId: b.sourceId,
          coversVersion: 1,
          lastRevision: null,
        }),
      );
      expect(again.removedByKind["entity-merge"], reason).toBe(0);
      expect(again.recomputedByKind["entity-merge"], reason).toBe(0);
    }
  });

  it("keeps the groups of items the user made: they have no lineage, so no source's deletion touches them", () => {
    const mine = ["m1", "m2"].map((name) => {
      const added = userDecisions.add(db, { kind: "item", type: "Project", name });
      if (added.status !== "applied") throw new Error("add");
      return added.ref.id;
    }) as [number, number];
    merge(mine[0], mine[1]);
    const other = itemFrom("x");
    deleteSource(other.sourceId);
    expect(lines()).toHaveLength(1);
    expect(announced).toEqual([]);
  });
});

describe("resolution.scope (merge part): a group rests and wakes with the scope (S02-R13)", () => {
  it("rests every line of a three-item group when one source can no longer be put together with the rest, and wakes them all when it can", () => {
    const [open, open2, other] = [itemFrom("open"), itemFrom("open2"), itemFrom("other")] as const;
    merge(open.item, open2.item);
    merge(open2.item, other.item);
    expect(flags()).toEqual([1, 1]);
    // the third source's scope narrows: the stored scope is what the policy reads
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      other.sourceId,
    ]);
    const narrowed: SourceChange = {
      kind: "scope-changed",
      sourceId: other.sourceId,
      from: null,
      to: ["secret"],
    };
    const first = db.transaction(() => propagateCanonical(db, narrowed, AT, registryOf(apart)));
    expect(flags()).toEqual([0, 0]); // one source's scope, all lines rest
    expect(first.propagation.recomputedByKind["entity-merge"]).toBe(2);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.items).toEqual([open.item, open2.item, other.item].sort((x, y) => x - y));
    expect(announced[0]?.movedRows).toEqual([]);
    // judged again with nothing different: nothing rests, nothing is told
    announced.length = 0;
    const second = db.transaction(() => propagateCanonical(db, narrowed, AT, registryOf(apart)));
    expect(second.propagation.recomputedByKind["entity-merge"]).toBe(0);
    expect(announced).toEqual([]);
    // the scope widens again
    db.run("UPDATE sources SET access_scope = NULL WHERE id = ?", [other.sourceId]);
    const widened: SourceChange = {
      kind: "scope-changed",
      sourceId: other.sourceId,
      from: ["secret"],
      to: null,
    };
    db.transaction(() => propagateCanonical(db, widened, AT, registryOf(apart)));
    expect(flags()).toEqual([1, 1]);
    expect(announced).toHaveLength(1);
    // no row was ever moved
    expect(db.all("SELECT count(*) AS n FROM facts")[0]?.n).toBe(3);
  });

  it("hands the listeners the propagation's scope when a group rests or wakes: combinable answers what the registry's policy answers", () => {
    const [open, other] = [itemFrom("open"), itemFrom("other")] as const;
    merge(open.item, other.item);
    const answers: boolean[][] = [];
    const asking: MembershipListener = (_tx, _change, scope) =>
      answers.push([
        scope.combinable([{ sourceId: open.sourceId, version: open.version }]),
        scope.combinable([
          { sourceId: open.sourceId, version: open.version },
          { sourceId: other.sourceId, version: other.version },
        ]),
      ]);
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      other.sourceId,
    ]);
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "scope-changed", sourceId: other.sourceId, from: null, to: ["secret"] },
        AT,
        registryOf(apart, [asking]),
      ),
    );
    // one source alone is combinable; two with a secret one are not, by the policy `apart`
    expect(answers).toEqual([[true, false]]);
  });

  it.each(["source-deleted", "access-revoked", "user-deleted"] as const)(
    "wakes A and B of a resting {A, B, C} in the same propagation that deletes C's source (%s), and tells the listeners",
    (reason) => {
      const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
      merge(a.item, b.item);
      merge(b.item, c.item);
      db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
        JSON.stringify(["secret"]),
        c.sourceId,
      ]);
      db.transaction(() =>
        propagateCanonical(
          db,
          { kind: "scope-changed", sourceId: c.sourceId, from: null, to: ["secret"] },
          AT,
          registryOf(apart),
        ),
      );
      expect(flags()).toEqual([0, 0]);
      announced.length = 0;
      deleteSource(c.sourceId, apart, reason);
      // the chain was mended around C (the top): B leads... the smaller of the members, A, is the top; the survivors wake
      expect(lines().map((l) => l.active)).toEqual([1]);
      expect(record()?.recomputedByKind["entity-merge"]).toBeGreaterThanOrEqual(1);
      expect(announced).toHaveLength(1);
      expect(announced[0]?.items).toEqual([a.item, b.item].sort((x, y) => x - y));
    },
  );

  it("wakes the survivors when an old version's prune takes the resting item's only evidence", () => {
    const [a, b] = [itemFrom("a"), itemFrom("b")] as const;
    // the resting item's source has a second version that no fact cites: a prune takes the first
    const c = itemFrom("c");
    const next = saveSourceRecord(db, "c1", {
      externalId: "c",
      title: "t-c",
      body: "a newer body of c",
    });
    if (next.status !== "created") throw new Error(next.status);
    merge(a.item, b.item);
    merge(b.item, c.item);
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      c.sourceId,
    ]);
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "scope-changed", sourceId: c.sourceId, from: null, to: ["secret"] },
        AT,
        registryOf(apart),
      ),
    );
    expect(flags()).toEqual([0, 0]);
    announced.length = 0;
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "old-versions-pruned", sourceId: c.sourceId, version: next.version },
        AT,
        registryOf(apart),
      ),
    );
    expect(db.all("SELECT 1 FROM items WHERE id = ?", [c.item])).toEqual([]);
    expect(lines().map((l) => l.active)).toEqual([1]);
    expect(announced).toHaveLength(1);
  });

  it("changes nothing for a new version: no lineage moved, nothing told", () => {
    const [a, b] = [itemFrom("a"), itemFrom("b")] as const;
    merge(a.item, b.item);
    const before = lines();
    const propagation = db.transaction(
      () =>
        propagateCanonical(
          db,
          { kind: "new-version", sourceId: a.sourceId, version: 2 },
          AT,
          registryOf(apart),
        ).propagation,
    );
    expect(propagation.removedByKind["entity-merge"]).toBe(0);
    expect(propagation.recomputedByKind["entity-merge"]).toBe(0);
    expect(lines()).toEqual(before);
    expect(announced).toEqual([]);
  });

  it("rolls the whole propagation back when a listener throws inside it: nothing of the deletion stays", () => {
    const [a, b, c] = [itemFrom("a"), itemFrom("b"), itemFrom("c")] as const;
    merge(a.item, b.item);
    merge(b.item, c.item);
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [
      JSON.stringify(["secret"]),
      c.sourceId,
    ]);
    db.transaction(() =>
      propagateCanonical(
        db,
        { kind: "scope-changed", sourceId: c.sourceId, from: null, to: ["secret"] },
        AT,
        registryOf(apart),
      ),
    );
    expect(flags()).toEqual([0, 0]);
    const throwing: MembershipListener = () => {
      throw new Error("the receiver refused");
    };
    const before = {
      lines: lines(),
      items: db.all("SELECT id FROM items ORDER BY id"),
      versions: db.all("SELECT id FROM source_versions ORDER BY id"),
    };
    // deleting C's source wakes the others: the receiver throws, and that is the propagation's end
    expect(() => deleteSource(c.sourceId, apart, "source-deleted", [throwing])).toThrow(
      /receiver refused/,
    );
    expect(lines()).toEqual(before.lines);
    expect(db.all("SELECT id FROM items ORDER BY id")).toEqual(before.items);
    expect(db.all("SELECT id FROM source_versions ORDER BY id")).toEqual(before.versions);
    expect(db.all("SELECT 1 FROM tombstones")).toEqual([]);
  });
});
