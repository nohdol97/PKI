// Adapter implementations of this package. Only the composition root imports
// this entry (module-boundary, V01-T07); upper code uses the ports in "@pki/storage".
export { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
export { EmptyVectorIndex } from "./empty-vector-index.ts";
