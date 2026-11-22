export {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
  type RuleOutcome,
} from "./dependency-delay.ts";
export { acceptChange, type Accepted, type AcceptOptions } from "./arrival.ts";
export { applyTombstone, liftTombstone } from "./tombstone-entry.ts";
export {
  CANONICAL_KINDS,
  createProductRegistry,
  derivativeRegistry,
  NO_POLICY_YET,
  type CanonicalReport,
} from "./canonical-kinds.ts";
export { createCanonicalEntries, defaultEntries, type CanonicalEntries } from "./entries.ts";
export {
  ENGINE_KIND,
  projectionKinds,
  projectionRowId,
  VECTOR_KIND,
  type PermanentlyAbsent,
} from "./projection-kinds.ts";
export {
  createExtractHandler,
  EXTRACT_HOLD_TOO_LARGE,
  EXTRACT_TIMEOUT_MS,
  MAX_EXTRACT_CODE_POINTS,
  type ExtractHandlerOptions,
  type ExtractResult,
} from "./extraction.ts";
export { findCandidates, knowledgeCandidates, normalizeForLinking } from "./linking.ts";
export { locateQuote, type QuoteDrop, type QuoteSpan } from "./quote.ts";
export { propagateNewVersion, type Propagation } from "./propagation.ts";
export {
  createProjections,
  PROJECTION_STALE_SETTINGS,
  userDelete,
  latestSources,
  vectorRefOf,
  versionNotice,
  type ProjectionName,
  type ProjectionNotice,
  type Projections,
  type ProjectionsOptions,
  type ReconcileOutcome,
} from "./projections.ts";
