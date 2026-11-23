// The data-folder lock (R04L, spec 2026-11-23-R04-data-dir-lock): one shell per data
// folder, whatever its userData. SQLite's exclusive lock on instance.lock is an OS file
// lock, so a holder that dies (even by SIGKILL) frees it and no stale-lock guess is needed.
import { ensureDataDirectory } from "@pki/storage";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const DATA_LOCK_FILE = "instance.lock";
export const DATA_IN_USE = "PKI: this data folder is already in use by another running PKI";

const SQLITE_BUSY = 5;

export interface DataLock {
  /** Frees the lock early; the shell never calls this (the OS frees it at exit). */
  close(): void;
}

/**
 * Takes the lock on `dir` (created owner-only if missing). Returns undefined when another
 * live process holds it; any other failure throws. Keep the returned value referenced for
 * the life of the process: closing or collecting the connection frees the lock.
 */
export function lockDataDirectory(dir: string): DataLock | undefined {
  ensureDataDirectory(dir);
  const db = new DatabaseSync(join(dir, DATA_LOCK_FILE));
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  return { close: () => db.close() };
}
