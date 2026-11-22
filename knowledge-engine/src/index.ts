export {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  isDate,
  TARGET_DATE,
  recomputeDependencyDelay,
  type RuleOutcome,
  type RuleScope,
} from "./dependency-delay.ts";
export { acceptChange, type Accepted, type AcceptOptions } from "./arrival.ts";
export { applyTombstone, liftTombstone } from "./tombstone-entry.ts";
export {
  createLedgerReapply,
  reapplyLedger,
  LedgerNotAttachedError,
  LedgerReapplyError,
  type LedgerReapply,
  type ReapplyReport,
} from "./ledger-reapply.ts";
export {
  CANONICAL_KINDS,
  canonicalKinds,
  createProductRegistry,
  derivativeRegistry,
  RECOMPUTE_PREFIX,
  type CanonicalReport,
} from "./canonical-kinds.ts";
export { createCanonicalEntries, defaultEntries, type CanonicalEntries } from "./entries.ts";
export { ENGINE_KIND, VECTOR_KIND, type PermanentlyAbsent } from "./projection-kinds.ts";
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
  vectorRefOf,
  versionNotice,
  type ProjectionName,
  type ProjectionNotice,
  type Projections,
  type ProjectionsOptions,
  type ReconcileOutcome,
} from "./projections.ts";
