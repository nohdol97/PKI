// The two sequence numbers of schema v5 (ADR 0013 decision 6, V02-R3). Triggers
// raise both inside the writing transaction; code only reads them.
import type { SqlDriver } from "./sql-driver.ts";

const read = (db: SqlDriver, column: "change_seq" | "knowledge_revision"): number =>
  db.all(`SELECT ${column} FROM revisions`)[0]?.[column] as number;

/** Raised once per new source version and per tombstone written; projections compare it. */
export const readChangeSeq = (db: SqlDriver): number => read(db, "change_seq");

/** Raised once per changed item, fact or relation row. Phase 1 has no reader. */
export const readKnowledgeRevision = (db: SqlDriver): number => read(db, "knowledge_revision");
