// The product's EmbeddingProvider (V01-R14, ARCHITECTURE 5.2, ADR 0006): the
// pinned bge-m3 files run by Transformers.js on this machine, so `egress` is
// 'local'. It starts without a model and prepares one only when asked — from a
// local pack or by the approved download — and becomes "ready" only once every
// pinned file matched. After that it needs no network.
import {
  AdapterUnavailableError,
  type EmbeddingKind,
  type EmbeddingModel,
  type EmbeddingProvider,
  type EmbeddingStatus,
  type PrepareSource,
} from "@pki/contracts";
import { BGE_M3_INT8, type PinnedModel } from "./bge-m3.ts";
import {
  installModel,
  ModelFileError,
  type ModelFetch,
  type ModelFileReason,
} from "./model-files.ts";
import { transformersRuntime } from "./transformers-runtime.ts";

export type { ModelFetch } from "./model-files.ts";

/** A loaded model: one vector per text, in order; checks `signal` between texts. */
export interface LoadedEmbedding {
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

/** Loads a model from a folder holding exactly the pinned files; reads nothing else. */
export interface EmbeddingRuntime {
  load(dir: string, model: PinnedModel): Promise<LoadedEmbedding>;
}

export interface TransformersEmbedderOptions {
  model: PinnedModel;
  /** Where prepared models are installed (inside the data directory). */
  modelsDir: string;
  runtime: EmbeddingRuntime;
  /** Used by the approved download only. */
  fetch: ModelFetch;
}

type State =
  | { readonly kind: "model-missing" }
  | { readonly kind: "preparing" }
  | { readonly kind: "ready"; readonly loaded: LoadedEmbedding }
  | { readonly kind: "unavailable"; readonly reason: ModelFileReason };

const MISSING: State = { kind: "model-missing" };

export class TransformersEmbedder implements EmbeddingProvider {
  readonly #options: TransformersEmbedderOptions;
  readonly #model: EmbeddingModel;
  #state: State = MISSING;

  constructor(options: TransformersEmbedderOptions) {
    this.#options = options;
    const { modelId, revision, dimension, maxTokens, license } = options.model;
    this.#model = Object.freeze({
      modelId,
      revision,
      dimension,
      maxTokens,
      license,
      egress: "local",
    });
  }

  describe(): EmbeddingModel {
    return this.#model;
  }

  async status(): Promise<EmbeddingStatus> {
    const state = this.#state;
    return state.kind === "unavailable" ? { unavailable: state.reason } : state.kind;
  }

  async prepare(source: PrepareSource, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#state.kind === "preparing") throw new Error("a preparation is already running");
    // Set before the first await, so a status read right after the call sees it.
    this.#state = { kind: "preparing" };
    try {
      const { model, modelsDir, fetch, runtime } = this.#options;
      const dir = await installModel({ model, modelsDir, source, fetch, signal });
      signal.throwIfAborted();
      let loaded: LoadedEmbedding;
      try {
        loaded = await runtime.load(dir, model);
      } catch {
        throw new ModelFileError("embedding runtime failed to load");
      }
      signal.throwIfAborted();
      this.#state = { kind: "ready", loaded };
    } catch (error) {
      if (signal.aborted) {
        this.#state = MISSING;
        signal.throwIfAborted();
      }
      const reason = error instanceof ModelFileError ? error.reason : "model install failed";
      this.#state = { kind: "unavailable", reason };
      throw new ModelFileError(reason);
    }
  }

  async embed(
    texts: readonly string[],
    _kind: EmbeddingKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    signal?.throwIfAborted();
    const state = this.#state;
    if (state.kind !== "ready") {
      throw new AdapterUnavailableError(state.kind === "unavailable" ? state.reason : state.kind);
    }
    if (texts.length === 0) return [];
    // bge-m3 takes documents and queries alike (no instruction prefix), so the kind
    // does not change the input.
    const vectors = await state.loaded.embed([...texts], signal);
    signal?.throwIfAborted();
    const { dimension } = this.#model;
    if (
      vectors.length !== texts.length ||
      !vectors.every((v) => v instanceof Float32Array && v.length === dimension)
    ) {
      throw new Error("the runtime returned vectors of the wrong shape");
    }
    return vectors;
  }
}

/** The product's embedder: pinned bge-m3, the Transformers.js runtime, the global fetch. */
export function createLocalEmbedder(modelsDir: string): EmbeddingProvider {
  return new TransformersEmbedder({
    model: BGE_M3_INT8,
    modelsDir,
    runtime: transformersRuntime,
    // Read at call time, so the download goes through whatever fetch is current.
    fetch: (url, init) => globalThis.fetch(url, init),
  });
}
