// KnowledgeEngine adapter (ARCHITECTURE 5.3, V01-R16, ADR 0003). An engine only
// proposes candidates and finds related context; the product decides what is
// recorded. Phase 1 binds the null implementation.
import type { ComponentStatus } from "./index.ts";

export interface SourceVersionRef {
  readonly sourceId: string;
  readonly version: number;
}

/** The latest canonical version of the notified source when the notification was issued. */
export interface VersionFence {
  readonly version: number;
}

export interface EngineSourceInput {
  readonly ref: SourceVersionRef;
  readonly title: string;
  readonly body: string;
}

/** An item a candidate names: an existing item's ID (one the product offered as a candidate), or a new one. */
export interface ProposedItem {
  readonly type: string;
  readonly name: string;
  readonly existingItemId: string | null;
}

/**
 * A fact or relation an engine proposes for one source version (V02-R13), in the
 * names of the extraction schema (V02 "추출 응답의 모양"). Untrusted like an LLM
 * answer: the product checks it against that schema and keeps it only with a
 * quote the version's body holds exactly once (V02-R6), as a candidate.
 */
export type KnowledgeCandidate =
  | {
      readonly kind: "fact";
      readonly ref: SourceVersionRef;
      readonly item: ProposedItem;
      readonly factKind: string;
      readonly value: string;
      readonly epistemic: string;
      readonly quote: string;
    }
  | {
      readonly kind: "relation";
      readonly ref: SourceVersionRef;
      readonly subject: ProposedItem;
      readonly type: string;
      readonly object: ProposedItem;
      readonly quote: string;
    };

export interface ContextQuery {
  readonly text: string;
  readonly limit: number;
}

/** Results carry canonical references, never engine-private IDs. */
export interface ContextHit {
  readonly ref: SourceVersionRef;
  readonly score: number;
}

export interface EngineCapabilities {
  readonly propose: boolean;
  readonly relatedContext: boolean;
  readonly spanEvidence: boolean;
  readonly temporal: boolean;
}

/**
 * Fences (ADR 0013): per source the engine remembers the highest fence version it
 * accepted and the version a removal covered. upsertSource/removeSource with a lower
 * fence, or an upsert of a version at or below a removal, rejects with StaleFenceError
 * and changes nothing. Methods whose capability is false reject with
 * UnsupportedCapabilityError.
 */
export interface KnowledgeEngine {
  readonly id: string;
  capabilities(): EngineCapabilities;
  health(): Promise<ComponentStatus>;
  /** Last canonical change sequence the engine applied; null if none. */
  appliedChangeSeq(): Promise<number | null>;
  upsertSource(input: EngineSourceInput, fence: VersionFence, changeSeq: number): Promise<void>;
  /** Removes everything derived from versions up to ref.version of that source. */
  removeSource(ref: SourceVersionRef, fence: VersionFence, changeSeq: number): Promise<void>;
  proposeKnowledge(ref: SourceVersionRef): Promise<KnowledgeCandidate[]>;
  relatedContext(query: ContextQuery): Promise<ContextHit[]>;
  /** Drops all engine state, ingests the canonical sources, then reports changeSeq as applied. */
  rebuild(sources: AsyncIterable<EngineSourceInput>, changeSeq: number): Promise<void>;
}
