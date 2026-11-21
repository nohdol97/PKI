// Memory KnowledgeEngine test double (V01-R16): keeps each source's latest text and
// scores related context by shared words. Exists so engine.contract has something
// non-vacuous to run against; product builds bind the null engine (ADR 0003).
import {
  StaleFenceError,
  UnsupportedCapabilityError,
  type ContextHit,
  type ContextQuery,
  type EngineSourceInput,
  type KnowledgeEngine,
  type SourceVersionRef,
  type VersionFence,
} from "@pki/contracts";

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

interface SourceState {
  fence: number;
  removedThrough: number;
  current?: { version: number; words: Set<string> };
}

export class MemoryKnowledgeEngine implements KnowledgeEngine {
  readonly id = "memory";
  #applied: number | null = null;
  #sources = new Map<string, SourceState>();

  capabilities() {
    return { propose: false, relatedContext: true, spanEvidence: false, temporal: false };
  }

  async health() {
    return { state: "ready" } as const;
  }

  async appliedChangeSeq() {
    return this.#applied;
  }

  async upsertSource(input: EngineSourceInput, fence: VersionFence, changeSeq: number) {
    const state = this.#checkFence(input.ref.sourceId, fence);
    if (input.ref.version <= state.removedThrough) {
      throw new StaleFenceError(`${input.ref.sourceId} v${input.ref.version} was removed`);
    }
    state.fence = fence.version;
    state.current = { version: input.ref.version, words: words(`${input.title} ${input.body}`) };
    this.#applied = Math.max(this.#applied ?? changeSeq, changeSeq);
  }

  async removeSource(ref: SourceVersionRef, fence: VersionFence, changeSeq: number) {
    const state = this.#checkFence(ref.sourceId, fence);
    state.fence = fence.version;
    state.removedThrough = Math.max(state.removedThrough, ref.version);
    if (state.current && state.current.version <= ref.version) delete state.current;
    this.#applied = Math.max(this.#applied ?? changeSeq, changeSeq);
  }

  async proposeKnowledge(): Promise<never> {
    throw new UnsupportedCapabilityError("propose");
  }

  async relatedContext(query: ContextQuery): Promise<ContextHit[]> {
    const wanted = [...words(query.text)];
    const hits: ContextHit[] = [];
    for (const [sourceId, { current }] of this.#sources) {
      if (!current) continue;
      const score = wanted.filter((word) => current.words.has(word)).length;
      if (score > 0) hits.push({ ref: { sourceId, version: current.version }, score });
    }
    return hits
      .sort((a, b) => b.score - a.score || (a.ref.sourceId < b.ref.sourceId ? -1 : 1))
      .slice(0, query.limit);
  }

  async rebuild(sources: AsyncIterable<EngineSourceInput>, changeSeq: number) {
    this.#sources.clear();
    for await (const input of sources) {
      this.#sources.set(input.ref.sourceId, {
        fence: input.ref.version,
        removedThrough: 0,
        current: { version: input.ref.version, words: words(`${input.title} ${input.body}`) },
      });
    }
    this.#applied = changeSeq;
  }

  /** Version fence check (ADR 0013); the caller records the fence once the call is accepted. */
  #checkFence(sourceId: string, fence: VersionFence) {
    const state = this.#sources.get(sourceId) ?? { fence: 0, removedThrough: 0 };
    if (fence.version < state.fence) {
      throw new StaleFenceError(`${sourceId}: fence v${fence.version} < v${state.fence}`);
    }
    this.#sources.set(sourceId, state);
    return state;
  }
}
