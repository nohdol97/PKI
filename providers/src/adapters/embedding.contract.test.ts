// V01-C6/C7 `embedding.contract` for the Transformers.js embedder (V01-T14). The
// default run puts the embedder's own logic (pinned files, preparation, state,
// batching) through the suite with the model runtime stood in by a fake, on a
// synthetic pack: no weights, no network. The real runtime and the pinned bge-m3
// files run the same suite in embedding.roundtrip.test.ts, when explicitly enabled.
import { embeddingContract, FakeEmbeddingRuntime, writeModelPack } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BGE_M3_INT8, type PinnedModel } from "./bge-m3.ts";
import { createLocalEmbedder, TransformersEmbedder } from "./transformers-embedder.ts";

const root = mkdtempSync(join(tmpdir(), "pki-embed-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const pack = join(root, "pack");
const model: PinnedModel = {
  ...BGE_M3_INT8,
  modelId: "synthetic/embedder",
  revision: "0".repeat(40),
  dimension: 16,
  files: writeModelPack(pack, {
    "config.json": '{"synthetic": true}',
    "onnx/model_int8.onnx": "synthetic weights",
  }),
};

let instance = 0;
embeddingContract("transformers.js (fake runtime, synthetic pack)", {
  create: () =>
    new TransformersEmbedder({
      model,
      modelsDir: join(root, `models-${instance++}`),
      runtime: new FakeEmbeddingRuntime(),
      fetch: () => Promise.reject(new Error("no network in this test")),
    }),
  source: () => ({ kind: "local-pack", path: pack }),
});

describe("the product's Transformers.js embedder", () => {
  it("computes locally and describes the pinned model", () => {
    const embedder = createLocalEmbedder(join(root, "product-models"));
    expect(embedder.describe()).toEqual({
      modelId: BGE_M3_INT8.modelId,
      revision: BGE_M3_INT8.revision,
      dimension: 1024,
      maxTokens: 8192,
      license: "MIT",
      egress: "local",
    });
  });
});
