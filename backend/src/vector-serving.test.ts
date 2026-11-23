// H01C3-R8, C4 (last sentence): the index the server reads is the bound one with only `status` laid over.
// A stale mark says `rebuilding`; an active generation in another space than the bound embedder's says
// `unavailable`; either way the `vector` strategy answers `unavailable` with the reason and the other
// strategies' results do not change.
import { retrieve } from "@pki/knowledge-engine";
import { migrate, registerConnectorInstance, saveSourceRecord } from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { FakeEmbedder, MemoryVectorIndex, activateEmpty, memoryDbTemplate } from "@pki/testkit";
import { describe, expect, it } from "vitest";
import { productRegistry } from "./composition.ts";
import { NullKnowledgeEngine, servedVectorIndex } from "@pki/knowledge-engine/adapters";

const db = memoryDbTemplate(openBetterSqlite3, migrate)();
registerConnectorInstance(db, "c", "test-fixtures");
saveSourceRecord(db, "c", { externalId: "x", title: "등대 점검", body: "합성 자료" });

async function served(options: { activeModel: string; stale: boolean }) {
  const embedder = new FakeEmbedder({ modelId: "model-a" });
  await embedder.prepare({ kind: "download" }, new AbortController().signal);
  const index = new MemoryVectorIndex();
  await activateEmpty(index, { modelId: options.activeModel, revision: "fake-r1", dimension: 8 });
  const { modelId, revision, dimension } = embedder.describe();
  const view = servedVectorIndex(index, {
    isStale: () => options.stale,
    embeddingSpace: () => ({ modelId, revision, dimension }),
  });
  return { embedder, view };
}

const ask = async (embedder: FakeEmbedder, view: Awaited<ReturnType<typeof served>>["view"]) => {
  const registry = productRegistry({
    engine: new NullKnowledgeEngine(),
    vectorIndex: new MemoryVectorIndex(),
  });
  const { route } = await retrieve(
    db,
    registry,
    "등대",
    {},
    {
      enabled: ["vector"],
      vector: { embedding: embedder, index: view },
    },
  );
  return route;
};

describe("the served vector index", () => {
  it("is ready only when nothing is stale and the active generation is in the embedder's space", async () => {
    const ready = await served({ activeModel: "model-a", stale: false });
    expect(await ready.view.status()).toBe("ready");
    expect((await ask(ready.embedder, ready.view)).vector.status).toBe("used");

    const stale = await served({ activeModel: "model-a", stale: true });
    expect(await stale.view.status()).toBe("rebuilding");
    expect((await ask(stale.embedder, stale.view)).vector).toMatchObject({ status: "unavailable" });

    const other = await served({ activeModel: "model-b", stale: false });
    expect(await other.view.status()).toEqual({ unavailable: expect.stringMatching(/space/) });
    const route = await ask(other.embedder, other.view);
    expect(route.vector).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/space/),
    });
    expect(route.keyword.status).toBe("used"); // the other strategies are not touched
  });
});
