export type { OpenSqlDriver, RunResult, SqlDriver, SqlRow, SqlValue } from "./sql-driver.ts";
export { migrate, migrations, schemaVersion, type Migration } from "./migrations.ts";
export { searchKeyword } from "./keyword-search.ts";
export {
  findSources,
  insertProviderCall,
  listProviderCalls,
  listSources,
  type ProviderCallRow,
} from "./listing.ts";
export { deleteConsent, readConsent, saveConsent, type StoredConsent } from "./consents.ts";
export { readSetting, writeSetting } from "./settings.ts";
export { databaseEncryption } from "./database-encryption.ts";
export {
  dataDirectory,
  ensureDataDirectory,
  resolveDataDirectory,
  type DataDirectoryInput,
} from "./data-directory.ts";
export {
  contentHash,
  findSourceVersionId,
  readConnectorKind,
  readCursor,
  readSourceVersion,
  registerConnectorInstance,
  saveSourceRecord,
  writeCursor,
  type SaveOutcome,
  type StoredRecord,
  type StoredSourceVersion,
} from "./sources.ts";
export {
  closeJob,
  isFenceCurrent,
  isReasonCode,
  JobWriteError,
  leaseNextJob,
  readExtractionDrops,
  readJob,
  recordExtractionDrops,
  registerJob,
  requeueHeldJobs,
  type ExtractionDrops,
  type JobClosing,
  type JobStatus,
  type LeaseRequest,
  type NewJob,
  type StoredJob,
} from "./jobs.ts";
export {
  addEvidence,
  insertItem,
  listEvidence,
  readFact,
  readItem,
  readRelation,
  reviveSuperseded,
  saveFact,
  saveRelation,
  setKnowledgeStatus,
  supersedeUnsupported,
  type EpistemicType,
  type EvidenceTarget,
  type KnowledgeAttributes,
  type KnowledgeStatus,
  type NewEvidence,
  type NewFact,
  type NewItem,
  type NewRelation,
  type StoredEvidence,
  type StoredFact,
  type StoredItem,
  type StoredRelation,
} from "./knowledge.ts";
export {
  findRelation,
  listFactsOfKind,
  listInsightKeys,
  listRelationPairs,
  readInsight,
  saveInsight,
  type InsightContent,
  type InsightKey,
  type StoredInsight,
} from "./insights.ts";
export { readTombstone, writeTombstone, type Tombstone } from "./tombstones.ts";
export { readChangeSeq, readKnowledgeRevision } from "./revisions.ts";
export { listItemEvidenceVersions, listItemNames } from "./candidates.ts";
export {
  listActiveInsights,
  readEvidenceSource,
  readInsightEvidence,
  type ActiveInsight,
  type EvidenceSourceView,
  type InsightEvidenceRow,
} from "./evidence-view.ts";
