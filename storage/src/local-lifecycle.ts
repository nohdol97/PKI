// The state changes of an approved location (I02B-R7, R10; F1 of #19), the one module that makes them.
// A location read again (resumed, back from `unavailable`, relinked) is reconciled against the sources in
// the same transaction: the connector's cursor is one number over all locations, so an entry it passed
// over while the location was closed is given a new sequence number and is announced by the ordinary read.
import {
  LOCAL_FILES_INSTANCE_ID,
  readLocation,
  setLocationState,
  takeLocalSeq,
  type LocationState,
} from "./local-files.ts";
import { findSourceId, readLastRevision } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { readTombstoneState } from "./tombstones.ts";

/** Moves a location to a state other than `active` (which is `reopenLocation`'s); false when there is no such location. */
export function closeLocation(
  db: SqlDriver,
  id: string,
  state: Exclude<LocationState, "active">,
  reason: string | null,
): boolean {
  return setLocationState(db, id, state, reason);
}

/** Whether a tombstone still blocks the source's arrivals. */
const blocked = (db: SqlDriver, sourceId: number): boolean => {
  const tombstone = readTombstoneState(db, sourceId);
  return tombstone !== undefined && tombstone.liftedAt === null;
};

/**
 * The location is read again. Entries the sources are behind on (no source, or a last revision below the
 * entry's) and deletions whose source still lives get a new sequence number from the counter, so they
 * come after the cursor again; an entry already announced keeps its number.
 */
export function reopenLocation(db: SqlDriver, id: string, reason: string | null = null): boolean {
  return db.transaction(
    () => {
      if (!setLocationState(db, id, "active", reason)) return false;
      const rows = db.all(
        `SELECT external_id, revision, state FROM local_file_entries
         WHERE location_id = ? AND pending_delete = 0
           AND ((state = 'present' AND mtime_ns IS NOT NULL) OR state = 'deleted')
         ORDER BY seq`,
        [id],
      );
      for (const row of rows) {
        const externalId = row.external_id as string;
        const sourceId = findSourceId(db, LOCAL_FILES_INSTANCE_ID, id, externalId);
        const owed =
          row.state === "deleted"
            ? sourceId !== undefined && !blocked(db, sourceId)
            : sourceId === undefined ||
              (!blocked(db, sourceId) &&
                (readLastRevision(db, sourceId) ?? 0) < (row.revision as number));
        if (owed) {
          db.run("UPDATE local_file_entries SET seq = ? WHERE external_id = ?", [
            takeLocalSeq(db),
            externalId,
          ]);
        }
      }
      return true;
    },
    { immediate: true },
  );
}

/** The folder a relink gives the location (I02B-R9): what the user chose and what the OS resolved. */
export interface RelinkTarget {
  displayPath: string;
  realPath: string;
  rootDev: string;
  rootIno: string;
}

/**
 * The location is the folder `target` now, under the same id: the path and identity are written, held
 * deletions are let go (the next pass judges them again against the new folder) and the location is
 * read again. False when there is no such location.
 */
export function relinkLocation(db: SqlDriver, id: string, target: RelinkTarget): boolean {
  return db.transaction(
    () => {
      const changed = db.run(
        "UPDATE local_locations SET display_path = ?, real_path = ?, root_dev = ?, root_ino = ? WHERE id = ?",
        [target.displayPath, target.realPath, target.rootDev, target.rootIno, id],
      ).changes;
      if (changed !== 1) return false;
      db.run(
        "UPDATE local_file_entries SET pending_delete = 0 WHERE location_id = ? AND pending_delete = 1",
        [id],
      );
      return reopenLocation(db, id);
    },
    { immediate: true },
  );
}

export type ConfirmResult =
  { ok: true; confirmed: number } | { ok: false; reason: "count-mismatch" };

/**
 * The user confirms the held deletions (I02B-R8) having seen `expectedCount` of them: the held entries
 * are marked confirmed, each with a new sequence number so a pass running now loses its fence on them,
 * and a location waiting for the confirmation is `active` again. A different count changes nothing.
 */
export function confirmDeletions(db: SqlDriver, id: string, expectedCount: number): ConfirmResult {
  return db.transaction(
    () => {
      const rows = db.all(
        "SELECT external_id FROM local_file_entries WHERE location_id = ? AND pending_delete = 1 ORDER BY seq",
        [id],
      );
      if (rows.length !== expectedCount) return { ok: false, reason: "count-mismatch" };
      for (const row of rows) {
        db.run("UPDATE local_file_entries SET pending_delete = 2, seq = ? WHERE external_id = ?", [
          takeLocalSeq(db),
          row.external_id as string,
        ]);
      }
      if (readLocation(db, id)?.state === "needs-confirmation") {
        setLocationState(db, id, "active", null);
      }
      return { ok: true, confirmed: rows.length };
    },
    { immediate: true },
  );
}

/** The sources of the location that are still whole: plain identity, in its namespace (a purged source's identity is hashed). */
export function liveSourceCount(db: SqlDriver, id: string): number {
  return Number(
    db.all(
      "SELECT count(*) AS n FROM sources WHERE connector_instance_id = ? AND namespace = ? AND identity_hashed = 0",
      [LOCAL_FILES_INSTANCE_ID, id],
    )[0]?.n,
  );
}

export interface RevokeBatchResult {
  deleted: number;
  /** Live sources of the location after the batch. */
  remaining: number;
  /** Nothing was left alive: the location's rows are gone with this batch. */
  done: boolean;
}

/**
 * One batch of a revocation (I02B-R10, R49), inside the caller's canonical transaction: up to `max`
 * live sources are deleted by the user's deletion (`deleteSource`, the entry that queues the ledger
 * line) and their index rows go. When none is left alive, the remaining index rows and the location
 * row go in the same transaction; otherwise the location is `revoking`. Nothing here commits: a
 * refusing ledger rolls the whole batch back.
 */
export function revokeBatch(
  tx: SqlDriver,
  id: string,
  max: number,
  deleteSource: (identity: {
    connectorInstanceId: string;
    namespace: string;
    externalId: string;
  }) => void,
): RevokeBatchResult {
  const batch = tx.all(
    `SELECT external_id FROM sources
     WHERE connector_instance_id = ? AND namespace = ? AND identity_hashed = 0 ORDER BY id LIMIT ?`,
    [LOCAL_FILES_INSTANCE_ID, id, max],
  );
  for (const row of batch) {
    const externalId = row.external_id as string;
    deleteSource({ connectorInstanceId: LOCAL_FILES_INSTANCE_ID, namespace: id, externalId });
    tx.run("DELETE FROM local_file_entries WHERE location_id = ? AND external_id = ?", [
      id,
      externalId,
    ]);
  }
  const remaining = liveSourceCount(tx, id);
  const done = remaining === 0;
  if (done) {
    tx.run("DELETE FROM local_file_entries WHERE location_id = ?", [id]);
    tx.run("DELETE FROM local_locations WHERE id = ?", [id]);
  } else {
    setLocationState(tx, id, "revoking", null);
  }
  return { deleted: batch.length, remaining, done };
}
