// Runs `embedding.contract` against the fake embedder (test builds only), in both
// egress modes, and pins the fake's own bookkeeping that other tests rely on.
import { describe, expect, it } from "vitest";
import { embeddingContract } from "./embedding.contract.ts";
import { FakeEmbedder } from "./fake-embedder.ts";

const localPack = { kind: "local-pack", path: "/synthetic/model-pack" } as const;

embeddingContract("fake (local)", {
  create: () => new FakeEmbedder(),
  source: () => localPack,
});

embeddingContract("fake (external)", {
  create: () => new FakeEmbedder({ egress: "external", dimension: 40 }),
  source: () => ({ kind: "download" }),
});

describe("FakeEmbedder", () => {
  it("records what it was asked, and never prepares on a status read", async () => {
    const fake = new FakeEmbedder();
    await fake.status();
    expect(fake.calls).toEqual({ status: 1, prepare: [], embed: [] });
    await fake.prepare(localPack, new AbortController().signal);
    await fake.embed(["합성 문장"], "query");
    expect(fake.calls).toEqual({
      status: 1,
      prepare: [localPack],
      embed: [{ texts: ["합성 문장"], kind: "query" }],
    });
  });

  it("reports preparing while a preparation is in flight", async () => {
    const fake = new FakeEmbedder();
    const pending = fake.prepare(localPack, new AbortController().signal);
    expect(await fake.status()).toBe("preparing");
    await pending;
    expect(await fake.status()).toBe("ready");
  });

  it("returns to model-missing when a preparation is aborted midway", async () => {
    const fake = new FakeEmbedder();
    const controller = new AbortController();
    const pending = fake.prepare(localPack, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await fake.status()).toBe("model-missing");
  });

  it("can stand for an embedder whose runtime cannot load", async () => {
    const fake = new FakeEmbedder({ unavailable: "synthetic runtime failure" });
    expect(await fake.status()).toEqual({ unavailable: "synthetic runtime failure" });
    await expect(fake.prepare(localPack, new AbortController().signal)).rejects.toThrow(
      /synthetic runtime failure/,
    );
  });

  it("maps the same text to the same vector regardless of kind, so a query finds its document", async () => {
    const fake = new FakeEmbedder();
    await fake.prepare(localPack, new AbortController().signal);
    const [doc] = await fake.embed(["합성 등대"], "document");
    const [query] = await fake.embed(["합성 등대"], "query");
    expect(Array.from(query as Float32Array)).toEqual(Array.from(doc as Float32Array));
  });
});
