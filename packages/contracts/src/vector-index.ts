// VectorIndex adapter (ARCHITECTURE 5.4, V01-R15). A projection of the canonical
// store: it holds canonical IDs and vectors, never text, and can be rebuilt.

/** Always a canonical-store ID; the index never holds content. */
export type IndexedRef = string;

export interface EmbeddingSpace {
  readonly modelId: string;
  readonly revision: string;
  readonly dimension: number;
}

export type VectorIndexStatus = "ready" | "rebuilding" | { readonly unavailable: string };

/**
 * Ordering (ARCHITECTURE 6): each ref remembers the change sequence of its last
 * upsert or removal. A call carrying an older sequence for any of its refs is
 * rejected whole with StaleFenceError, so a late notification cannot overwrite or
 * resurrect a ref. An equal sequence is a redelivery and is accepted.
 */
export interface VectorIndex {
  status(): Promise<VectorIndexStatus>;
  embeddingSpace(): Promise<EmbeddingSpace | null>;
  /** Highest change sequence applied since the last reset; null if none. */
  appliedChangeSeq(): Promise<number | null>;
  /** Start of a rebuild: drops every vector and ordering mark and fixes the space. */
  reset(space: EmbeddingSpace): Promise<void>;
  /** Rejects vectors whose length differs from the space's dimension, and calls before reset. */
  upsert(
    items: readonly { ref: IndexedRef; vector: Float32Array }[],
    changeSeq: number,
  ): Promise<void>;
  remove(refs: readonly IndexedRef[], changeSeq: number): Promise<void>;
  /** At most k hits, highest score first. */
  search(query: Float32Array, k: number): Promise<{ ref: IndexedRef; score: number }[]>;
}
