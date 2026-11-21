// Memory VectorIndex test double (V01-R15): brute-force cosine similarity. It
// lives in testkit because product builds bind the empty index (ARCHITECTURE 2, 5.4).
import {
  StaleFenceError,
  type EmbeddingSpace,
  type IndexedRef,
  type VectorIndex,
  type VectorIndexStatus,
} from "@pki/contracts";

function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export class MemoryVectorIndex implements VectorIndex {
  #space: EmbeddingSpace | null = null;
  #applied: number | null = null;
  #vectors = new Map<IndexedRef, Float32Array>();
  /** Change sequence of each ref's last upsert or removal. */
  #marks = new Map<IndexedRef, number>();

  async status(): Promise<VectorIndexStatus> {
    return "ready";
  }

  async embeddingSpace() {
    return this.#space;
  }

  async appliedChangeSeq() {
    return this.#applied;
  }

  async reset(space: EmbeddingSpace) {
    this.#space = space;
    this.#applied = null;
    this.#vectors.clear();
    this.#marks.clear();
  }

  async upsert(items: readonly { ref: IndexedRef; vector: Float32Array }[], changeSeq: number) {
    for (const { vector } of items) this.#checkDimension(vector);
    this.#checkOrder(
      items.map((item) => item.ref),
      changeSeq,
    );
    for (const { ref, vector } of items) this.#vectors.set(ref, Float32Array.from(vector));
    this.#apply(
      items.map((item) => item.ref),
      changeSeq,
    );
  }

  async remove(refs: readonly IndexedRef[], changeSeq: number) {
    this.#checkOrder(refs, changeSeq);
    for (const ref of refs) this.#vectors.delete(ref);
    this.#apply(refs, changeSeq);
  }

  async search(query: Float32Array, k: number) {
    this.#checkDimension(query);
    return [...this.#vectors]
      .map(([ref, vector]) => ({ ref, score: cosine(query, vector) }))
      .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .slice(0, k);
  }

  #checkDimension(vector: Float32Array) {
    if (!this.#space) throw new Error("vector index has no embedding space; call reset first");
    if (vector.length !== this.#space.dimension) {
      throw new Error(`vector length ${vector.length} != dimension ${this.#space.dimension}`);
    }
  }

  #checkOrder(refs: readonly IndexedRef[], changeSeq: number) {
    for (const ref of refs) {
      const mark = this.#marks.get(ref);
      if (mark !== undefined && changeSeq < mark) {
        throw new StaleFenceError(`${ref}: change ${changeSeq} < applied ${mark}`);
      }
    }
  }

  #apply(refs: readonly IndexedRef[], changeSeq: number) {
    for (const ref of refs) this.#marks.set(ref, changeSeq);
    this.#applied = Math.max(this.#applied ?? changeSeq, changeSeq);
  }
}
