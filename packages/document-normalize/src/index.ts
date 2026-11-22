// Public entry of @pki/document-normalize (I02A).
export { DEFAULT_LIMITS } from "./limits.ts";
export type { Limits, PartialLimits } from "./limits.ts";
export { normalizeDocument } from "./normalize.ts";
export { codePointSlice } from "./text-builder.ts";
export { DOCUMENT_FORMATS, LIMITATION_CODES, NORMALIZE_ERROR_CODES } from "./types.ts";
export type {
  BinaryFormatModule,
  Block,
  DocumentFormat,
  DocumentMetadata,
  EncodingInfo,
  FormatModule,
  FormatResult,
  Limitation,
  LimitationCode,
  Locator,
  NormalizedDocument,
  NormalizeError,
  NormalizeErrorCode,
  NormalizeInput,
  NormalizeOptions,
  NormalizeResult,
  ParsedDocument,
  TextFormatModule,
} from "./types.ts";
export { NORMALIZER_VERSION } from "./version.ts";
export { createIsolatedNormalizer } from "./isolated.ts";
export type {
  HostHandle,
  HostSpawner,
  IsolatedError,
  IsolatedErrorCode,
  IsolatedNormalizer,
  IsolatedNormalizerOptions,
  IsolatedResult,
} from "./isolated.ts";
export { createForkSpawner } from "./spawn-node.ts";
// inputs for the tests of the isolated normalizer (I02B-R25): slow and heavy documents rebuilt on demand
export { BOMB, makePdfBomb, makeSlowMarkdown, makeTriggerXlsx } from "./testing/time-bombs.ts";
