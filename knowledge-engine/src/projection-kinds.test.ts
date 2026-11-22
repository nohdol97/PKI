// I04-T04, R1 and R12 (C1 `derivatives.contract` for the projection kinds, C2 `purge.idempotent`'s
// projection half): the engine and the vector index are registered kinds of the product registry.
// A deletion registers one `projection-remove` job per kind in the tombstone's transaction, after the
// tombstone raised the change sequence, covering the tombstone's version and no fence of the source's
// own versions. The jobs' execution is backend's (projection-remove.test.ts); here the registered
// kinds, what a change registers and the closed list of not-applicable cases.
import {
  createDerivativeRegistry,
  canonicalTransaction,
  listInvalidations,
  migrate,
  readChangeSeq,
  registerConnectorInstance,
  saveSourceRecord,
  type DerivativeKind,
  type ScopePolicy,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProductRegistry,
  derivativeRegistry,
  propagateCanonical,
} from "./canonical-kinds.ts";
import { createCanonicalEntries } from "./entries.ts";
import { ENGINE_KIND, VECTOR_KIND, projectionKinds } from "./projection-kinds.ts";
import { applyTombstone } from "./tombstone-entry.ts";

const AT = "2026-11-22T00:00:00.000Z";
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

const store = (externalId: string, body: string) => {
  const saved = saveSourceRecord(db, "c1", { externalId, title: externalId, body });
  if (saved.status !== "created") throw new Error(saved.status);
  return saved;
};
const identity = (externalId: string) => ({
  connectorInstanceId: "c1",
  namespace: "",
  externalId,
});
const del = (externalId: string, at = AT) =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, {
      identity: identity(externalId),
      reason: "user-deleted",
      lastRevision: null,
      at,
    }),
  );
const removals = () =>
  db.all(
    `SELECT target, source_id, fence_version, status, priority, registered_change_seq
       FROM jobs WHERE kind = 'projection-remove' ORDER BY target`,
  );

describe("the registered projection kinds (I04-R1)", () => {
  it("registers the engine and the vector index in the projection stage, after every canonical kind", () => {
    expect(derivativeRegistry.kinds.map((k) => [k.kind, k.layer, k.storage])).toEqual([
      ["source", "source", "canonical"],
      ["evidence", "evidence", "canonical"],
      ["fact", "knowledge", "canonical"],
      ["relation", "knowledge", "canonical"],
      ["scope-drop", "knowledge", "canonical"],
      ["item", "item", "canonical"],
      ["insight", "insight", "canonical"],
      [ENGINE_KIND, "projection", "projection"],
      [VECTOR_KIND, "projection", "projection"],
    ]);
  });

  it("keeps no data path and no references: a projection's files are its implementation's own", () => {
    const kinds = derivativeRegistry.kinds.filter((k) => k.storage === "projection");
    for (const k of kinds) {
      expect(k.dataPaths, k.kind).toEqual([]);
      expect(k.references, k.kind).toEqual([]);
    }
  });

  it("carries permanentlyAbsent only where the implementation bound is one that never holds anything", () => {
    const marks = (absent: Parameters<typeof createProductRegistry>[0]["permanentlyAbsent"]) =>
      Object.fromEntries(
        createProductRegistry({
          policy: permissive,
          ...(absent ? { permanentlyAbsent: absent } : {}),
        })
          .kinds.filter((k) => k.storage === "projection")
          .map((k) => [k.kind, k.permanentlyAbsent === true]),
      );
    expect(marks(undefined)).toEqual({ [ENGINE_KIND]: false, [VECTOR_KIND]: false });
    expect(marks({ [VECTOR_KIND]: true })).toEqual({ [ENGINE_KIND]: false, [VECTOR_KIND]: true });
    expect(marks({ [ENGINE_KIND]: true, [VECTOR_KIND]: true })).toEqual({
      [ENGINE_KIND]: true,
      [VECTOR_KIND]: true,
    });
  });

  it("names a row by source and version, and its lineage is that one version, stored or not", () => {
    const [engine] = projectionKinds({ at: () => AT });
    expect(engine?.lineage(db, { kind: ENGINE_KIND, id: "7:3" })).toEqual([
      { sourceId: 7, version: 3 },
    ]);
    expect(() => engine?.lineage(db, { kind: ENGINE_KIND, id: "7" })).toThrow(/7/);
  });
});

describe("a deletion registers the projection removals (I04-R12)", () => {
  it("one job per kind, covering the tombstone's version, after the tombstone raised the sequence", () => {
    const a = store("a", "첫째");
    store("a", "둘째");
    const before = readChangeSeq(db);
    const result = del("a");
    expect(result.outcome).toBe("created");
    const seq = readChangeSeq(db);
    expect(seq).toBeGreaterThan(before);
    expect(removals()).toEqual([
      {
        target: ENGINE_KIND,
        source_id: a.sourceId,
        fence_version: 2,
        status: "queued",
        priority: "user",
        registered_change_seq: seq,
      },
      {
        target: VECTOR_KIND,
        source_id: a.sourceId,
        fence_version: 2,
        status: "queued",
        priority: "user",
        registered_change_seq: seq,
      },
    ]);
  });

  it("counts them as the kinds' removals in the invalidation record", () => {
    store("a", "본문");
    del("a");
    expect(listInvalidations(db)[0]?.removedByKind).toMatchObject({
      [ENGINE_KIND]: 1,
      [VECTOR_KIND]: 1,
    });
  });

  it("registers none when nothing was stored (a deletion of a source never seen wakes nobody)", () => {
    del("never-seen");
    expect(removals()).toEqual([]);
  });

  it("registers none for a new version or a scope change: those reach the projections as notices", () => {
    const a = store("a", "본문");
    propagateCanonical(db, { kind: "new-version", sourceId: a.sourceId, version: 1 }, AT);
    propagateCanonical(
      db,
      { kind: "scope-changed", sourceId: a.sourceId, from: ["x"], to: ["y"] },
      AT,
    );
    expect(removals()).toEqual([]);
  });

  it("is the same event twice: the second changes nothing, no second job", () => {
    store("a", "본문");
    del("a");
    const jobs = removals();
    const seq = readChangeSeq(db);
    expect(del("a").outcome).toBe("unchanged");
    expect(removals()).toEqual(jobs);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("is atomic with the purge: a failure after the jobs were registered leaves no job and no tombstone", () => {
    store("a", "본문");
    expect(() =>
      canonicalTransaction(db, (tx) => {
        applyTombstone(tx, {
          identity: identity("a"),
          reason: "user-deleted",
          lastRevision: null,
          at: AT,
        });
        expect(removals()).toHaveLength(2);
        throw new Error("the transaction fails after the entry");
      }),
    ).toThrow(/fails after/);
    expect(removals()).toEqual([]);
    expect(db.all("SELECT 1 FROM source_versions")).toHaveLength(1);
  });

  it("registers the job even when the removal is dated by the entry: one clock for the request", () => {
    store("a", "본문");
    del("a", "2026-12-01T09:00:00.000Z");
    const created = db.all("SELECT created_at FROM jobs WHERE kind = 'projection-remove'");
    expect(created.map((r) => r.created_at)).toEqual([
      Date.parse("2026-12-01T09:00:00.000Z"),
      Date.parse("2026-12-01T09:00:00.000Z"),
    ]);
  });
});

describe("what each projection kind collects (phase 1)", () => {
  it("every stored version of the source on a deletion, each its own row with that version as its lineage", () => {
    const a = store("a", "첫째");
    store("a", "둘째");
    store("b", "다른 원본");
    const [engine, vector] = projectionKinds({ at: () => AT });
    const change = {
      kind: "user-deleted" as const,
      sourceId: a.sourceId,
      coversVersion: 2,
      lastRevision: null,
    };
    for (const [kind, name] of [
      [engine, ENGINE_KIND],
      [vector, VECTOR_KIND],
    ] as const) {
      expect(kind?.affected(db, change)).toEqual([
        {
          ref: { kind: name, id: `${a.sourceId}:1` },
          lineage: [{ sourceId: a.sourceId, version: 1 }],
        },
        {
          ref: { kind: name, id: `${a.sourceId}:2` },
          lineage: [{ sourceId: a.sourceId, version: 2 }],
        },
      ]);
    }
  });

  it("nothing on a new version or a scope change: those reach the projections as notices", () => {
    const a = store("a", "본문");
    for (const kind of projectionKinds({ at: () => AT })) {
      expect(kind.affected(db, { kind: "new-version", sourceId: a.sourceId, version: 1 })).toEqual(
        [],
      );
      expect(
        kind.affected(db, { kind: "scope-changed", sourceId: a.sourceId, from: null, to: ["x"] }),
      ).toEqual([]);
    }
  });
});

describe("the entries run the registry they were made over (composition root, I04-T04)", () => {
  /** A registry of the product's kinds and one more, which notes every change it is asked about. */
  function spied() {
    const seen: string[] = [];
    const extra: DerivativeKind = {
      kind: "spy",
      layer: "delivery",
      references: [],
      storage: "canonical",
      dataPaths: [],
      lineage: () => [],
      affected: (_tx, change) => {
        seen.push(change.kind);
        return [];
      },
      invalidate: () => ({ removed: 0, recomputed: 0 }),
    };
    const registry = createDerivativeRegistry({
      kinds: [...derivativeRegistry.kinds, extra],
      policy: permissive,
    });
    return { seen, entries: createCanonicalEntries(registry) };
  }

  it("applyTombstone and the user's deletion", () => {
    const { seen, entries } = spied();
    store("a", "본문");
    store("b", "본문");
    canonicalTransaction(db, (tx) =>
      entries.applyTombstone(tx, {
        identity: identity("a"),
        reason: "source-deleted",
        lastRevision: 1,
        at: AT,
      }),
    );
    entries.userDelete(db, identity("b"), AT);
    expect(seen).toEqual(["source-deleted", "user-deleted"]);
  });

  it("a Connector's deletion and scope change (acceptChange) and a new version (propagateNewVersion)", () => {
    const { seen, entries } = spied();
    const a = store("a", "본문");
    store("a", "둘째");
    entries.propagateNewVersion(db, a.sourceId);
    // an upsert that changes the scope takes the other road to the same propagation
    canonicalTransaction(db, (tx) =>
      entries.acceptChange(
        tx,
        "c1",
        {
          kind: "upsert",
          record: {
            namespace: "",
            externalId: "a",
            revision: 3,
            schemaVersion: 2,
            title: "a",
            body: "둘째",
            accessScope: ["other-team"],
          },
        },
        AT,
      ),
    );
    canonicalTransaction(db, (tx) => {
      entries.acceptChange(
        tx,
        "c1",
        {
          kind: "scope-change",
          namespace: "",
          externalId: "a",
          revision: 5,
          at: AT,
          accessScope: ["team"],
        },
        AT,
      );
      entries.acceptChange(
        tx,
        "c1",
        { kind: "delete", namespace: "", externalId: "a", revision: 6, at: AT },
        AT,
      );
    });
    expect(seen).toEqual(["new-version", "scope-changed", "scope-changed", "source-deleted"]);
  });
});
