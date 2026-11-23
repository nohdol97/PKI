// P02-C3b ① (R13): the derivative kind `notification` (layer delivery, run in the tombstone's own transaction).
// The registered-kind contract (I04 ①~⑥) runs for it on the real schema, with a digest line as its row of no
// lineage; a deletion leaves a line whose Insight stayed but no longer holds as `withdrawn`.
import {
  commitDerived,
  insertDigestNotification,
  insertInsightNotification,
  listInvalidations,
  migrate,
  readNotification,
  readTombstoneState,
  registerConnectorInstance,
  saveInsight,
  type DerivedRef,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  derivativeKindContract,
  seedLegacyTombstone,
  type DerivativeContractSubject,
} from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivativeRegistry } from "./canonical-kinds.ts";
import { NOW } from "./notify.test-support.ts";
import { addFact, addItem, addSource, cite } from "./wiki.test-support.ts";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** A source's deletion as the entry does it; a second call propagates again over the cover the first left. */
function deleteSource(sourceId: number) {
  return db.transaction(() => {
    const latest = db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [
      sourceId,
    ])[0]?.v as number | null;
    if (latest !== null) {
      seedLegacyTombstone(db, { sourceId, version: latest, at: NOW, reason: "source-deleted" });
    }
    return derivativeRegistry.propagate(db, {
      kind: "source-deleted",
      sourceId,
      coversVersion: latest ?? (readTombstoneState(db, sourceId)?.coversVersion as number),
      lastRevision: null,
    });
  });
}

const ref = (id: number): DerivedRef => ({ kind: "notification", id: String(id) });

/** Two sources; an Insight on items only `a` supports, one on items `a` and `b` both support, a digest line. */
function world() {
  const a = addSource(db, "a", "a의 본문");
  const b = addSource(db, "b", "b의 본문");
  const pair = (name: string, ...from: { id: number }[]) => {
    const [x, y] = [addItem(db, "Task", `${name}-x`), addItem(db, "Task", `${name}-y`)] as [
      number,
      number,
    ];
    const evidence = from.flatMap((v) =>
      [x, y].map((item) => cite(db, { factId: addFact(db, item, "memo", `${name} 값`) }, v.id)),
    );
    const insightId = saveInsight(
      db,
      { rule: "dependency_delay", xItemId: x, yItemId: y },
      { state: "active", summary: "추론", evidenceIds: evidence, confidence: 100, changedAt: NOW },
    );
    return insightId;
  };
  const lineOf = (insightId: number) => {
    const id = insertInsightNotification(db, {
      insightId,
      changedAt: NOW,
      status: "sent",
      reason: null,
      at: NOW,
    });
    return id as number;
  };
  const onlyA = lineOf(pair("onlyA", a));
  const shared = lineOf(pair("shared", a, b));
  const digest = insertDigestNotification(db, {
    kind: "daily",
    windowStart: "2026-11-22T09:00:00.000Z",
    windowEnd: NOW,
    at: NOW,
  }) as number;
  return { a, b, onlyA, shared, digest };
}

const subject = {
  kind: derivativeRegistry.kinds.find((k) => k.kind === "notification") as NonNullable<
    (typeof derivativeRegistry.kinds)[number]
  >,
  has: { shared: true, withoutLineage: true },
  setup: () => {
    const w = world();
    const lineA = [{ sourceId: w.a.sourceId, version: w.a.version }];
    const lineAB = [...lineA, { sourceId: w.b.sourceId, version: w.b.version }];
    const built = new Map<number, typeof lineAB>([
      [w.onlyA, lineA],
      [w.shared, lineAB],
      [w.digest, []],
    ]);
    return {
      db,
      sources: { a: w.a.sourceId, b: w.b.sourceId },
      rows: { onlyA: ref(w.onlyA), shared: ref(w.shared), withoutLineage: ref(w.digest) },
      builtFrom: (row: DerivedRef) => built.get(Number(row.id)) ?? [],
      exists: (row: DerivedRef) => readNotification(db, Number(row.id)) !== undefined,
      remove: (sourceId: number) => {
        deleteSource(sourceId);
        const record = listInvalidations(db, 1)[0];
        return {
          removed: record?.removedByKind.notification ?? -1,
          recomputed: record?.recomputedByKind.notification ?? -1,
        };
      },
      staleInput: () => ({
        ref: ref(9999),
        attempt: () =>
          commitDerived(db, {
            source: null,
            items: [
              {
                kind: "notification",
                itemKey: "late",
                lineage: [w.a],
                write: () => {
                  throw new Error("a line was written past the fence");
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

derivativeKindContract("notification kind", subject);

describe("notify.kind: a deletion takes the line of a gone Insight and withdraws the line of one that no longer holds (P02-R13)", () => {
  it("deletes the line of the Insight a deletion took; the shared Insight's line is withdrawn, the digest line stays", () => {
    const w = world();

    deleteSource(w.a.sourceId);

    expect(readNotification(db, w.onlyA)).toBeUndefined();
    expect(readNotification(db, w.shared)?.status).toBe("withdrawn");
    expect(readNotification(db, w.digest)?.status).toBe("sent");
  });
});
