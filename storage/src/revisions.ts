// The two sequence numbers of schema v5 (ADR 0013 decision 6, V02-R3). Triggers
// raise both inside the writing transaction; code only reads them.
import type { SqlDriver } from "./sql-driver.ts";

const read = (db: SqlDriver, column: "change_seq" | "knowledge_revision"): number =>
  db.all(`SELECT ${column} FROM revisions`)[0]?.[column] as number;

/** Raised once per new source version, new tombstone and moved tombstone cover; projections compare it. */
export const readChangeSeq = (db: SqlDriver): number => read(db, "change_seq");

/**
 * Raises the change sequence for a change no trigger sees: the deletion of a source's earlier
 * versions (I04-T12). Call it before registering the removals, as the tombstone's trigger does,
 * so a rebuild that read the store before the change cannot close them.
 */
export const raiseChangeSeq = (db: SqlDriver): void => {
  db.run("UPDATE revisions SET change_seq = change_seq + 1");
};

/** Raised once per changed item, fact or relation row. Phase 1 has no reader. */
export const readKnowledgeRevision = (db: SqlDriver): number => read(db, "knowledge_revision");
