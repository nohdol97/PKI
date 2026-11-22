// The pipeline's calls into the KnowledgeEngine and VectorIndex ports (V02-R13):
// notices built inside the canonical transaction and delivered after it, in
// commit order, with the change sequence each change reached; the start-up
// comparison that rebuilds a projection whose applied sequence differs from the
// canonical one (null included) and leaves an equal one alone; the empty vector
// index's AdapterUnavailableError as a skip; and a failed delivery that keeps the
// projection marked stale until a rebuild.
import { AdapterUnavailableError, type KnowledgeEngine, type VectorIndex } from "@pki/contracts";
import {
  findSourceId,
  migrate,
  readChangeSeq,
  readSetting,
  registerConnectorInstance,
  saveSourceRecord,
  writeSetting,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex, openBetterSqlite3 } from "@pki/storage/adapters";
import { MemoryKnowledgeEngine, MemoryVectorIndex } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullKnowledgeEngine } from "./adapters/null-knowledge-engine.ts";
import {
  createProjections,
  PROJECTION_STALE_SETTINGS,
  vectorRefOf,
  versionNotice,
  type ProjectionNotice,
} from "./projections.ts";
import { purgeSource } from "./purge.test-support.ts";

const SPACE = { modelId: "fake", revision: "r1", dimension: 3 };
const AT = "2026-11-22T00:00:00.000Z";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

/** Stores a version and builds its notice in the same transaction, as syncConnector does. */
function store(externalId: string, body: string): ProjectionNotice {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, "c1", { externalId, title: `${externalId} 제목`, body });
    if (saved.status !== "created") throw new Error(saved.status);
    return versionNotice(db, saved.sourceId, saved.version);
  });
}
// by identity: a purged source's row holds the hash (I04-R7)
const sourceIdOf = (externalId: string) => findSourceId(db, "c1", "", externalId) as number;
const versionIds = (externalId: string) =>
  db
    .all("SELECT id FROM source_versions WHERE source_id = ? ORDER BY version", [
      sourceIdOf(externalId),
    ])
    .map((r) => r.id as number);

function spied<T extends object>(target: T) {
  for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(target))) {
    if (key !== "constructor") vi.spyOn(target, key as never);
  }
  return target;
}

function setup(
  engine: KnowledgeEngine = spied(new MemoryKnowledgeEngine()),
  vectorIndex: VectorIndex = spied(new MemoryVectorIndex()),
) {
  const errors: string[] = [];
  const projections = createProjections({
    db,
    engine,
    vectorIndex,
    embeddingSpace: () => SPACE,
    onError: (projection, error) => errors.push(`${projection}:${(error as Error).name}`),
  });
  return { engine, vectorIndex, projections, errors };
}

describe("notices", () => {
  it("carry each change's own change sequence and the versions a new one replaced", () => {
    const a1 = store("a", "alpha");
    const b1 = store("b", "beta");
    const a2 = store("a", "alpha two");
    const [va1, va2] = versionIds("a");
    expect([a1, b1, a2]).toEqual([
      {
        kind: "version",
        sourceId: sourceIdOf("a"),
        version: 1,
        versionId: va1,
        replacedVersions: [],
        changeSeq: 1,
      },
      {
        kind: "version",
        sourceId: sourceIdOf("b"),
        version: 1,
        versionId: versionIds("b")[0],
        replacedVersions: [],
        changeSeq: 2,
      },
      {
        kind: "version",
        sourceId: sourceIdOf("a"),
        version: 2,
        versionId: va2,
        replacedVersions: [1],
        changeSeq: 3,
      },
    ]);
  });

  it("of a deletion are none: the tombstone's transaction registers the projections' removal jobs instead (I04-R12)", () => {
    store("a", "alpha");
    store("a", "alpha two");
    const { outcome, version } = purgeSource(db, sourceIdOf("a"), {
      reason: "source-deleted",
      at: AT,
    });
    expect(outcome).toBe("deleted");
    expect(version).toBe(2);
    expect(versionIds("a")).toEqual([]);
    expect(
      db.all(
        "SELECT target, fence_version FROM jobs WHERE kind = 'projection-remove' ORDER BY target",
      ),
    ).toEqual([
      { target: "engine", fence_version: 2 },
      { target: "vectorIndex", fence_version: 2 },
    ]);
    // nothing to delete the second time: no change, no new job
    expect(purgeSource(db, sourceIdOf("a"), { reason: "source-deleted", at: AT })).toEqual({
      outcome: "unchanged",
      version: 2,
    });
    expect(db.all("SELECT 1 FROM jobs WHERE kind = 'projection-remove'")).toHaveLength(2);
  });
});

describe("delivery", () => {
  it("upserts each stored version and removes the replaced one, in the engine and the index", async () => {
    const { engine, vectorIndex, projections } = setup();
    await vectorIndex.reset(SPACE);
    await projections.notify([store("a", "alpha"), store("b", "beta")]);
    await projections.notify([store("a", "gamma")]);
    const a = String(sourceIdOf("a"));
    const b = String(sourceIdOf("b"));
    expect(vi.mocked(engine.upsertSource).mock.calls).toEqual([
      [{ ref: { sourceId: a, version: 1 }, title: "a 제목", body: "alpha" }, { version: 1 }, 1],
      [{ ref: { sourceId: b, version: 1 }, title: "b 제목", body: "beta" }, { version: 1 }, 2],
      [{ ref: { sourceId: a, version: 2 }, title: "a 제목", body: "gamma" }, { version: 2 }, 3],
    ]);
    expect(vi.mocked(engine.removeSource).mock.calls).toEqual([
      [{ sourceId: a, version: 1 }, { version: 2 }, 3],
    ]);
    expect(vi.mocked(vectorIndex.remove).mock.calls).toEqual([
      [[], 1],
      [[], 2],
      [[vectorRefOf(sourceIdOf("a"), 1)], 3],
    ]);
    expect(await engine.appliedChangeSeq()).toBe(3);
    expect(await vectorIndex.appliedChangeSeq()).toBe(3);
    expect(await engine.relatedContext({ text: "alpha", limit: 5 })).toEqual([]);
    expect(await engine.relatedContext({ text: "gamma", limit: 5 })).toEqual([
      { ref: { sourceId: a, version: 2 }, score: 1 },
    ]);
  });

  it("does not hand the engine a version purged before its notice was delivered", async () => {
    const { engine, projections } = setup();
    const stored = store("a", "jwxcanary");
    purgeSource(db, sourceIdOf("a"), {
      reason: "source-deleted",
      at: AT,
    });
    await projections.notify([stored]);
    expect(engine.upsertSource).not.toHaveBeenCalled();
    expect(await engine.relatedContext({ text: "jwxcanary", limit: 5 })).toEqual([]);
    // nothing was handed over, and the removal is a job (I04-R12), not this notice's
    expect(await engine.appliedChangeSeq()).toBeNull();
  });

  it("delivers in the order notified, one notice at a time", async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const engine = new MemoryKnowledgeEngine();
    const upsert = engine.upsertSource.bind(engine);
    vi.spyOn(engine, "upsertSource").mockImplementation(async (input, fence, seq) => {
      order.push(`start ${seq}`);
      if (seq === 1) await held;
      await upsert(input, fence, seq);
      order.push(`end ${seq}`);
    });
    const { projections } = setup(engine, new EmptyVectorIndex());
    const first = projections.notify([store("a", "alpha")]);
    const second = projections.notify([store("b", "beta")]);
    await Promise.resolve();
    expect(order).toEqual(["start 1"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    await projections.drain();
  });

  it("marks a projection that was unavailable for a notice stale, without an error", async () => {
    const { projections, errors } = setup(new MemoryKnowledgeEngine(), new EmptyVectorIndex());
    await projections.notify([store("a", "alpha")]);
    expect(errors).toEqual([]);
    expect(projections.isStale("vectorIndex")).toBe(true);
    expect(projections.isStale("engine")).toBe(false);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.vectorIndex)).toBe("1");
    // the empty index stays cost-free: its rebuild is unavailable too, a skip
    expect(await projections.reconcile()).toEqual({ engine: "current", vectorIndex: "skipped" });
    expect(errors).toEqual([]);
  });

  it("a notice the engine missed while unavailable is rebuilt away at the next start, a purged source's text with it (review F1)", async () => {
    const engine = new MemoryKnowledgeEngine();
    const upsert = engine.upsertSource.bind(engine);
    vi.spyOn(engine, "upsertSource")
      .mockImplementationOnce(upsert)
      .mockImplementationOnce(upsert)
      .mockRejectedValueOnce(new AdapterUnavailableError("engine restarting"))
      .mockImplementation(upsert);
    const { projections, errors } = setup(engine, new EmptyVectorIndex());
    await projections.notify([store("a", "jwxcanary secret"), store("b", "beta")]);
    purgeSource(db, sourceIdOf("a"), { reason: "user-deleted", at: AT }); // its removal is a job, not run here
    await projections.notify([store("c", "gamma")]); // unavailable: missed
    await projections.notify([store("d", "delta")]); // the engine takes no more notices until a rebuild
    expect(errors).toEqual([]);
    expect(await engine.appliedChangeSeq()).toBe(2);
    // restart: a fresh projections instance on the same store and engine
    const { projections: restarted } = setup(engine, new EmptyVectorIndex());
    expect(await restarted.reconcile()).toMatchObject({ engine: "rebuilt" });
    expect(await engine.relatedContext({ text: "jwxcanary", limit: 5 })).toEqual([]);
    expect(await engine.relatedContext({ text: "gamma", limit: 5 })).toHaveLength(1);
    expect(await engine.relatedContext({ text: "delta", limit: 5 })).toHaveLength(1);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("0");
  });

  it("after a failed delivery stops notifying that projection and marks it stale", async () => {
    const engine = new MemoryKnowledgeEngine();
    const upsert = engine.upsertSource.bind(engine);
    const spy = vi
      .spyOn(engine, "upsertSource")
      .mockRejectedValueOnce(new Error("engine down"))
      .mockImplementation(upsert);
    const { projections, errors } = setup(engine, new MemoryVectorIndex());
    await projections.notify([store("a", "alpha")]);
    await projections.notify([store("b", "beta")]);
    expect(errors).toEqual(["engine:Error"]);
    expect(spy).toHaveBeenCalledTimes(1); // the second notice did not reach it
    expect(await engine.appliedChangeSeq()).toBeNull();
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");
  });
});

describe("rebuild (a projection-rebuild job's call)", () => {
  it("clears the stale mark, in the process and in the setting, only after the rebuild succeeded", async () => {
    const engine = new MemoryKnowledgeEngine();
    const upsert = engine.upsertSource.bind(engine);
    vi.spyOn(engine, "upsertSource")
      .mockRejectedValueOnce(new Error("engine down"))
      .mockImplementation(upsert);
    vi.spyOn(engine, "rebuild")
      .mockRejectedValueOnce(new Error("rebuild failed"))
      .mockImplementation(MemoryKnowledgeEngine.prototype.rebuild.bind(engine));
    const { projections } = setup(engine, new MemoryVectorIndex());
    await projections.notify([store("a", "alpha")]);
    expect(projections.isStale("engine")).toBe(true);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");

    await expect(projections.rebuild("engine", 1)).rejects.toThrow(/rebuild failed/);
    expect(projections.isStale("engine")).toBe(true);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");

    await projections.rebuild("engine", 1);
    expect(projections.isStale("engine")).toBe(false);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("0");
  });
});

describe("reconcile (start-up comparison)", () => {
  it("rebuilds an engine behind the canonical change sequence from the latest versions", async () => {
    store("a", "alpha");
    store("a", "alpha two");
    store("b", "beta");
    const { engine, projections } = setup();
    expect(await projections.reconcile()).toMatchObject({ engine: "rebuilt" });
    expect(engine.rebuild).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engine.rebuild).mock.calls[0]?.[1]).toBe(3);
    expect(await engine.appliedChangeSeq()).toBe(3);
    expect(await engine.relatedContext({ text: "alpha two beta", limit: 5 })).toEqual([
      { ref: { sourceId: String(sourceIdOf("a")), version: 2 }, score: 2 },
      { ref: { sourceId: String(sourceIdOf("b")), version: 1 }, score: 1 },
    ]);
  });

  it("does not rebuild a projection that applied the canonical change sequence", async () => {
    const { engine, vectorIndex, projections } = setup();
    await vectorIndex.reset(SPACE);
    await projections.notify([store("a", "alpha")]);
    expect(await projections.reconcile()).toEqual({ engine: "current", vectorIndex: "current" });
    expect(engine.rebuild).not.toHaveBeenCalled();
    expect(vectorIndex.reset).toHaveBeenCalledTimes(1); // the test's own
  });

  it("rebuilds the null engine on every start, whatever the change sequence (no kind check)", async () => {
    const engine = spied(new NullKnowledgeEngine());
    const { projections } = setup(engine, new EmptyVectorIndex());
    expect(await projections.reconcile()).toEqual({ engine: "rebuilt", vectorIndex: "skipped" });
    expect(await projections.reconcile()).toEqual({ engine: "rebuilt", vectorIndex: "skipped" });
    expect(engine.rebuild).toHaveBeenCalledTimes(2);
    expect((vi.mocked(engine.rebuild).mock.calls[0] as unknown[])[1]).toBe(readChangeSeq(db));
  });

  it("resets a vector index behind the canonical sequence and marks it applied", async () => {
    store("a", "alpha");
    const { vectorIndex, projections } = setup();
    expect(await projections.reconcile()).toMatchObject({ vectorIndex: "rebuilt" });
    expect(vectorIndex.reset).toHaveBeenCalledWith(SPACE);
    expect(await vectorIndex.appliedChangeSeq()).toBe(1);
    expect(await projections.reconcile()).toMatchObject({ vectorIndex: "current" });
  });

  it("rebuilds a projection marked stale even when its applied sequence matches, then clears the mark", async () => {
    const engine = spied(new MemoryKnowledgeEngine());
    const { projections } = setup(engine);
    store("a", "alpha");
    await engine.upsertSource(
      { ref: { sourceId: "x", version: 1 }, title: "", body: "" },
      { version: 1 },
      1,
    );
    writeSetting(db, PROJECTION_STALE_SETTINGS.engine, "1");
    expect(await projections.reconcile()).toMatchObject({ engine: "rebuilt" });
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("0");
    expect(await projections.reconcile()).toMatchObject({ engine: "current" });
  });

  it("reports a failed rebuild and keeps the projection stale", async () => {
    const engine = new MemoryKnowledgeEngine();
    vi.spyOn(engine, "rebuild").mockRejectedValue(new Error("rebuild broke"));
    const { projections, errors } = setup(engine, new EmptyVectorIndex());
    expect(await projections.reconcile()).toEqual({ engine: "failed", vectorIndex: "skipped" });
    expect(errors).toEqual(["engine:Error"]);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");
  });
});

describe("AdapterUnavailableError", () => {
  it("is a skip for either projection at start, which stays stale", async () => {
    const engine = new MemoryKnowledgeEngine();
    vi.spyOn(engine, "appliedChangeSeq").mockRejectedValue(new AdapterUnavailableError("off"));
    const { projections, errors } = setup(engine, new EmptyVectorIndex());
    expect(await projections.reconcile()).toEqual({ engine: "skipped", vectorIndex: "skipped" });
    expect(errors).toEqual([]);
    expect(projections.isStale("engine")).toBe(true);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.engine)).toBe("1");
  });
});

describe("rebuild input", () => {
  it("is the latest version of each source, a purged source absent", async () => {
    store("a", "alpha one");
    store("a", "alpha two");
    store("b", "beta");
    store("c", "jwxcanary");
    purgeSource(db, sourceIdOf("c"), { reason: "source-deleted", at: AT });
    const engine = new MemoryKnowledgeEngine();
    const seen: unknown[] = [];
    const rebuild = engine.rebuild.bind(engine);
    vi.spyOn(engine, "rebuild").mockImplementation(async (sources, seq) => {
      async function* tap() {
        for await (const input of sources) {
          seen.push(input);
          yield input;
        }
      }
      await rebuild(tap(), seq);
    });
    const { projections } = setup(engine, new EmptyVectorIndex());
    await projections.reconcile();
    expect(seen).toEqual([
      {
        ref: { sourceId: String(sourceIdOf("a")), version: 2 },
        title: "a 제목",
        body: "alpha two",
      },
      { ref: { sourceId: String(sourceIdOf("b")), version: 1 }, title: "b 제목", body: "beta" },
    ]);
  });
});
