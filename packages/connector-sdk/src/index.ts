// @pki/connector-sdk: shared helpers for whoever builds or runs a Connector. A pure
// library outside the adapter boundary: it implements no Connector and imports only
// @pki/contracts, zod and the node: modules of the allow-list (I01-R24, R28).
export {
  INSTANCE_BUSY_RETRY_MS,
  SYNC_OUTCOMES,
  type SyncEnd,
  type SyncOutcomeRow,
} from "./sync-outcomes.ts";
export {
  changeKindOf,
  expectedContent,
  JSONL_CAPABILITIES,
  JSONL_IMPORT_KIND,
  MAX_JSONL_BYTES,
  MAX_JSONL_DEPTH,
  MAX_JSONL_LINE_CHARS,
  parseJsonl,
  placeOf,
  recordToChange,
  type JsonlLine,
  type JsonlRejection,
  type ParseOptions,
} from "./jsonl.ts";
