// The backend lock (P7F-R1, R2; spec 2026-11-24-P7-followups): the one backend process on a data
// folder holds an OS file lock on `backend.lock` for its life, the technique of the shell's
// instance.lock (apps/desktop/src/data-lock.ts, R04L): SQLite's exclusive lock, never waited
// for, freed by the OS when the holder dies, even by SIGKILL. A start that obtains it knows no
// live backend runs on the folder, so what is left `running` is a dead backend's and is
// reclaimed at once instead of at its lease end. A start that does not obtain it changes nothing.
// Like the shell's, the lock is only real after a write attempt (a read-only file is not a lock,
// LKH-R2) and the connection is held strongly inside the module until close() (LKH-R3).
import { ensureDataDirectory, reclaimLeases, type SqlDriver } from "@pki/storage";
import { errorClass, log } from "@pki/providers";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const BACKEND_LOCK_FILE = "backend.lock";

const SQLITE_BUSY = 5;

/** Strong references until close(): a lock must not depend on the caller keeping its value (LKH-R3). */
const held = new Set<DatabaseSync>();

export interface BackendLock {
  /** Frees the lock: on close and on a failed start; the OS frees it at process end. */
  close(): void;
}

/**
 * Takes the lock on `dataDir`. Undefined when a live backend holds it, and for any other
 * failure too (one fixed log line, the error class only): a start never stops for the lock.
 */
export function takeBackendLock(dataDir: string): BackendLock | undefined {
  try {
    ensureDataDirectory(dataDir);
    const db = new DatabaseSync(join(dataDir, BACKEND_LOCK_FILE));
    try {
      db.exec("BEGIN EXCLUSIVE");
      // write probe, never committed (LKH-R2): a read-only file is opened read-only and grants
      // BEGIN EXCLUSIVE without a lock; the failed write sends it down the "not obtained" path
      db.exec("PRAGMA user_version = 1");
    } catch (error) {
      db.close();
      if ((error as { errcode?: number }).errcode === SQLITE_BUSY) return undefined;
      throw error;
    }
    held.add(db);
    return {
      close: () => {
        held.delete(db);
        if (db.isOpen) db.close(); // closing twice is harmless: close and a failed start both call it
      },
    };
  } catch (error) {
    log("backend-lock-unavailable", { error: errorClass(error) });
    return undefined;
  }
}

/**
 * Reclaims every `running` job whatever its lease end says (the restore finish's call,
 * restore-boot.ts finishRestore): cancelled, retry or queued, attempts kept, lease token raised.
 * Only for a start that holds the backend lock.
 */
export function reclaimAtStart(db: SqlDriver, now: Date): number {
  const kinds = db.all("SELECT DISTINCT kind FROM jobs WHERE status = 'running'");
  return reclaimLeases(db, {
    kinds: kinds.map((row) => row.kind as string),
    now,
    leaseMs: 60_000, // unused with ignoreExpiry; a real length keeps the clock-regression branch out of it
    ignoreExpiry: true,
  });
}
