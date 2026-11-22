// I04-T01: the derivative registry (I04-R1, R2, R4, ARCHITECTURE 5.6) with double
// kinds over the real schema. `propagate.two-phase`: every kind's collection ends
// before anything is deleted, then the kinds run in layer order (a kind that points
// at another of its layer first), inside the caller's transaction. Also the
// registry's checks, its invalidation record, `visible` and `scopesOf`, and a SQL
// double run through the testkit contract suite.
import { derivativeKindContract, seedLegacyTombstone } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  atLeastAsStrict,
  createDerivativeRegistry,
  UnregisteredDerivativeError,
  type AccessScope,
  type DerivativeKind,
  type DerivedRef,
  type Layer,
  type ScopePolicy,
  type SourceChange,
  type SourceVersionRef,
} from "./derivatives.ts";
import { listInvalidations } from "./invalidations.ts";
import { migrate } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { recordTombstoneLift } from "./tombstones.ts";

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
  db.exec(`
    CREATE TABLE double_rows (kind TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL,
                              PRIMARY KEY (kind, id));
    CREATE TABLE double_lineage (kind TEXT NOT NULL, id TEXT NOT NULL,
                                 source_id INTEGER NOT NULL, version INTEGER NOT NULL);
  `);
});
afterEach(() => db.close());

function source(externalId: string, body = `body of ${externalId}`): number {
  const saved = saveSourceRecord(db, "c1", { externalId, title: `title ${externalId}`, body });
  if (saved.status !== "created") throw new Error(saved.status);
  return saved.sourceId;
}

function row(kind: string, id: string, lineage: SourceVersionRef[], text = `${kind} ${id}`) {
  db.run("INSERT INTO double_rows (kind, id, text) VALUES (?, ?, ?)", [kind, id, text]);
  for (const v of lineage) {
    db.run("INSERT INTO double_lineage (kind, id, source_id, version) VALUES (?, ?, ?, ?)", [
      kind,
      id,
      v.sourceId,
      v.version,
    ]);
  }
}

const exists = (r: DerivedRef) =>
  db.all("SELECT 1 FROM double_rows WHERE kind = ? AND id = ?", [r.kind, r.id]).length === 1;

/**
 * A kind kept in the two double tables: a change of source S touches the rows
 * whose lineage holds S; a row left with no other source is deleted, the others
 * lose S's links (recomputed).
 */
function sqlDouble(
  kind: string,
  layer: Layer,
  extra: Partial<DerivativeKind> & { log?: string[] } = {},
): DerivativeKind {
  const { log, ...rest } = extra;
  return {
    kind,
    layer,
    references: [],
    storage: layer === "projection" ? "projection" : "canonical",
    dataPaths: [],
    affected: (tx, change) => {
      log?.push(`affected:${kind}`);
      return tx
        .all(
          `SELECT DISTINCT id FROM double_lineage WHERE kind = ? AND source_id = ? ORDER BY id`,
          [kind, change.sourceId],
        )
        .map((r) => {
          const ref = { kind, id: r.id as string };
          return { ref, lineage: lineageOf(tx, ref) };
        });
    },
    lineage: (d, ref) => lineageOf(d, ref),
    invalidate: ({ tx }, snapshot, change) => {
      log?.push(`invalidate:${kind}`);
      let removed = 0;
      let recomputed = 0;
      for (const { ref, lineage } of snapshot) {
        if (!exists(ref)) continue;
        if (lineage.every((v) => v.sourceId === change.sourceId)) {
          tx.run("DELETE FROM double_lineage WHERE kind = ? AND id = ?", [ref.kind, ref.id]);
          tx.run("DELETE FROM double_rows WHERE kind = ? AND id = ?", [ref.kind, ref.id]);
          removed++;
        } else if (
          tx.run("DELETE FROM double_lineage WHERE kind = ? AND id = ? AND source_id = ?", [
            ref.kind,
            ref.id,
            change.sourceId,
          ]).changes > 0
        ) {
          recomputed++;
        }
      }
      return { removed, recomputed };
    },
    ...rest,
  };
}

function lineageOf(d: SqlDriver, ref: DerivedRef): SourceVersionRef[] {
  return d
    .all(
      "SELECT source_id, version FROM double_lineage WHERE kind = ? AND id = ? ORDER BY source_id, version",
      [ref.kind, ref.id],
    )
    .map((r) => ({ sourceId: r.source_id as number, version: r.version as number }));
}

/** A deletion as the tombstone entry will run it: tombstone, then propagate, one transaction. */
function deletion(sourceId: number): SourceChange {
  return { kind: "source-deleted", sourceId, coversVersion: 1, lastRevision: null };
}

function remove(registry: ReturnType<typeof createDerivativeRegistry>, sourceId: number) {
  return db.transaction(() => {
    seedLegacyTombstone(db, { sourceId, version: 1, at: AT, reason: "source-deleted" });
    return registry.propagate(db, deletion(sourceId));
  });
}

describe("propagate.two-phase", () => {
  /** A source-layer double that deletes the source's version rows for real. */
  const versions = (log: string[]): DerivativeKind => ({
    ...sqlDouble("versions", "source", { log }),
    affected: (tx, change) => {
      log.push("affected:versions");
      return tx
        .all("SELECT id, version FROM source_versions WHERE source_id = ?", [change.sourceId])
        .map((r) => ({
          ref: { kind: "versions", id: String(r.id) },
          lineage: [{ sourceId: change.sourceId, version: r.version as number }],
        }));
    },
    invalidate: ({ tx }, _snapshot, change) => {
      log.push("invalidate:versions");
      const { changes } = tx.run("DELETE FROM source_versions WHERE source_id = ?", [
        change.sourceId,
      ]);
      return { removed: changes, recomputed: 0 };
    },
  });

  /** Logs each DELETE statement the kinds run through the transaction it was handed. */
  function logging(log: string[]): SqlDriver {
    return {
      ...db,
      run: (sql, params) => {
        if (/^\s*DELETE/i.test(sql)) log.push("sql:DELETE");
        return db.run(sql, params);
      },
    };
  }

  function scrambled(log: string[], seen: Record<string, unknown> = {}) {
    return [
      sqlDouble("insight", "insight", { log }),
      sqlDouble("relation", "knowledge", { log }),
      sqlDouble("delivery", "delivery", { log }),
      sqlDouble("engine", "projection", { log }),
      {
        ...sqlDouble("evidence", "evidence", { log }),
        invalidate: (ctx, snapshot, change) => {
          // the lower layer has already run: the source's versions are gone
          seen.versionsLeft = ctx.tx.all("SELECT id FROM source_versions WHERE source_id = ?", [
            change.sourceId,
          ]).length;
          seen.ownSnapshot = snapshot === ctx.collected.get("evidence");
          seen.collectedKinds = [...ctx.collected.keys()].sort();
          return sqlDouble("evidence", "evidence", { log }).invalidate(ctx, snapshot, change);
        },
      } satisfies DerivativeKind,
      versions(log),
      sqlDouble("item", "item", { log }),
      // points at relation rows, so it runs before relation (registered after it)
      sqlDouble("path", "knowledge", { log, references: ["relation"] }),
    ];
  }

  it("collects every kind before anything is deleted, then runs the layers in order", () => {
    const a = source("a");
    for (const k of ["insight", "relation", "delivery", "engine", "evidence", "item", "path"]) {
      row(k, "1", [{ sourceId: a, version: 1 }]);
    }
    const log: string[] = [];
    const seen: Record<string, unknown> = {};
    const registry = createDerivativeRegistry({ kinds: scrambled(log, seen), policy: permissive });
    db.transaction(() => registry.propagate(logging(log), deletion(a)));

    const firstDelete = log.indexOf("sql:DELETE");
    const lastAffected = log.findLastIndex((e) => e.startsWith("affected:"));
    expect(log.filter((e) => e.startsWith("affected:"))).toHaveLength(8);
    expect(lastAffected).toBeLessThan(firstDelete);
    expect(lastAffected).toBeLessThan(log.findIndex((e) => e.startsWith("invalidate:")));
    expect(log.filter((e) => e.startsWith("invalidate:"))).toEqual([
      "invalidate:versions",
      "invalidate:evidence",
      "invalidate:path",
      "invalidate:relation",
      "invalidate:item",
      "invalidate:insight",
      "invalidate:delivery",
      "invalidate:engine",
    ]);
    expect(registry.kinds.map((k) => k.kind)).toEqual([
      "versions",
      "evidence",
      "path",
      "relation",
      "item",
      "insight",
      "delivery",
      "engine",
    ]);
    expect(seen).toEqual({
      versionsLeft: 0,
      ownSnapshot: true,
      collectedKinds: [
        "delivery",
        "engine",
        "evidence",
        "insight",
        "item",
        "path",
        "relation",
        "versions",
      ],
    });
  });

  it("leaves the canonical state as it was when a kind throws midway", () => {
    const a = source("a");
    row("relation", "1", [{ sourceId: a, version: 1 }]);
    const failing = { ...sqlDouble("insight", "insight") };
    failing.invalidate = () => {
      throw new Error("insight recompute failed");
    };
    const registry = createDerivativeRegistry({
      kinds: [sqlDouble("relation", "knowledge"), failing],
      policy: permissive,
    });
    const seq = readChangeSeq(db);
    expect(() => remove(registry, a)).toThrow("insight recompute failed");
    expect(exists({ kind: "relation", id: "1" })).toBe(true);
    expect(db.all("SELECT 1 FROM tombstones")).toEqual([]);
    expect(listInvalidations(db)).toEqual([]);
    expect(readChangeSeq(db)).toBe(seq);
  });
});

describe("derivative registry: the list is checked once, and fixed", () => {
  const make = (kinds: DerivativeKind[]) => () =>
    createDerivativeRegistry({ kinds, policy: permissive });

  it.each([
    ["a kind named twice", [sqlDouble("x", "item"), sqlDouble("x", "insight")], /twice/],
    ["a reference to no kind", [sqlDouble("x", "item", { references: ["y"] })], /unknown/],
    [
      "a reference across layers",
      [sqlDouble("x", "item", { references: ["y"] }), sqlDouble("y", "insight")],
      /layer/,
    ],
    ["a kind pointing at itself", [sqlDouble("x", "item", { references: ["x"] })], /cycle/],
    [
      "a cycle within a layer",
      [
        sqlDouble("x", "item", { references: ["y"] }),
        sqlDouble("y", "item", { references: ["x"] }),
      ],
      /cycle/,
    ],
    [
      "permanentlyAbsent on a canonical kind",
      [sqlDouble("x", "item", { permanentlyAbsent: true })],
      /permanentlyAbsent/,
    ],
    ["an unknown layer", [sqlDouble("x", "attic" as Layer)], /layer/],
    [
      "an unknown storage",
      [sqlDouble("x", "item", { storage: "canonnical" as DerivativeKind["storage"] })],
      /unknown storage canonnical/,
    ],
  ])("refuses %s", (_name, kinds, message) => {
    expect(make(kinds)).toThrow(message);
  });

  it("runs every projection-storage kind after all canonical kinds, whatever its layer", () => {
    const registry = make([
      sqlDouble("engine", "projection"),
      sqlDouble("graph-index", "knowledge", { storage: "projection" }),
      sqlDouble("delivery", "delivery"),
      sqlDouble("relation", "knowledge"),
    ])();
    expect(registry.kinds.map((k) => k.kind)).toEqual([
      "relation",
      "delivery",
      "graph-index",
      "engine",
    ]);
  });

  it("refuses a reference between a canonical and a projection kind", () => {
    expect(
      make([
        sqlDouble("graph-index", "knowledge", { storage: "projection", references: ["relation"] }),
        sqlDouble("relation", "knowledge"),
      ]),
    ).toThrow(/storage/);
  });

  it("cannot be changed after it is made", () => {
    const registry = make([sqlDouble("x", "item")])();
    expect(Object.isFrozen(registry.kinds)).toBe(true);
    expect(() => (registry.kinds as DerivativeKind[]).push(sqlDouble("y", "item"))).toThrow();
  });

  it("refuses a negative or fractional count from a kind", () => {
    const a = source("a");
    const bad = { ...sqlDouble("x", "item"), invalidate: () => ({ removed: -1, recomputed: 0 }) };
    const registry = make([bad])();
    expect(() => remove(registry, a)).toThrow(/count/);
  });
});

describe("invalidation record (I04-R4)", () => {
  it("is written when propagate starts, so a kind can use its id, and counted at the end", () => {
    const a = source("a");
    const b = source("b");
    row("relation", "only-a", [{ sourceId: a, version: 1 }]);
    row("relation", "shared", [
      { sourceId: a, version: 1 },
      { sourceId: b, version: 1 },
    ]);
    row("insight", "only-a", [{ sourceId: a, version: 1 }]);
    let during: unknown;
    const insight = sqlDouble("insight", "insight");
    const registry = createDerivativeRegistry({
      kinds: [
        sqlDouble("relation", "knowledge"),
        {
          ...insight,
          invalidate: (ctx, snapshot, change) => {
            during = ctx.tx.all("SELECT id FROM invalidations WHERE id = ?", [ctx.invalidationId]);
            return insight.invalidate(ctx, snapshot, change);
          },
        },
      ],
      policy: permissive,
      now: () => AT,
    });
    const result = remove(registry, a);
    const seq = readChangeSeq(db);

    expect(during).toEqual([{ id: result.invalidationId }]);
    expect(result).toEqual({
      invalidationId: result.invalidationId,
      removedByKind: { relation: 1, insight: 1 },
      recomputedByKind: { relation: 1, insight: 0 },
    });
    expect(listInvalidations(db)).toEqual([
      {
        id: result.invalidationId,
        changeSeq: seq,
        sourceId: a,
        changeKind: "source-deleted",
        removedByKind: { relation: 1, insight: 1 },
        recomputedByKind: { relation: 1, insight: 0 },
        at: AT,
      },
    ]);
  });

  it("lists the newest first, as many as asked", () => {
    const registry = createDerivativeRegistry({
      kinds: [sqlDouble("relation", "knowledge")],
      policy: permissive,
      now: () => AT,
    });
    const ids = ["a", "b", "c"].map((e) => remove(registry, source(e)).invalidationId);
    expect(listInvalidations(db, 2).map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it("takes each change kind of the contract and no other", () => {
    const a = source("a");
    const registry = createDerivativeRegistry({ kinds: [], policy: permissive, now: () => AT });
    const changes: SourceChange[] = [
      { kind: "new-version", sourceId: a, version: 1 },
      { kind: "old-versions-pruned", sourceId: a, version: 1 },
      { kind: "scope-changed", sourceId: a, from: null, to: ["team"] },
      { kind: "source-deleted", sourceId: a, coversVersion: 1, lastRevision: 3 },
      { kind: "access-revoked", sourceId: a, coversVersion: 1, lastRevision: null },
      { kind: "user-deleted", sourceId: a, coversVersion: 1, lastRevision: null },
    ];
    for (const c of changes) registry.propagate(db, c);
    expect(listInvalidations(db).map((r) => r.changeKind)).toEqual(
      changes.map((c) => c.kind).reverse(),
    );
    expect(() =>
      db.run(
        "INSERT INTO invalidations (change_seq, source_id, change_kind, at) VALUES (0, ?, 'deleted', ?)",
        [a, AT],
      ),
    ).toThrow(/CHECK/);
  });
});

describe("visible (I04-R13) and scopesOf (I04-R14)", () => {
  const relation = sqlDouble("relation", "knowledge");
  const scope = (sourceId: number, value: string | null) =>
    db.run("UPDATE sources SET access_scope = ? WHERE id = ?", [value, sourceId]);

  it("drops a ref whose lineage holds a missing or covered version, keeps the rest in order", () => {
    const a = source("a");
    const b = source("b");
    const c = source("c");
    row("relation", "of-a", [{ sourceId: a, version: 1 }]);
    row("relation", "of-b-v2", [{ sourceId: b, version: 2 }]); // never stored
    row("relation", "of-c", [{ sourceId: c, version: 1 }]);
    row("relation", "of-a-and-c", [
      { sourceId: a, version: 1 },
      { sourceId: c, version: 1 },
    ]);
    row("relation", "mine", []);
    // covered but not yet purged: the tombstone alone hides it
    seedLegacyTombstone(db, { sourceId: c, version: 1, at: AT, reason: "access-revoked" });
    const registry = createDerivativeRegistry({ kinds: [relation], policy: permissive });
    const refs = ["mine", "of-c", "of-a", "of-b-v2", "of-a-and-c"].map((id) => ({
      kind: "relation",
      id,
    }));
    expect(registry.visible(db, refs, "display").map((r) => r.id)).toEqual(["mine", "of-a"]);
    // a lift uncovers nothing (I04-R9): what was deleted does not come back
    expect(recordTombstoneLift(db, c, AT)).toBe("lifted");
    expect(registry.visible(db, refs, "display").map((r) => r.id)).toEqual(["mine", "of-a"]);
  });

  it("asks the policy with the lineage's scopes and the purpose", () => {
    const a = source("a");
    const b = source("b");
    scope(a, "team");
    row("relation", "of-a", [{ sourceId: a, version: 1 }]);
    row("relation", "of-b", [{ sourceId: b, version: 1 }]);
    const asked: [readonly AccessScope[], string][] = [];
    const registry = createDerivativeRegistry({
      kinds: [relation],
      policy: {
        ...permissive,
        allows: (scopes, purpose) => {
          asked.push([scopes, purpose]);
          return purpose !== "search" || scopes.every((s) => s === null);
        },
      },
    });
    const refs = [
      { kind: "relation", id: "of-a" },
      { kind: "relation", id: "of-b" },
    ];
    expect(registry.visible(db, refs, "search").map((r) => r.id)).toEqual(["of-b"]);
    expect(registry.visible(db, refs, "display").map((r) => r.id)).toEqual(["of-a", "of-b"]);
    expect(asked).toEqual([
      [[["team"]], "search"],
      [[null], "search"],
      [[["team"]], "display"],
      [[null], "display"],
    ]);
  });

  it("computes the scopes from the lineage, one entry per distinct scope", () => {
    const a = source("a");
    const b = source("b");
    const c = source("c");
    scope(a, "team");
    scope(b, '["b-scope","a-scope","a-scope"]');
    scope(c, "team");
    row("relation", "abc", [
      { sourceId: a, version: 1 },
      { sourceId: b, version: 1 },
      { sourceId: c, version: 1 },
    ]);
    row("relation", "mine", []);
    const registry = createDerivativeRegistry({ kinds: [relation], policy: permissive });
    expect(registry.scopesOf(db, [{ kind: "relation", id: "abc" }])).toEqual([
      ["team"],
      ["a-scope", "b-scope"],
    ]);
    expect(registry.scopesOf(db, [{ kind: "relation", id: "mine" }])).toEqual([]);
    scope(b, null);
    expect(registry.scopesOf(db, [{ kind: "relation", id: "abc" }])).toEqual([["team"], null]);
  });

  it("refuses a ref of a kind the registry does not hold", () => {
    const registry = createDerivativeRegistry({ kinds: [relation], policy: permissive });
    const stray = [{ kind: "wiki", id: "1" }];
    expect(() => registry.visible(db, stray, "display")).toThrow(UnregisteredDerivativeError);
    expect(() => registry.scopesOf(db, stray)).toThrow(UnregisteredDerivativeError);
    expect(() => registry.lineage(db, stray[0] as DerivedRef)).toThrow(UnregisteredDerivativeError);
  });
});

describe("atLeastAsStrict", () => {
  it("is true exactly when compare answers stricter or equal", () => {
    const answers = ["stricter", "equal", "looser", "incomparable"] as const;
    const results = answers.map((answer) =>
      atLeastAsStrict({ ...permissive, compare: () => answer }, ["a"], ["b"]),
    );
    expect(results).toEqual([true, true, false, false]);
  });
});

// The suite run on a SQL double through the registry's propagate: the kind's
// storage type fits the suite's shape, and propagate drives a kind as the suite expects.
const DOUBLE = sqlDouble("double", "knowledge");
derivativeKindContract("SQL double through propagate", {
  kind: DOUBLE,
  has: { shared: true, withoutLineage: true },
  setup: () => {
    const a = source("a");
    const b = source("b");
    const built: Record<string, SourceVersionRef[]> = {
      "only-a": [{ sourceId: a, version: 1 }],
      shared: [
        { sourceId: a, version: 1 },
        { sourceId: b, version: 1 },
      ],
      mine: [],
    };
    for (const [id, lineage] of Object.entries(built)) row("double", id, lineage, `text ${id}`);
    const registry = createDerivativeRegistry({ kinds: [DOUBLE], policy: permissive });
    const counts = (sourceId: number) => {
      const r = db.transaction(() => registry.propagate(db, deletion(sourceId)));
      return { removed: r.removedByKind.double ?? 0, recomputed: r.recomputedByKind.double ?? 0 };
    };
    return {
      db,
      sources: { a, b },
      rows: {
        onlyA: { kind: "double", id: "only-a" },
        shared: { kind: "double", id: "shared" },
        withoutLineage: { kind: "double", id: "mine" },
      },
      builtFrom: (r) => built[r.id] ?? [],
      exists,
      remove: (sourceId) => {
        seedLegacyTombstone(db, { sourceId, version: 1, at: AT, reason: "source-deleted" });
        return counts(sourceId);
      },
      // the double's own fence (a double kind has no write through commitDerived): a covered source is stale
      staleInput: () => ({
        ref: { kind: "double", id: "late" },
        attempt: () =>
          db.all("SELECT 1 FROM tombstones WHERE source_id = ? AND covers_version >= 1", [a])
            .length > 0
            ? { status: "stale", cause: "covered" }
            : row("double", "late", [{ sourceId: a, version: 1 }]),
      }),
      dataDirectory: null,
      canary: "text only-a",
    };
  },
});
