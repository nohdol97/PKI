// The data-folder lock (R04L, spec 2026-11-23-R04-data-dir-lock): one shell per data
// folder, whatever its userData. SQLite's exclusive lock on instance.lock is an OS file
// lock, so a holder that dies (even by SIGKILL) frees it and no stale-lock guess is needed.
// "Obtained" means the lock file was also written to (LKH-R1, spec 2026-11-24-LKH-lock-hardening):
// a read-only file is no lock. The module keeps the connection until close() (LKH-R3).
import { ensureDataDirectory } from "@pki/storage";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const DATA_LOCK_FILE = "instance.lock";
export const DATA_IN_USE = "PKI: this data folder is already in use by another running PKI";

const SQLITE_BUSY = 5;

/** Strong references until close(): a lock must not depend on the caller keeping its value (LKH-R3). */
const held = new Set<DatabaseSync>();

export interface DataLock {
  /** Frees the lock early; the shell never calls this (the OS frees it at exit). */
  close(): void;
}

/**
 * Takes the lock on `dir` (created owner-only if missing). Returns undefined when another
 * live process holds it; any other failure throws, a lock file that cannot be written
 * included (SQLite opens a read-only file read-only and grants BEGIN EXCLUSIVE without any
 * lock, so the write probe below is what makes "obtained" true; LKH-R1). The module holds the
 * connection until close() or process end, whatever the caller does with the value (LKH-R3).
 */
export function lockDataDirectory(dir: string): DataLock | undefined {
  ensureDataDirectory(dir);
  const db = new DatabaseSync(join(dir, DATA_LOCK_FILE));
  try {
    db.exec("BEGIN EXCLUSIVE");
    db.exec("PRAGMA user_version = 1"); // write probe, never committed: close or death rolls it back
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  held.add(db);
  return {
    close: () => {
      held.delete(db);
      if (db.isOpen) db.close();
    },
  };
}

/**
 * The shell's start decision (LKH-R4), apart from Electron so a test can drive it: works out
 * the data folder and locks it. A location that cannot be worked out, a folder in use and a
 * lock that cannot be taken each give the one line for standard error; the shell then exits 1.
 */
export function openDataFolder(
  resolve: () => string,
  lock: (dir: string) => DataLock | undefined = lockDataDirectory,
): { dir: string; lock: DataLock } | { line: string } {
  let dir: string;
  try {
    dir = resolve();
  } catch (error) {
    return { line: `PKI: could not work out the data folder: ${(error as Error).message}` };
  }
  try {
    const taken = lock(dir);
    return taken === undefined ? { line: DATA_IN_USE } : { dir, lock: taken };
  } catch (error) {
    return { line: `PKI: could not lock the data folder: ${(error as Error).message}` };
  }
}
