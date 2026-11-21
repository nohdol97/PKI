export type { OpenSqlDriver, RunResult, SqlDriver, SqlRow, SqlValue } from "./sql-driver.ts";
export { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
export { migrate, migrations, schemaVersion, type Migration } from "./migrations.ts";
export { searchKeyword } from "./keyword-search.ts";
export {
  dataDirectory,
  ensureDataDirectory,
  resolveDataDirectory,
  type DataDirectoryInput,
} from "./data-directory.ts";
export { EmptyVectorIndex } from "./empty-vector-index.ts";
export {
  contentHash,
  readCursor,
  registerConnectorInstance,
  saveSourceRecord,
  writeCursor,
  type StoredRecord,
} from "./sources.ts";
