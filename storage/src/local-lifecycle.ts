// The state changes of an approved location (I02B-R7, R10; F1 of #19), the one module that makes them.
// A location read again (resumed, back from `unavailable`, relinked) is reconciled against the sources in
// the same transaction: the connector's cursor is one number over all locations, so an entry it passed
// over while the location was closed is given a new sequence number and is announced by the ordinary read.
import {
  LOCAL_FILES_INSTANCE_ID,
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
