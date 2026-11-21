export {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
  type RuleOutcome,
} from "./dependency-delay.ts";
export { deleteSource, type DeletionRequest, type SourceDeletion } from "./deletion.ts";
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
  deleteSourceWithNotice,
  PROJECTION_STALE_SETTINGS,
  vectorRefOf,
  versionNotice,
  type ProjectionName,
  type ProjectionNotice,
  type Projections,
  type ProjectionsOptions,
  type ReconcileOutcome,
} from "./projections.ts";
