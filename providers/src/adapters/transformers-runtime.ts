// Transformers.js (Apache-2.0, ADR 0006) as the embedder's runtime, on the CPU
// through onnxruntime-node. It loads only from the given folder: remote models,
// the library's own file cache and its fetch are switched off, so it neither
// downloads nor writes a cache. The library is imported on the first load, not at
// backend start, so a runtime that cannot load leaves the rest of the app working.
import type { PinnedModel } from "./bge-m3.ts";
import type { EmbeddingRuntime, LoadedEmbedding } from "./transformers-embedder.ts";

const noNetwork = () => Promise.reject(new Error("the local embedder does not use the network"));

/** The pinned pooling, L2-normalized: the vector the embedding space is made of. */
export const extractionOptions = (model: PinnedModel) =>
  ({ pooling: model.pooling, normalize: true }) as const;

export const transformersRuntime: EmbeddingRuntime = {
  async load(dir: string, model: PinnedModel): Promise<LoadedEmbedding> {
    const { env, LogLevel, pipeline } = await import("@huggingface/transformers");
    // Its console messages name local paths and bypass the product's log(); every
    // failure reaches the user as a fixed phrase instead.
    env.logLevel = LogLevel.NONE;
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.useFSCache = false;
    env.useBrowserCache = false;
    env.fetch = noNetwork;
    // An absolute folder is not a hub model ID, so files resolve inside it.
    const extractor = await pipeline("feature-extraction", dir, {
      local_files_only: true,
      dtype: model.dtype,
      device: "cpu",
    });
    return {
      // One text per run: the int8 export's vectors change when a batch pads a
      // text (cosine 0.985 against the same text alone, V01-T14 real run), and the
      // same text must give the same vector however it is batched.
      async embed(texts, signal) {
        const vectors: Float32Array[] = [];
        for (const text of texts) {
          signal?.throwIfAborted();
          const output = await extractor(text, extractionOptions(model));
          vectors.push(Float32Array.from(output.data as Float32Array));
        }
        return vectors;
      },
    };
  },
};
