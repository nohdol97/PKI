// Memory VectorIndex test double (V01-R15): brute-force cosine similarity. It
// lives in testkit because product builds bind the empty index (ARCHITECTURE 2, 5.4).
// Generations follow the contract in @pki/contracts (H01C3-R2): one active, one being built.
import {
  AdapterUnavailableError,
  StaleFenceError,
  type EmbeddingSpace,
  type IndexedRef,
  type VectorIndex,
  type VectorIndexStatus,
  type VectorRebuild,
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

class Generation {
  applied: number | null = null;
  readonly vectors = new Map<IndexedRef, Float32Array>();
  /** Change sequence of each ref's last upsert or removal. */
  readonly marks = new Map<IndexedRef, number>();
  readonly space: EmbeddingSpace;
  constructor(space: EmbeddingSpace) {
    this.space = space;
  }

  checkDimension(vector: Float32Array) {
    if (vector.length !== this.space.dimension) {
      throw new Error(`vector length ${vector.length} != dimension ${this.space.dimension}`);
    }
  }

  checkOrder(refs: readonly IndexedRef[], changeSeq: number) {
    for (const ref of refs) {
      const mark = this.marks.get(ref);
      if (mark !== undefined && changeSeq < mark) {
        throw new StaleFenceError(`${ref}: change ${changeSeq} < applied ${mark}`);
      }
    }
  }

  apply(refs: readonly IndexedRef[], changeSeq: number) {
    for (const ref of refs) this.marks.set(ref, changeSeq);
    this.applied = Math.max(this.applied ?? changeSeq, changeSeq);
  }

  upsert(items: readonly { ref: IndexedRef; vector: Float32Array }[], changeSeq: number) {
    for (const { vector } of items) this.checkDimension(vector);
    const refs = items.map((item) => item.ref);
    this.checkOrder(refs, changeSeq);
    for (const { ref, vector } of items) this.vectors.set(ref, Float32Array.from(vector));
    this.apply(refs, changeSeq);
  }
}

export class MemoryVectorIndex implements VectorIndex {
  #active: Generation | null = null;
  #building: Generation | null = null;

  async status(): Promise<VectorIndexStatus> {
    if (this.#active) return "ready";
    return this.#building ? "rebuilding" : { unavailable: "no vector generation" };
  }

  async embeddingSpace() {
    return this.#active?.space ?? null;
  }

  async appliedChangeSeq() {
    return this.#active?.applied ?? null;
  }

  async beginRebuild(space: EmbeddingSpace): Promise<VectorRebuild> {
    const generation = new Generation(space);
    this.#building = generation;
    const live = () => {
      if (this.#building !== generation) throw new Error("this build is no longer the current one");
      return generation;
    };
    return {
      refs: async () => [...live().vectors.keys()].sort(),
      upsert: async (items, changeSeq) => live().upsert(items, changeSeq),
      activate: async (expectedRefs, appliedChangeSeq) => {
        const building = live();
        const expected = new Set(expectedRefs);
        if (
          expected.size !== building.vectors.size ||
          [...building.vectors.keys()].some((ref) => !expected.has(ref))
        ) {
          throw new Error("the building generation's refs differ from the expected ones");
        }
        building.applied = appliedChangeSeq;
        this.#active = building;
        this.#building = null;
      },
      discard: async () => {
        if (this.#building === generation) this.#building = null;
      },
    };
  }

  async upsert(items: readonly { ref: IndexedRef; vector: Float32Array }[], changeSeq: number) {
    this.#requireActive().upsert(items, changeSeq);
  }

  async remove(refs: readonly IndexedRef[], changeSeq: number) {
    const generations = [this.#active, this.#building].filter((g) => g !== null);
    for (const generation of generations) generation.checkOrder(refs, changeSeq);
    for (const generation of generations) {
      for (const ref of refs) generation.vectors.delete(ref);
      generation.apply(refs, changeSeq);
    }
  }

  async search(query: Float32Array, k: number) {
    const active = this.#requireActive();
    active.checkDimension(query);
    return [...active.vectors]
      .map(([ref, vector]) => ({ ref, score: cosine(query, vector) }))
      .sort((a, b) => b.score - a.score || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
      .slice(0, k);
  }

  #requireActive() {
    if (!this.#active) throw new AdapterUnavailableError("no active vector generation");
    return this.#active;
  }
}

/** What the old `reset(space)` left: an empty active generation in `space` (for tests that seed an index). */
export async function activateEmpty(index: VectorIndex, space: EmbeddingSpace) {
  await (await index.beginRebuild(space)).activate([], null);
}
