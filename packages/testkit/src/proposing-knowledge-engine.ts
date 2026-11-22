// A KnowledgeEngine test double with the propose capability (V02-C5 engine.swap):
// the memory engine plus, per source, the candidates `propose` derived from the
// version it last took. Removal and rebuild drop them with the rest, so a removed
// source's quotes are not left in it.
import type {
  ContextQuery,
  EngineSourceInput,
  KnowledgeCandidate,
  KnowledgeEngine,
  SourceVersionRef,
  VersionFence,
} from "@pki/contracts";
import { MemoryKnowledgeEngine } from "./memory-knowledge-engine.ts";

export type Proposer = (input: EngineSourceInput) => KnowledgeCandidate[];

export class ProposingKnowledgeEngine implements KnowledgeEngine {
  readonly id = "memory-proposing";
  readonly #memory = new MemoryKnowledgeEngine();
  readonly #propose: Proposer;
  #proposals = new Map<string, { version: number; candidates: KnowledgeCandidate[] }>();

  constructor(propose: Proposer) {
    this.#propose = propose;
  }

  capabilities() {
    return { ...this.#memory.capabilities(), propose: true };
  }

  health() {
    return this.#memory.health();
  }

  appliedChangeSeq() {
    return this.#memory.appliedChangeSeq();
  }

  async upsertSource(input: EngineSourceInput, fence: VersionFence, changeSeq: number) {
    await this.#memory.upsertSource(input, fence, changeSeq);
    this.#take(input);
  }

  async removeSource(ref: SourceVersionRef, fence: VersionFence, changeSeq: number) {
    await this.#memory.removeSource(ref, fence, changeSeq);
    const held = this.#proposals.get(ref.sourceId);
    if (held && held.version <= ref.version) this.#proposals.delete(ref.sourceId);
  }

  async proposeKnowledge(ref: SourceVersionRef): Promise<KnowledgeCandidate[]> {
    const held = this.#proposals.get(ref.sourceId);
    return held?.version === ref.version ? held.candidates : [];
  }

  relatedContext(query: ContextQuery) {
    return this.#memory.relatedContext(query);
  }

  async rebuild(sources: AsyncIterable<EngineSourceInput>, changeSeq: number) {
    this.#proposals.clear();
    const taken: EngineSourceInput[] = [];
    async function* tap() {
      for await (const input of sources) {
        taken.push(input);
        yield input;
      }
    }
    await this.#memory.rebuild(tap(), changeSeq);
    for (const input of taken) this.#take(input);
  }

  #take(input: EngineSourceInput) {
    this.#proposals.set(input.ref.sourceId, {
      version: input.ref.version,
      candidates: this.#propose(input),
    });
  }
}
