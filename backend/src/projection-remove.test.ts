// I04-T04 (C1 `derivatives.contract` for the projection kinds, C2 `projection-remove`): the engine and
// the vector index as registered kinds, their removal after a deletion as `projection-remove` jobs,
// executed by the product's ports (projection-ports.ts) on the doubles of testkit (the memory engine
// and the memory vector index, whose fences are the contracts'). The classifier, the marks and the
// forced rebuild are I03-T10's (projection-jobs.test.ts); what is proved here is what a removal
// removes: the versions up to the tombstone's cover, never a newer version's item, from both
// projections, and how each of the seven cases of the plan comes out on the product's wiring.
// The clock is injected; nothing sleeps.
import {
  AdapterUnavailableError,
  routes,
  type KnowledgeEngine,
  type VectorIndex,
} from "@pki/contracts";
import {
  createCanonicalEntries,
  createProductRegistry,
  createProjections,
  PROJECTION_STALE_SETTINGS,
  vectorRefOf,
  versionNotice,
  type Projections,
} from "@pki/knowledge-engine";
import {
  canonicalTransaction,
  findSourceId,
  listInvalidations,
  readJob,
  readSetting,
  registerConnectorInstance,
  saveSourceRecord,
  type DerivativeKind,
  type DerivedRef,
  type DerivativeRegistry,
  type ScopePolicy,
  type SqlDriver,
  type StoredJob,
} from "@pki/storage";
import {
  derivativeKindContract,
  MemoryKnowledgeEngine,
  activateEmpty,
  MemoryVectorIndex,
  send,
  type DerivativeContractSubject,
} from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import type { Clock } from "./clock.ts";
import { openCanonicalDb } from "./composition.ts";
import { createJobRunner, type JobRunner } from "./job-runner.ts";
import {
  checkProjectionMarkers,
  projectionHandlers,
  PROJECTION_KIND_SETTINGS,
  requestProjectionRebuild,
  type ProjectionPorts,
} from "./projection-jobs.ts";
import { projectionPorts } from "./projection-ports.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-22T00:00:00.000Z");
const SPACE = { modelId: "m", revision: "1", dimension: 2 };
const permissive: ScopePolicy = {
  compare: () => "equal",
  strictest: (scopes) => scopes[0] ?? null,
  combinable: () => true,
  allows: () => true,
};

let dir: string;
let db: SqlDriver;
let wall = T0;
const clock: Clock = { now: () => wall, sleep: async () => {}, monotonic: () => 0 };
let engine: MemoryKnowledgeEngine;
let vector: MemoryVectorIndex;
let projections: Projections;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pki-projection-remove-"));
  db = openCanonicalDb(dir);
  wall = T0;
  registerConnectorInstance(db, "c", "test-fixtures");
  engine = new MemoryKnowledgeEngine();
  vector = new MemoryVectorIndex();
  await activateEmpty(vector, SPACE);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The product's wiring over the given adapters (a test may pass wrapped ones). */
function wiring(
  adapters: { engine?: KnowledgeEngine; vectorIndex?: VectorIndex } = {},
  absent: { engine?: true; vectorIndex?: true } = {},
) {
  const e = adapters.engine ?? engine;
  const v = adapters.vectorIndex ?? vector;
  projections = createProjections({ db, engine: e, vectorIndex: v, embeddingSpace: () => SPACE });
  const registry = createProductRegistry({ policy: permissive, permanentlyAbsent: absent });
  const ports: ProjectionPorts = projectionPorts({
    registry,
    db,
    engine: e,
    vectorIndex: v,
    projections,
  });
  const runner = createJobRunner({
    db,
    handlers: projectionHandlers({ db, ports, now: () => new Date(wall) }),
    kinds: PROJECTION_KIND_SETTINGS,
    clock,
  });
  return { registry, entries: createCanonicalEntries(registry), ports, runner };
}

/** Runs every job that is due now, one after another. */
async function drain(runner: JobRunner): Promise<void> {
  for (let guard = 0; guard < 50; guard++) if (!(await runner.runOnce())) return;
  throw new Error("the runner did not go idle");
}

const seq = () => db.all("SELECT change_seq FROM revisions")[0]?.change_seq as number;

/** Stores a version and hands it to both projections, as a notice would. */
async function ingest(externalId: string, body: string) {
  const saved = saveSourceRecord(db, "c", { externalId, title: externalId, body });
  if (saved.status !== "created") throw new Error(saved.status);
  const ref = { sourceId: String(saved.sourceId), version: saved.version };
  await engine.upsertSource({ ref, title: externalId, body }, { version: saved.version }, seq());
  await vector.upsert(
    [{ ref: vectorRefOf(saved.sourceId, saved.version), vector: Float32Array.of(1, 0) }],
    seq(),
  );
  return saved;
}

const identity = (externalId: string) => ({
  connectorInstanceId: "c",
  namespace: "",
  externalId,
});
const del = (entries: ReturnType<typeof wiring>["entries"], externalId: string) =>
  canonicalTransaction(db, (tx) =>
    entries.applyTombstone(tx, {
      identity: identity(externalId),
      reason: "user-deleted",
      lastRevision: null,
      at: new Date(wall).toISOString(),
    }),
  );
const job = (id: number) => readJob(db, id) as StoredJob;
const removal = (target: string, sourceId?: number) =>
  db.all(
    `SELECT id FROM jobs WHERE kind = 'projection-remove' AND target = ?
      ${sourceId === undefined ? "" : `AND source_id = ${sourceId}`} ORDER BY id DESC`,
    [target],
  )[0]?.id as number;
const heldByEngine = async (word: string) =>
  (await engine.relatedContext({ text: word, limit: 20 })).map((h) => h.ref);
/** `target` with some methods replaced (the rest are the target's own, bound: the doubles keep private state). */
function overriding<T extends object>(target: T, overrides: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(target, {
    get: (t, key) => {
      if (key in overrides) return overrides[key as keyof T];
      const value = Reflect.get(t, key, t) as unknown;
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}
const heldByVector = async () => (await vector.search(Float32Array.of(1, 0), 50)).map((h) => h.ref);

/** What each projection kind's contract subject declares (subjectOf below builds them from this). */
const subjectHas = () => ({ shared: false, withoutLineage: false });

describe("derivatives.contract: the projection kinds, on the product's wiring", () => {
  const subjectOf = (name: "engine" | "vectorIndex") => {
    let current: ReturnType<typeof wiring> | undefined;
    return {
      kind: createProductRegistry({ policy: permissive }).kinds.find(
        (k) => k.kind === name,
      ) as DerivativeKind,
      // an engine row is one source version's and a vector one: neither can be shared or lack a lineage
      has: subjectHas(),
      setup: async () => {
        // the contract builds each fixture on a fresh database of its own
        const own = mkdtempSync(join(tmpdir(), "pki-projection-contract-"));
        const previous = db;
        db = openCanonicalDb(own);
        registerConnectorInstance(db, "c", "test-fixtures");
        engine = new MemoryKnowledgeEngine();
        vector = new MemoryVectorIndex();
        await activateEmpty(vector, SPACE);
        current = wiring();
        const a = await ingest("a", "alpha qzcanary");
        const b = await ingest("b", "bravo");
        const run = current;
        const rowOf = (sourceId: number): DerivedRef => ({ kind: name, id: `${sourceId}:1` });
        return {
          db,
          sources: { a: a.sourceId, b: b.sourceId },
          rows: { onlyA: rowOf(a.sourceId), shared: null, withoutLineage: null },
          builtFrom: (ref: DerivedRef) => {
            const [sourceId, version] = ref.id.split(":").map(Number);
            return [{ sourceId: sourceId as number, version: version as number }];
          },
          exists: async (ref: DerivedRef) => {
            const sourceId = ref.id.split(":")[0] as string;
            return name === "engine"
              ? (await heldByEngine("alpha")).some((r) => r.sourceId === sourceId) ||
                  (await heldByEngine("bravo")).some((r) => r.sourceId === sourceId)
              : (await heldByVector()).includes(vectorRefOf(Number(sourceId), 1));
          },
          // the real deletion path: the tombstone entry, then the removal job it registered, run
          remove: async (sourceId: number) => {
            const externalId = sourceId === a.sourceId ? "a" : "b";
            const deletion = del(run.entries, externalId);
            const counts = (
              record:
                | {
                    removedByKind: Record<string, number>;
                    recomputedByKind: Record<string, number>;
                  }
                | undefined,
            ) => ({
              removed: record?.removedByKind[name] ?? -1,
              recomputed: record?.recomputedByKind[name] ?? -1,
            });
            const result =
              deletion.outcome === "unchanged"
                ? counts(undefined) // a same event applied again changes nothing and records nothing
                : counts(listInvalidations(db, 1)[0]);
            // the same change reaching the registry again (nothing is stored of the source now)
            const again =
              deletion.outcome === "unchanged"
                ? counts(
                    db.transaction(() =>
                      run.registry.propagate(db, {
                        kind: "user-deleted",
                        sourceId,
                        coversVersion: deletion.coversVersion,
                        lastRevision: null,
                      }),
                    ),
                  )
                : result;
            await drain(run.runner);
            return again;
          },
          staleInput: () => {
            const ref = rowOf(a.sourceId);
            return {
              ref,
              attempt: () =>
                name === "engine"
                  ? engine.upsertSource(
                      {
                        ref: { sourceId: String(a.sourceId), version: 1 },
                        title: "a",
                        body: "alpha qzcanary",
                      },
                      { version: 1 },
                      1,
                    )
                  : vector.upsert(
                      [{ ref: vectorRefOf(a.sourceId, 1), vector: Float32Array.of(1, 0) }],
                      1,
                    ),
            };
          },
          dataDirectory: null,
          canary: "qzcanary",
          close: () => {
            db.close();
            rmSync(own, { recursive: true, force: true });
            db = previous;
          },
        };
      },
    } satisfies DerivativeContractSubject<SqlDriver>;
  };
  derivativeKindContract("engine projection", subjectOf("engine"));
  derivativeKindContract("vector projection", subjectOf("vectorIndex"));
});

describe("projection-remove", () => {
  it("① a removal that fails first is retried and the item goes in the end", async () => {
    await ingest("a", "alpha qzcanary");
    let failures = 1;
    const flaky = overriding<KnowledgeEngine>(engine, {
      removeSource: async (...args: Parameters<KnowledgeEngine["removeSource"]>) => {
        if (failures-- > 0) throw new Error("engine down");
        return engine.removeSource(...args);
      },
    });
    const { entries, runner } = wiring({ engine: flaky });
    del(entries, "a");
    await drain(runner);
    expect(job(removal("engine")).status).toBe("retry");
    expect(await heldByEngine("alpha")).toHaveLength(1); // still there
    wall += HOUR;
    await drain(runner);
    expect(job(removal("engine")).status).toBe("succeeded");
    expect(await heldByEngine("alpha")).toEqual([]);
  });

  it("② runs twice with the same engine state: the second run changes nothing", async () => {
    await ingest("a", "alpha qzcanary");
    await ingest("b", "bravo");
    const { entries, runner, ports } = wiring();
    del(entries, "a");
    await drain(runner);
    const after = [await heldByEngine("alpha"), await heldByEngine("bravo"), await heldByVector()];
    const id = removal("engine");
    const again = projectionHandlers({ db, ports });
    const result = await (again["projection-remove"] as NonNullable<(typeof again)[string]>)(
      job(id),
      { signal: new AbortController().signal } as never,
    );
    expect(result.status).toBe("succeeded");
    expect([
      await heldByEngine("alpha"),
      await heldByEngine("bravo"),
      await heldByVector(),
    ]).toEqual(after);
    expect(after[1]).toHaveLength(1); // b is still held
  });

  it("③ the item of a newer version, taken after a lift, is not removed", async () => {
    const v1 = await ingest("a", "alpha one");
    const { entries, runner } = wiring();
    del(entries, "a");
    // the user lifts, the source returns as v2 and both projections take it before the removal runs
    canonicalTransaction(db, (tx) =>
      entries.liftTombstone(tx, v1.sourceId, new Date(wall).toISOString()),
    );
    const v2 = await ingest("a", "alpha two");
    expect(v2.version).toBe(2);
    await drain(runner);
    expect(job(removal("engine")).status).toBe("succeeded");
    expect((await heldByEngine("alpha")).map((r) => r.version)).toEqual([2]);
    expect(await heldByVector()).toEqual([vectorRefOf(v1.sourceId, 2)]);
  });

  it("④ an empty vector index ends as a skip; the same error from a kind without the mark is retried and marks", async () => {
    await ingest("a", "alpha");
    const empty = overriding<VectorIndex>(vector, {
      remove: async () => {
        throw new AdapterUnavailableError("no vector module");
      },
    });
    const absent = wiring({ vectorIndex: empty }, { vectorIndex: true });
    del(absent.entries, "a");
    await drain(absent.runner);
    expect(job(removal("vectorIndex"))).toMatchObject({
      status: "succeeded",
      reason: "adapter-unavailable",
    });
    expect(checkProjectionMarkers(db, { phase: "start", now: wall }).map((j) => j.target)).toEqual(
      [],
    );

    // a stopped sidecar: the same error, the kind without the mark
    await ingest("b", "bravo");
    const sidecar = wiring({ vectorIndex: empty });
    del(sidecar.entries, "b");
    await drain(sidecar.runner);
    expect(job(removal("vectorIndex"))).toMatchObject({
      status: "retry",
      reason: "projection-unavailable",
    });
    expect(checkProjectionMarkers(db, { phase: "start", now: wall }).map((j) => j.target)).toEqual([
      "vectorIndex",
    ]);
  });

  it("⑤ a stale fence is sent again with the source's latest version: v1 to v3 gone, v4 kept", async () => {
    const v1 = await ingest("a", "alpha one");
    await ingest("a", "alpha two");
    await ingest("a", "alpha three");
    let failing = true;
    const calls: { version: number; fence: number }[] = [];
    const flaky = overriding<KnowledgeEngine>(engine, {
      removeSource: async (...args: Parameters<KnowledgeEngine["removeSource"]>) => {
        calls.push({ version: args[0].version, fence: args[1].version });
        if (failing) throw new Error("engine down");
        return engine.removeSource(...args);
      },
    });
    const { entries, runner } = wiring({ engine: flaky });
    del(entries, "a");
    await drain(runner);
    expect(job(removal("engine")).status).toBe("retry");
    canonicalTransaction(db, (tx) =>
      entries.liftTombstone(tx, v1.sourceId, new Date(wall).toISOString()),
    );
    const v4 = await ingest("a", "alpha four");
    expect(v4.version).toBe(4);
    failing = false;
    wall += HOUR;
    await drain(runner);
    expect(calls.slice(1)).toEqual([
      { version: 3, fence: 3 }, // the stale fence: the engine took v4 meanwhile
      { version: 3, fence: 4 }, // sent again with the source's latest version, still covering v3
    ]);
    expect(job(removal("engine")).status).toBe("succeeded");
    expect((await heldByEngine("alpha")).map((r) => r.version)).toEqual([4]);
  });

  it("⑥ a given-up removal forces the rebuild at start and at a check, and the engine's result hides the source until then", async () => {
    const a = await ingest("a", "alpha qzcanary");
    await ingest("b", "bravo");
    const down = overriding<KnowledgeEngine>(engine, {
      removeSource: async () => {
        throw new Error("engine down");
      },
    });
    const { entries, runner } = wiring({ engine: down });
    del(entries, "a");
    for (let i = 0; i < 6; i++) {
      wall += HOUR;
      await drain(runner);
    }
    expect(job(removal("engine")).status).toBe("dead_letter");
    // the engine still holds the canary; the sequence the engine applied equals the store's
    expect(await heldByEngine("qzcanary")).toHaveLength(1);
    // at a check: a rebuild is registered whatever the sequences say, and runs on the engine
    const requested = checkProjectionMarkers(db, { phase: "check", now: wall });
    expect(requested.map((j) => [j.kind, j.target])).toEqual([["projection-rebuild", "engine"]]);
    const { runner: working } = wiring();
    await drain(working);
    expect(await heldByEngine("qzcanary")).toEqual([]);
    expect(await heldByEngine("bravo")).toHaveLength(1);
    expect(job(removal("engine", a.sourceId)).status).toBe("superseded");
  });

  it("⑦ a rebuild twice leaves the same state, and clears the stale mark a failed notice left", async () => {
    await ingest("a", "alpha");
    let failing = true;
    const flaky = overriding<KnowledgeEngine>(engine, {
      upsertSource: async (...args: Parameters<KnowledgeEngine["upsertSource"]>) => {
        if (failing) throw new Error("engine down");
        return engine.upsertSource(...args);
      },
    });
    const { runner } = wiring({ engine: flaky });
    // a notice the engine fails to take marks it stale, in the process and in the setting
    const missed = saveSourceRecord(db, "c", { externalId: "b", title: "b", body: "bravo" });
    if (missed.status !== "created") throw new Error(missed.status);
    await projections.notify([versionNotice(db, missed.sourceId, missed.version)]);
    expect(projections.isStale("engine")).toBe(true);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");

    failing = false;
    requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    await drain(runner);
    const once = await heldByEngine("bravo");
    expect(once).toHaveLength(1); // the rebuild read the store, the missed source included
    expect(projections.isStale("engine")).toBe(false);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("0");
    requestProjectionRebuild(db, "engine", { at: new Date(wall) });
    await drain(runner);
    expect(await heldByEngine("bravo")).toEqual(once);
    expect(await engine.appliedChangeSeq()).toBe(seq());

    requestProjectionRebuild(db, "vectorIndex", { at: new Date(wall) });
    await drain(runner);
    expect(await vector.appliedChangeSeq()).toBe(seq());
  });
});

describe("the vector index's removal (I04-R12)", () => {
  it("covers every version up to the tombstone's cover by the version, which the purge no longer holds", async () => {
    const v1 = await ingest("a", "one");
    await ingest("a", "two");
    await ingest("b", "other");
    const { entries, runner } = wiring();
    del(entries, "a");
    await drain(runner);
    const b = findSourceId(db, "c", "", "b") as number;
    expect(await heldByVector()).toEqual([vectorRefOf(b, 1)]);
    expect(v1.sourceId).not.toBe(b);
  });

  it("is not made to fail by a ref a later call already moved on: the others are still removed", async () => {
    const v1 = await ingest("a", "one");
    await ingest("a", "two");
    // a later removal of v2's ref already ran at a higher sequence
    await vector.remove([vectorRefOf(v1.sourceId, 2)], seq() + 100);
    const { entries, runner } = wiring();
    del(entries, "a");
    await drain(runner);
    expect(job(removal("vectorIndex")).status).toBe("succeeded");
    expect(await heldByVector()).toEqual([]);
  });
});

describe("the invalidation record of a deletion (invalidate.record, projection kinds)", () => {
  it("counts the registered removals per kind", async () => {
    await ingest("a", "alpha");
    const { entries } = wiring();
    del(entries, "a");
    expect(listInvalidations(db)[0]?.removedByKind).toMatchObject({ engine: 1, vectorIndex: 1 });
  });
});

describe("the closed list of not-applicable cases (derivatives.contract)", () => {
  it("lets the projection kinds declare cases ② and ③ not applicable and no other kind declares them here", () => {
    // "엔진 투영, 벡터 투영": one projection item is one source version's, and none is without a source
    const declared = Object.fromEntries(
      createProductRegistry({ policy: permissive })
        .kinds.filter((k) => k.storage === "projection")
        .map((k) => [k.kind, subjectHas()]),
    );
    expect(declared).toEqual({
      engine: { shared: false, withoutLineage: false },
      vectorIndex: { shared: false, withoutLineage: false },
    });
  });
});

describe("the product's boot wiring (I04-T04)", () => {
  let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;
  afterEach(async () => {
    await booted?.server.close();
    booted?.db.close();
    booted = undefined;
  });

  /** Boots on `dir`, stores one source and deletes it through the screen's route. */
  async function bootAndDelete(
    extra: {
      engine?: KnowledgeEngine;
      vectorIndex?: VectorIndex;
      registry?: DerivativeRegistry;
    } = {},
  ) {
    // the data directory has the canonical file already; boot opens it again
    db.close();
    booted = await bootBackend({
      dataDir: dir,
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
      providers: [],
      ...extra,
    });
    const live = booted;
    registerConnectorInstance(live.db, "c", "test-fixtures");
    const saved = saveSourceRecord(live.db, "c", {
      externalId: "x",
      title: "x",
      body: "jwxcanary",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    const { port } = live.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${"t".repeat(43)}` };
    const deleted = await send(port, routes.deleteSource.path, headers, "POST", {
      connectorId: "c",
      namespace: "",
      externalId: "x",
    });
    expect(deleted.body).toEqual({ outcome: "deleted" });
    await vi.waitFor(() =>
      expect(
        live.db.all("SELECT 1 FROM jobs WHERE kind = 'projection-remove' AND status = 'succeeded'"),
      ).toHaveLength(2),
    );
    const status = await send(port, routes.status.path, headers);
    return { live, saved, status: routes.status.response.parse(status.body) };
  }

  it("with the null engine and the empty vector index: the engine's removal succeeds, the vector index's is a skip by its registered mark, and the status shows both counts", async () => {
    const { live, status } = await bootAndDelete();
    expect(
      live.db.all(
        "SELECT target, reason FROM jobs WHERE kind = 'projection-remove' ORDER BY target",
      ),
    ).toEqual([
      { target: "engine", reason: null },
      { target: "vectorIndex", reason: "adapter-unavailable" },
    ]);
    expect(status.invalidations.recent[0]?.removedByKind).toMatchObject({
      engine: 1,
      vectorIndex: 1,
    });
  });

  it("with an engine and a vector index that hold content: the booted runner's removal job reaches the bound engine", async () => {
    const heldEngine = new MemoryKnowledgeEngine();
    const heldVector = new MemoryVectorIndex();
    await heldVector.reset(SPACE);
    const bound = overriding<KnowledgeEngine>(heldEngine, {
      // the booted backend's removal reaches the bound engine
      removeSource: async (...args: Parameters<KnowledgeEngine["removeSource"]>) => {
        removed.push(args[0].sourceId);
        return heldEngine.removeSource(...args);
      },
    });
    const removed: string[] = [];
    const { saved } = await bootAndDelete({ engine: bound, vectorIndex: heldVector });
    expect(removed).toEqual([String(saved.sourceId)]);
  });

  it("hands out the engine only as the registry wraps it: the call goes through the registry's judgement of the booted registry", async () => {
    const held = new MemoryKnowledgeEngine();
    // a registry that differs from the product's: its policy allows no scope for a search
    const denying = createProductRegistry({
      policy: { ...permissive, allows: () => false },
      permanentlyAbsent: { vectorIndex: true }, // the booted empty vector index, as the product marks it
    });
    await bootAndDelete({ engine: held, registry: denying });
    const live = booted as NonNullable<typeof booted>;
    // the double holds a source; the raw engine would return it
    const kept = saveSourceRecord(live.db, "c", { externalId: "y", title: "y", body: "keeper" });
    if (kept.status !== "created") throw new Error(kept.status);
    await held.upsertSource(
      { ref: { sourceId: String(kept.sourceId), version: 1 }, title: "y", body: "keeper" },
      { version: 1 },
      99,
    );
    expect(await held.relatedContext({ text: "keeper", limit: 5 })).toHaveLength(1); // the raw one answers
    // the wrapped one asks the booted registry's policy, which says no: hidden, not shown
    expect(await live.engine.relatedContext({ text: "keeper", limit: 5 })).toEqual([]);
  });
});
