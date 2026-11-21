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
  readCursor,
  readSourceVersion,
  registerConnectorInstance,
  saveSourceRecord,
  writeCursor,
  type StoredRecord,
  type StoredSourceVersion,
} from "./sources.ts";
export {
  closeJob,
  isFenceCurrent,
  leaseNextJob,
  readJob,
  registerJob,
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
  saveFact,
  saveRelation,
  setKnowledgeStatus,
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
