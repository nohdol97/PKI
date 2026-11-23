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
 * A build of one generation beside the active one (H01C3-R2). The active generation is not touched until
 * `activate` succeeds; a handle whose build was discarded, replaced by a newer `beginRebuild` or already
 * activated rejects every call.
 */
export interface VectorRebuild {
  /** The refs the building generation holds, in ref order. */
  refs(): Promise<IndexedRef[]>;
  /** Same ordering and dimension rules as the index's upsert, against the building generation's own marks. */
  upsert(
    items: readonly { ref: IndexedRef; vector: Float32Array }[],
    changeSeq: number,
  ): Promise<void>;
  /**
   * One atomic step: when the building generation's ref set equals `expectedRefs` it becomes the active one,
   * the previous active generation is deleted and `appliedChangeSeq` is recorded; otherwise it rejects and
   * nothing changes (the build stays, for the caller to fix or discard).
   */
  activate(expectedRefs: readonly IndexedRef[], appliedChangeSeq: number | null): Promise<void>;
  /** Drops the building generation; the active one is untouched. */
  discard(): Promise<void>;
}

/**
 * Generations (H01C3-R2): a generation is the vectors of one embedding space. At most one is active (what
 * `status`, `embeddingSpace`, `appliedChangeSeq`, `search` and `upsert` see) and at most one is being built.
 * Without an active generation `status` is "rebuilding" while one is built and unavailable otherwise, and
 * `upsert` and `search` reject.
 *
 * Ordering (ARCHITECTURE 6): each ref remembers, per generation, the change sequence of its last upsert or
 * removal. A call carrying an older sequence for any of its refs is rejected whole with StaleFenceError, so a
 * late notification cannot overwrite or resurrect a ref. An equal sequence is a redelivery and is accepted.
 */
export interface VectorIndex {
  status(): Promise<VectorIndexStatus>;
  /** The active generation's space; null if none. */
  embeddingSpace(): Promise<EmbeddingSpace | null>;
  /** The active generation's applied change sequence (highest seen); null if none. */
  appliedChangeSeq(): Promise<number | null>;
  /** Starts a generation in `space` beside the active one, discarding any unfinished build. */
  beginRebuild(space: EmbeddingSpace): Promise<VectorRebuild>;
  /** Into the active generation; rejects vectors whose length differs from its dimension. */
  upsert(
    items: readonly { ref: IndexedRef; vector: Float32Array }[],
    changeSeq: number,
  ): Promise<void>;
  /** From every generation; succeeds when there is none. */
  remove(refs: readonly IndexedRef[], changeSeq: number): Promise<void>;
  /** At most k hits of the active generation, highest score first. */
  search(query: Float32Array, k: number): Promise<{ ref: IndexedRef; score: number }[]>;
}
