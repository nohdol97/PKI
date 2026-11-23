// K02-C3b ② (R13): the derivative kind `lint-finding` (layer projection, run in the tombstone's own transaction).
// The registered-kind contract (I04 ①~⑥) runs for it on the real schema, and the deletion of a source leaves
// no finding and no lineage row that rests on it in the same transaction; a finding another source still
// supports is judged again and stays with the lineage that is left.
import {
  commitDerived,
  listFindings,
  listInvalidations,
  migrate,
  readTombstoneState,
  registerConnectorInstance,
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
import { reportMissed } from "./lint-decide.ts";
import { LINT_FINDING_KIND } from "./lint-kind.ts";
import { reflectNow, NOW } from "./lint.test-support.ts";
import { addFact, addItem, addSource, cite } from "./wiki.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** A source's deletion as the entry does it: the tombstone, then the registry's propagation. */
function deleteSource(sourceId: number) {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number | null;
    if (latest === null) return false;
    seedLegacyTombstone(db, { sourceId, version: latest, at: NOW, reason: "source-deleted" });
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

const PAST = "2026-01-15";
/**
 * Three `overdue-work` findings of Tasks whose lineage is `a` only, `a` and `b`, and nothing (the user's own
 * Task and date): real rows, so the deletion's judging again from what the canonical kinds left is under test.
 */
function world() {
  const a = addSource(db, "a", "a의 본문");
  const b = addSource(db, "b", "b의 본문");
  const lineA = [{ sourceId: a.sourceId, version: a.version }];
  const lineAB = [...lineA, { sourceId: b.sourceId, version: b.version }];
  const onlyA = addItem(db, "Task", "가");
  cite(db, { factId: addFact(db, onlyA, "target_date", PAST) }, a.id);
  const shared = addItem(db, "Task", "나");
  cite(db, { factId: addFact(db, shared, "target_date", PAST) }, b.id);
  cite(db, { factId: addFact(db, shared, "memo", "a에만 있는 값") }, a.id);
  const made = userDecisions.add(db, { kind: "item", type: "Task", name: "다" });
  if (made.status !== "applied") throw new Error("the user's item");
  const dated = userDecisions.add(db, {
    kind: "fact",
    itemId: made.ref.id,
    factKind: "target_date",
    value: PAST,
  });
  if (dated.status !== "applied") throw new Error("the user's date");
  reflectNow(db);
  const id = (item: number) => String(listFindings(db).find((f) => f.target.a === item)?.id ?? -1);
  const rows = { onlyA: id(onlyA), shared: id(shared), none: id(made.ref.id) };
  const built = new Map<string, typeof lineAB>([
    [rows.onlyA, lineA],
    [rows.shared, lineAB],
    [rows.none, []],
  ]);
  return { a, b, built, rows };
}

const ref = (id: string): DerivedRef => ({ kind: "lint-finding", id });

const subject = {
  kind: LINT_FINDING_KIND,
  has: { shared: true, withoutLineage: true },
  setup: () => {
    const w = world();
    return {
      db,
      sources: { a: w.a.sourceId, b: w.b.sourceId },
      rows: {
        onlyA: ref(w.rows.onlyA),
        shared: ref(w.rows.shared),
        withoutLineage: ref(w.rows.none),
      },
      builtFrom: (row: DerivedRef) => w.built.get(row.id) ?? [],
      exists: (row: DerivedRef) =>
        db.all("SELECT 1 FROM lint_findings WHERE id = ?", [Number(row.id)]).length === 1,
      remove: (sourceId: number) => {
        const record = deleteSource(sourceId)
          ? listInvalidations(db, 1)[0]
          : db.transaction(() => derivativeRegistry.propagate(db, deletionOf(sourceId)));
        return {
          removed: record?.removedByKind["lint-finding"] ?? -1,
          recomputed: record?.recomputedByKind["lint-finding"] ?? -1,
        };
      },
      // a result is written through commitDerived: a deleted source in its lineage discards it whole
      staleInput: () => ({
        ref: ref("9999"),
        attempt: () =>
          commitDerived(db, {
            source: null,
            items: [
              {
                kind: "lint-finding",
                itemKey: "late",
                lineage: [w.a],
                write: () => {
                  throw new Error("a finding was written past the fence");
                },
              },
            ],
          }),
      }),
      dataDirectory: null,
      canary: "qzcanary",
    };
  },
} satisfies DerivativeContractSubject<SqlDriver>;

derivativeKindContract("lint kind", subject);

describe("lint.kind: a deleted source leaves no finding or lineage row that rests on it (K02-C3b ②)", () => {
  it("deletes the finding and its lineage in the deletion's transaction; the shared one stays with b's lineage", () => {
    const w = world();
    expect(
      db.all("SELECT 1 FROM lint_finding_lineage WHERE source_id = ?", [w.a.sourceId]).length,
    ).toBeGreaterThan(0);

    deleteSource(w.a.sourceId);

    expect(
      listFindings(db)
        .map((f) => String(f.id))
        .sort(),
    ).toEqual([w.rows.shared, w.rows.none].sort());
    expect(
      db.all("SELECT 1 FROM lint_finding_lineage WHERE source_id = ?", [w.a.sourceId]),
    ).toEqual([]);
    expect(
      db.all("SELECT source_id FROM lint_finding_lineage WHERE finding_id = ?", [
        Number(w.rows.shared),
      ]),
    ).toEqual([{ source_id: w.b.sourceId }]);
  });
});

describe("lint.kind: what the user said stays while its targets do, and a finding does not outlive its targets (K02-R13)", () => {
  it("keeps a reported miss through the deletion of a source of its lineage, with the lineage that is left", () => {
    const s1 = addSource(db, "s1", "s1 본문");
    const s2 = addSource(db, "s2", "s2 본문");
    const s3 = addSource(db, "s3", "s3 본문");
    const x = addItem(db, "Project", "X");
    const y = addItem(db, "Project", "Y");
    cite(db, { factId: addFact(db, x, "memo", "x1") }, s1.id);
    cite(db, { factId: addFact(db, x, "memo", "x2") }, s2.id);
    cite(db, { factId: addFact(db, y, "memo", "y1") }, s1.id);
    cite(db, { factId: addFact(db, y, "memo", "y3") }, s3.id);
    const done = reportMissed(
      db,
      { rule: "missing-link", target: { kind: "item", a: x, b: y } },
      NOW,
    );
    expect(done.status).toBe("applied");

    deleteSource(s3.sourceId);

    expect(listFindings(db).map((f) => `${f.origin}:${f.status}`)).toEqual(["user:open"]);
    expect(
      db.all("SELECT DISTINCT source_id FROM lint_finding_lineage ORDER BY source_id"),
    ).toEqual([{ source_id: s1.sourceId }, { source_id: s2.sourceId }]);
  });

  it("deletes a missing-link finding when a source that is not one of the shared ones takes its item", () => {
    const s1 = addSource(db, "s1", "s1 본문");
    const s2 = addSource(db, "s2", "s2 본문");
    const s3 = addSource(db, "s3", "s3 본문");
    const a = addItem(db, "Project", "A");
    const m = addItem(db, "Project", "M");
    const b = addItem(db, "Project", "B");
    cite(db, { factId: addFact(db, a, "memo", "a") }, s3.id);
    cite(db, { factId: addFact(db, m, "memo", "m1") }, s1.id);
    cite(db, { factId: addFact(db, m, "memo", "m2") }, s2.id);
    cite(db, { factId: addFact(db, b, "memo", "b1") }, s1.id);
    cite(db, { factId: addFact(db, b, "memo", "b2") }, s2.id);
    db.run(
      "INSERT INTO item_merges (member_id, representative_id, active, at) VALUES (?, ?, 1, 'x')",
      [m, a],
    );
    reflectNow(db);
    const found = listFindings(db).filter((f) => f.rule === "missing-link");
    expect(found).toHaveLength(1);

    deleteSource(s3.sourceId); // takes item A, which only s3 built

    expect(listFindings(db).filter((f) => f.rule === "missing-link")).toEqual([]);
  });
});
