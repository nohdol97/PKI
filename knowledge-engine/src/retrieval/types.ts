// The shapes of `retrieve` (X01-R1~R7). A strategy ranks source versions; a hit is one source version.
import type { EmbeddingProvider, VectorIndex } from "@pki/contracts";

/** X01-R1: the strategies, one constant. `rerank` is the merge (R3) and `metadata` filters; neither ranks on its own. */
export const STRATEGIES = [
  "keyword",
  "metadata",
  "concept",
  "graph",
  "temporal",
  "wiki",
  "vector",
  "rerank",
] as const;
export type StrategyName = (typeof STRATEGIES)[number];

/** X01-R5: always on, whatever list is given. */
export const ALWAYS_ON: readonly StrategyName[] = ["keyword", "metadata", "rerank"];

/**
 * X01-R5, D8: the strategies on by default. ADR 0025 (the X01-T4 measurement) turned on none of the others, so it is
 * the always-on ones; a strategy is added only with a measurement that meets the keep rule and the ADR's list in the
 * same commit (a test compares them). Not settable by a request.
 */
export const DEFAULT_ENABLED_STRATEGIES: readonly StrategyName[] = ALWAYS_ON;

/** X01-D7 (provisional): the constant of the rank-reciprocal sum, the hits kept, one strategy's list, a hit's related links. */
export const RRF_K = 60;
export const HIT_LIMIT = 20;
export const STRATEGY_LIST_LIMIT = 50;
export const RELATED_LIMIT = 5;

/** The request's filter fields (R1 `metadata`): collector instances, and the origin system's time range (inclusive, ISO 8601). */
export interface RetrievalConditions {
  connectorIds?: readonly string[] | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** R2: what each strategy did. `used` carries the size of its list (for `metadata`, the hits it removed). */
export type RouteEntry =
  | { status: "used"; count: number }
  | { status: "skipped" | "off" }
  | { status: "unavailable"; reason: string };
export type Route = Record<StrategyName, RouteEntry>;

/** R7: an item the hit's source supports, with the item's Wiki page when there is a shown one. */
export interface RelatedLink {
  itemId: number;
  name: string;
  wikiKey: string | null;
  wikiTitle: string | null;
}

export interface Hit {
  /** The `source_versions` row id; the registry names it `{ kind: "source", id }`. */
  versionId: number;
  sourceId: number;
  version: number;
  /** 1-based, after the merge and the preference weight. */
  rank: number;
  score: number;
  /** The strategies whose list held it, in STRATEGIES order. */
  strategies: readonly StrategyName[];
  related: readonly RelatedLink[];
}

/**
 * R6: a mark on a hit; it names only the hit's source version. `insufficient` has no target: no hit is left that
 * the search purpose shows. The notes are computed from the hits shown for a search; a caller that removes more
 * hits at its own boundary removes their notes too.
 */
export type GapNote = { kind: "insufficient" } | { kind: "conflict" | "stale"; versionId: number };

/** R4: the read-only preference signal. It gets the identity of a hit and nothing to write with. */
export interface PreferenceSignal {
  /** A positive weight multiplied into the merged score; anything else counts as 1. */
  weight(hit: { versionId: number; sourceId: number; version: number }): number;
}
export const NO_PREFERENCE: PreferenceSignal = { weight: () => 1 };

/** R1 `vector`: the two adapters, called as they are; nothing here indexes. */
export interface VectorDeps {
  embedding: Pick<EmbeddingProvider, "status" | "embed">;
  index: Pick<VectorIndex, "status" | "search">;
}

export interface RetrieveOptions {
  /** R5: the strategies to run (the always-on ones are added). The default is DEFAULT_ENABLED_STRATEGIES. Only the evaluation runner passes another. */
  enabled?: readonly StrategyName[] | undefined;
  preference?: PreferenceSignal | undefined;
  vector?: VectorDeps | undefined;
  signal?: AbortSignal | undefined;
}

export interface RetrievalResult {
  route: Route;
  hits: Hit[];
  notes: GapNote[];
}
