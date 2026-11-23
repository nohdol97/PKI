// H01C3-R4..R10: the vector index's write path. A rebuild embeds the latest version of every source into a
// generation beside the active one and switches only when the ref sets agree; a new version's notice
// embeds into the active generation; a start that finds the index behind asks for a rebuild job and never
// embeds itself. Documents reach the embedder only through the transmission policy (R6).
import type { EmbeddingSpace, VectorIndex, VectorRebuild } from "@pki/contracts";
import { denyExternalEmbedding, embedWithinPolicy } from "@pki/providers";
import {
  findSourceId,
  migrate,
  readChangeSeq,
  readSetting,
  registerConnectorInstance,
  saveSourceRecord,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import {
  FakeEmbedder,
  MemoryKnowledgeEngine,
  MemoryVectorIndex,
  memoryDbTemplate,
} from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjections,
  PROJECTION_STALE_SETTINGS,
  vectorRefOf,
  versionNotice,
  type ProjectionNotice,
} from "./projections.ts";
import { purgeSource } from "./purge.test-support.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);
const AT = "2026-11-24T00:00:00.000Z";

let db: SqlDriver;
beforeEach(() => {
  db = freshDb();
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => db.close());

function store(externalId: string, body: string): ProjectionNotice {
  return db.transaction(() => {
    const saved = saveSourceRecord(db, "c1", { externalId, title: `${externalId} 제목`, body });
    if (saved.status !== "created") throw new Error(saved.status);
    return versionNotice(db, saved.sourceId, saved.version);
  });
}
const sourceIdOf = (externalId: string) => findSourceId(db, "c1", "", externalId) as number;
const spaceOf = (embedder: FakeEmbedder): EmbeddingSpace => {
  const { modelId, revision, dimension } = embedder.describe();
  return { modelId, revision, dimension };
};

async function setup(
  options: {
    embedder?: FakeEmbedder;
    index?: VectorIndex;
    batchSize?: number;
    /** Runs before the nth embed call (1-based) reaches the embedder, still inside the policy wrapper. */
    beforeEmbed?: (call: number) => void;
  } = {},
) {
  const embedder = options.embedder ?? new FakeEmbedder();
  const index = options.index ?? new MemoryVectorIndex();
  await embedder.prepare({ kind: "download" }, new AbortController().signal);
  const requested: string[] = [];
  let calls = 0;
  const projections = createProjections({
    db,
    engine: new MemoryKnowledgeEngine(),
    vectorIndex: index,
    embeddingSpace: () => spaceOf(embedder),
    vectors: {
      embed: (texts, signal) => {
        options.beforeEmbed?.(++calls);
        return embedWithinPolicy(embedder, denyExternalEmbedding, texts, "document", signal);
      },
      requestRebuild: (name) => requested.push(name),
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
    },
  });
  return { embedder, index, projections, requested };
}

/** The refs the query for a document's text finds first. */
async function nearest(
  embedder: FakeEmbedder,
  index: VectorIndex,
  externalId: string,
  body: string,
) {
  const [query] = await embedder.embed([`${externalId} 제목\n${body}`], "query");
  return (await index.search(query as Float32Array, 10)).map((hit) => hit.ref);
}

describe("rebuild and notice (H01C3-C2)", () => {
  it("holds one ref per source's latest version, found by its own text; a new version replaces the old ref", async () => {
    store("a", "alpha");
    store("a", "alpha two");
    store("b", "beta");
    const { embedder, index, projections } = await setup();
    await projections.rebuild("vectorIndex", readChangeSeq(db));

    const [a, b] = [sourceIdOf("a"), sourceIdOf("b")];
    const refs = await nearest(embedder, index, "a", "alpha two");
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(vectorRefOf(a, 2));
    expect(refs).toContain(vectorRefOf(b, 1));
    expect(await index.appliedChangeSeq()).toBe(readChangeSeq(db));

    await projections.notify([store("a", "alpha three")]);
    const after = await nearest(embedder, index, "a", "alpha three");
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(vectorRefOf(a, 3));
    expect(after).not.toContain(vectorRefOf(a, 2));
  });

  it("never calls an embedder whose egress is not local, on rebuild or on a notice", async () => {
    store("a", "alpha");
    const embedder = new FakeEmbedder({ egress: "external" });
    const { index, projections } = await setup({ embedder });
    await expect(projections.rebuild("vectorIndex", readChangeSeq(db))).rejects.toThrow(
      /egress denied/,
    );
    await projections.notify([store("b", "beta")]);
    expect(embedder.calls.embed).toEqual([]);
    expect(await index.status()).toEqual({ unavailable: expect.any(String) });
  });
});

describe("a source deleted while the index is being built (H01C3-C3)", () => {
  it("is not in the switched-in generation, though its removal job has not run yet", async () => {
    store("a", "alpha");
    store("b", "beta");
    store("c", "gamma");
    const { embedder, index, projections } = await setup({
      batchSize: 1,
      // the first batch is already in the building generation when `a` is deleted: only its removal job, which
      // waits behind the rebuild, would reach the index
      beforeEmbed: (call) => {
        if (call === 2) purgeSource(db, sourceIdOf("a"), { reason: "source-deleted", at: AT });
      },
    });
    await projections.rebuild("vectorIndex", readChangeSeq(db));

    const refs = await nearest(embedder, index, "b", "beta");
    expect(refs.sort()).toEqual([vectorRefOf(sourceIdOf("b"), 1), vectorRefOf(sourceIdOf("c"), 1)]);
  });
});

describe("replacing the embedding (H01C3-C4)", () => {
  const modelB = () => new FakeEmbedder({ modelId: "model-b", dimension: 4 });

  async function activeWithModelA() {
    store("a", "alpha");
    store("b", "beta");
    store("c", "gamma");
    const builds: VectorRebuild[] = [];
    const index = new MemoryVectorIndex();
    const begin = index.beginRebuild.bind(index);
    index.beginRebuild = async (space) => {
      const build = await begin(space);
      builds.push(build);
      return build;
    };
    const embedderA = new FakeEmbedder({ modelId: "model-a" });
    await (await setup({ embedder: embedderA, index })).projections.rebuild("vectorIndex", 3);
    builds.length = 0;
    return { index, embedderA, builds };
  }

  it.each([
    [
      "the embedder fails in the second batch",
      () => {
        throw new Error("embed failed");
      },
    ],
    ["the job is told to stop", undefined],
  ])("keeps the previous generation when %s, and leaves no building one", async (_name, fail) => {
    const { index, embedderA, builds } = await activeWithModelA();
    const before = await nearest(embedderA, index, "a", "alpha");
    const controller = new AbortController();
    const { projections } = await setup({
      embedder: modelB(),
      index,
      batchSize: 1,
      beforeEmbed: (call) => {
        if (call === 2 && fail) fail();
        if (call === 1 && !fail) queueMicrotask(() => controller.abort());
      },
    });
    await expect(
      projections.rebuild("vectorIndex", readChangeSeq(db), controller.signal),
    ).rejects.toThrow();

    expect(await index.embeddingSpace()).toEqual(spaceOf(embedderA));
    expect(await index.appliedChangeSeq()).toBe(3);
    expect(await nearest(embedderA, index, "a", "alpha")).toEqual(before);
    await expect(builds[0]?.refs()).rejects.toThrow();
  });

  it("switches to the new space at the sequence it read when the rebuild finishes", async () => {
    const { index } = await activeWithModelA();
    const embedderB = modelB();
    const { projections } = await setup({ embedder: embedderB, index, batchSize: 2 });
    await projections.rebuild("vectorIndex", 3);
    expect(await index.embeddingSpace()).toEqual(spaceOf(embedderB));
    expect(await index.appliedChangeSeq()).toBe(3);
    expect(await nearest(embedderB, index, "b", "beta")).toHaveLength(3);
  });
});

describe("the start comparison (H01C3-R10)", () => {
  it("asks for a rebuild job when the index is behind or in another space, and embeds nothing itself", async () => {
    store("a", "alpha");
    const { embedder, index, projections, requested } = await setup();
    expect(await projections.reconcile()).toMatchObject({ vectorIndex: "requested" });
    expect(requested).toEqual(["vectorIndex"]);
    expect(projections.isStale("vectorIndex")).toBe(true);
    expect(readSetting(db, PROJECTION_STALE_SETTINGS.vectorIndex)).toBe("1");

    await projections.rebuild("vectorIndex", readChangeSeq(db));
    expect(await projections.reconcile()).toMatchObject({ vectorIndex: "current" });
    expect(requested).toHaveLength(1);

    const other = await setup({ embedder: new FakeEmbedder({ modelId: "model-b" }), index });
    expect(await other.projections.reconcile()).toMatchObject({ vectorIndex: "requested" });
    expect(embedder.calls.embed).toHaveLength(1); // the one rebuild above, none from either start
  });
});
