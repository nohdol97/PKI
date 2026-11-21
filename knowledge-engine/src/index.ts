export {
  COMPLETION_DATE,
  DEPENDENCY_DELAY,
  DEPENDS_ON,
  TARGET_DATE,
  recomputeDependencyDelay,
  type RuleOutcome,
} from "./dependency-delay.ts";
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
