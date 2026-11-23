// K01-C3b ①, ③ (R8): the derivative kind `wiki-page` (layer projection, run in the tombstone's own transaction).
// The registered-kind contract (I04 ①~⑥) runs for it on the real schema, and the deletion of a source leaves
// no letter of its canary in any Wiki table in the same transaction; what is built again holds only what
// the remaining source says.
import {
  isWikiStale,
  listInvalidations,
  listStoredWikiPages,
  migrate,
  readTombstoneState,
  registerConnectorInstance,
  commitDerived,
  userDecisions,
  type DerivedRef,
  type SourceChange,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  derivativeKindContract,
  seedLegacyTombstone,
  type DerivativeContractSubject,
} from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivativeRegistry, propagateCanonical } from "./canonical-kinds.ts";
import { planWikiBuild } from "./wiki-build-job.ts";
import { WIKI_PAGE_KIND } from "./wiki-kind.ts";
import { AT, addFact, addItem, addSource, buildWiki, cite } from "./wiki.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

const CANARY = "qzcanary";

/** A source's deletion as the entry does it: the tombstone, then the registry's propagation. */
function deleteSource(sourceId: number) {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number | null;
    if (latest === null) return false;
    seedLegacyTombstone(db, { sourceId, version: latest, at: AT, reason: "source-deleted" });
    propagateCanonical(db, {
      kind: "source-deleted",
      sourceId,
      coversVersion: latest,
      lastRevision: null,
    });
    return true;
  });
}

const deletionOf = (sourceId: number): SourceChange => ({
  kind: "source-deleted",
  sourceId,
  coversVersion: readTombstoneState(db, sourceId)?.coversVersion ?? 0,
  lastRevision: null,
});

/**
 * Three built pages whose lineage is `a` only, `a` and `b`, and nothing (the user's own item): the pages
 * of real items, so the deletion's rewrite from what the canonical kinds left is the one under test.
 */
function world() {
  const a = addSource(db, "a", `a의 본문 ${CANARY}`);
  const b = addSource(db, "b", "b의 본문");
  const lineA = [{ sourceId: a.sourceId, version: a.version }];
  const lineAB = [...lineA, { sourceId: b.sourceId, version: b.version }];
  const onlyA = addItem(db, "Project", "가");
  cite(db, { factId: addFact(db, onlyA, "memo", `${CANARY} 값`) }, a.id);
  const shared = addItem(db, "Project", "나");
  cite(db, { factId: addFact(db, shared, "memo", `${CANARY} 공유 값`) }, a.id);
  cite(db, { factId: addFact(db, shared, "memo", "남는 값") }, b.id);
  const made = userDecisions.add(db, { kind: "item", type: "Project", name: "다" });
  if (made.status !== "applied") throw new Error("the user's item");
  buildWiki(db);
  const keys = {
    onlyA: `projects/${onlyA}`,
    shared: `projects/${shared}`,
    none: `projects/${made.ref.id}`,
  };
  const built = new Map<string, typeof lineAB>([
    [keys.onlyA, lineA],
    [keys.shared, lineAB],
    [keys.none, []],
  ]);
  return { a, b, built, keys };
}

const ref = (key: string): DerivedRef => ({ kind: "wiki-page", id: key });

const subject = {
  kind: WIKI_PAGE_KIND,
  has: { shared: true, withoutLineage: true },
  setup: () => {
    const w = world();
    return {
      db,
      sources: { a: w.a.sourceId, b: w.b.sourceId },
      rows: {
        onlyA: ref(w.keys.onlyA),
        shared: ref(w.keys.shared),
        withoutLineage: ref(w.keys.none),
      },
      builtFrom: (row: DerivedRef) => w.built.get(row.id) ?? [],
      exists: (row: DerivedRef) =>
        db.all("SELECT 1 FROM wiki_pages WHERE key = ?", [row.id]).length === 1,
      remove: (sourceId: number) => {
        const record = deleteSource(sourceId)
          ? listInvalidations(db, 1)[0]
          : db.transaction(() => derivativeRegistry.propagate(db, deletionOf(sourceId)));
        return {
          removed: record?.removedByKind["wiki-page"] ?? -1,
          recomputed: record?.recomputedByKind["wiki-page"] ?? -1,
        };
      },
      // a result is written through commitDerived: a deleted source in its lineage discards it whole
      staleInput: () => ({
        ref: ref("projects/9"),
        attempt: () =>
          commitDerived(db, {
            source: null,
            items: [
              {
                kind: "wiki-page",
                itemKey: "late",
                lineage: [w.a],
                write: () => {
                  throw new Error("a page was written past the fence");
                },
              },
            ],
          }),
      }),
      dataDirectory: null,
      canary: CANARY,
    };
  },
} satisfies DerivativeContractSubject<SqlDriver>;

derivativeKindContract("wiki kind", subject);

describe("wiki.kind: a deleted source leaves nothing of its text in the Wiki", () => {
  it("empties every Wiki table of the canary in the deletion's own transaction, and the next build holds the other source only", () => {
    const a = addSource(db, "a", `a의 본문 ${CANARY}`);
    const b = addSource(db, "b", "b의 본문");
    const project = addItem(db, "Project", "미리내");
    cite(db, { factId: addFact(db, project, "memo", `${CANARY} 값`) }, a.id);
    cite(db, { factId: addFact(db, project, "memo", "남는 값") }, b.id);
    const onlyA = addItem(db, "System", "물결");
    cite(db, { factId: addFact(db, onlyA, "memo", `${CANARY} 다른 값`) }, a.id);
    buildWiki(db);
    expect(listStoredWikiPages(db)).toHaveLength(2);

    deleteSource(a.sourceId);
    const wikiText = () =>
      db
        .all(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wiki\\_%' ESCAPE '\\'",
        )
        .map((t) => JSON.stringify(db.all(`SELECT * FROM ${String(t.name)}`)))
        .join("\n");
    expect(wikiText()).not.toContain(CANARY);
    // the page both sources fed is rewritten from what is left; the page of the item that went is gone
    const pages = listStoredWikiPages(db);
    expect(pages.map((p) => p.key)).toEqual([`projects/${project}`]);
    const body = JSON.parse(pages[0]?.body ?? "{}") as { claims: { value: string }[] };
    expect(body.claims.map((c) => c.value)).toEqual(["남는 값"]);
    expect(isWikiStale(db)).toBe(true); // the deletion changed the input; the next build only catches up
    buildWiki(db);
    expect(listStoredWikiPages(db)).toEqual(pages);
    expect(wikiText()).not.toContain(CANARY);
  });
});

describe("wiki.kind: the page of an item the user wrote carries the sources of the facts attached to it", () => {
  const wikiText = () =>
    db
      .all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wiki\\_%' ESCAPE '\\'",
      )
      .map((t) => JSON.stringify(db.all(`SELECT * FROM ${String(t.name)}`)))
      .join("\n");
  function authoredWithExtractedFact() {
    const b = addSource(db, "b", `b의 본문 ${CANARY}`);
    const made = userDecisions.add(db, { kind: "item", type: "Project", name: "직접 쓴 항목" });
    if (made.status !== "applied") throw new Error("the user's item");
    cite(db, { factId: addFact(db, made.ref.id, "memo", `${CANARY} 값`) }, b.id);
    return { b, key: `projects/${made.ref.id}` };
  }

  it("empties every Wiki table of the canary in the deletion's transaction", () => {
    const { b } = authoredWithExtractedFact();
    buildWiki(db);
    expect(wikiText()).toContain(CANARY);
    deleteSource(b.sourceId);
    expect(wikiText()).not.toContain(CANARY);
  });

  it("discards a build planned before the deletion that commits after it", () => {
    const { b } = authoredWithExtractedFact();
    const plan = planWikiBuild(db, { at: AT });
    deleteSource(b.sourceId);
    const committed = db.transaction(() => commitDerived(db, { source: null, items: plan.items }));
    expect(committed.status).toBe("stale");
    expect(wikiText()).not.toContain(CANARY);
  });
});
