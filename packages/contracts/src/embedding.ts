// EmbeddingProvider adapter (ARCHITECTURE 5.2, V01-R14, ADR 0006): a contract
// separate from the LLM Provider. Every implementation states its egress, and one
// that is not 'local' goes through the embedding egress policy before every call.

/** 'local' computes on this machine; 'external' sends the texts to a remote service. */
export type EmbeddingEgress = "local" | "external";

export interface EmbeddingModel {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
  readonly maxTokens: number;
  readonly license: string;
  readonly egress: EmbeddingEgress;
}

/**
 * "model-missing" until the user prepares a model; nothing prepares one by itself.
 * "ready" only when every pinned file hash matched (ADR 0006).
 */
export type EmbeddingStatus =
  "ready" | "model-missing" | "preparing" | { readonly unavailable: string };

/** Approved download from the model repository, or a folder of pinned files (offline). */
export type PrepareSource =
  { readonly kind: "download" } | { readonly kind: "local-pack"; readonly path: string };

export type EmbeddingKind = "document" | "query";

export interface EmbeddingProvider {
  /** Fixed for the implementation's lifetime; no I/O. */
  describe(): EmbeddingModel;
  status(): Promise<EmbeddingStatus>;
  /** Resolves once the model is ready; an aborted or failed preparation leaves it not ready. */
  prepare(source: PrepareSource, signal: AbortSignal): Promise<void>;
  /**
   * One vector of `describe().dimension` per text, in order. Rejects with
   * AdapterUnavailableError while no model is ready, and on an aborted signal.
   */
  embed(
    texts: readonly string[],
    kind: EmbeddingKind,
    signal?: AbortSignal,
  ): Promise<Float32Array[]>;
}
