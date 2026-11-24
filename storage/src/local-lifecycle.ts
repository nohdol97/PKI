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
import { keyedTextHash } from "./identity.ts";
import { findSourceId, readLastRevision } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { readTombstoneState } from "./tombstones.ts";

/** Moves a location to a state other than `active` (which is `reopenLocation`'s); false when there is no such location. */
export function closeLocation(
  db: SqlDriver,
  id: string,
  state: Exclude<LocationState, "active">,
  reason: string | null,
  expected?: LocationState,
): boolean {
  return setLocationState(db, id, state, reason, expected);
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
export function reopenLocation(
  db: SqlDriver,
  id: string,
  reason: string | null = null,
  expected?: LocationState,
): boolean {
  return db.transaction(
    () => {
      if (!setLocationState(db, id, "active", reason, expected)) return false;
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
 * read again. False when there is no such location, or, when `states` is given, when its state now is not
 * one of them: nothing is written then (a pause or revocation that came in meanwhile stands, LCF-R1).
 */
export function relinkLocation(
  db: SqlDriver,
  id: string,
  target: RelinkTarget,
  states?: readonly LocationState[],
): boolean {
  return db.transaction(
    () => {
      if (states !== undefined) {
        const state = readLocation(db, id)?.state;
        if (state === undefined || !states.includes(state)) return false;
      }
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

/**
 * Where the sources of a location live: the `local-files` instance in the location's namespace, or, for a
 * JSONL file location (I02B-R41), every source of its own instance whatever namespace the lines claimed.
 */
export interface SourceScope {
  instanceId: string;
  /** Null: every namespace of the instance. */
  namespace: string | null;
}

const scopeOf = (id: string, scope?: SourceScope): SourceScope =>
  scope ?? { instanceId: LOCAL_FILES_INSTANCE_ID, namespace: id };

/** The sources of the location that are still whole: plain identity, in its scope (a purged source's identity is hashed). */
export function liveSourceCount(db: SqlDriver, id: string, scope?: SourceScope): number {
  const { instanceId, namespace } = scopeOf(id, scope);
  return Number(
    db.all(
      `SELECT count(*) AS n FROM sources
       WHERE connector_instance_id = ? AND (? IS NULL OR namespace = ?) AND identity_hashed = 0`,
      [instanceId, namespace, namespace],
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
  scope?: SourceScope,
): RevokeBatchResult {
  const { instanceId, namespace } = scopeOf(id, scope);
  const batch = tx.all(
    `SELECT namespace, external_id FROM sources
     WHERE connector_instance_id = ? AND (? IS NULL OR namespace = ?) AND identity_hashed = 0
     ORDER BY id LIMIT ?`,
    [instanceId, namespace, namespace, max],
  );
  for (const row of batch) {
    const externalId = row.external_id as string;
    deleteSource({
      connectorInstanceId: instanceId,
      namespace: row.namespace as string,
      externalId,
    });
    tx.run("DELETE FROM local_file_entries WHERE location_id = ? AND external_id = ?", [
      id,
      externalId,
    ]);
  }
  const remaining = liveSourceCount(tx, id, scope);
  const done = remaining === 0;
  if (done) {
    tx.run("DELETE FROM local_file_entries WHERE location_id = ?", [id]);
    tx.run("DELETE FROM local_locations WHERE id = ?", [id]);
  } else {
    setLocationState(tx, id, "revoking", null);
  }
  return { deleted: batch.length, remaining, done };
}

export type ReimportResult = { ok: true } | { ok: false; reason: "not-found" | "not-lifted" };

/**
 * A skipped file is read again (I02B-R33): the entry is made "to look at" with a revision above the
 * last, so the next pass reads it and announces it. A file the user deleted is a `forgotten` entry; it is
 * read again only when its source's tombstone was lifted, judged in this transaction, and then it is a
 * new version of the same source (the entry keeps its id). The path is written to the row only then.
 */
export function reimportEntry(
  db: SqlDriver,
  locationId: string,
  relativePath: string,
): ReimportResult {
  return db.transaction(
    () => {
      const pathHash = keyedTextHash(db, "local-path", `${locationId}\n${relativePath}`);
      const row =
        db.all("SELECT * FROM local_file_entries WHERE location_id = ? AND relative_path = ?", [
          locationId,
          relativePath,
        ])[0] ??
        db.all(
          "SELECT * FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' AND path_hash = ?",
          [locationId, pathHash],
        )[0];
      if (!row) return { ok: false, reason: "not-found" };
      const externalId = row.external_id as string;
      if (row.state === "forgotten") {
        const sourceId = findSourceId(db, LOCAL_FILES_INSTANCE_ID, locationId, externalId);
        const tombstone = sourceId === undefined ? undefined : readTombstoneState(db, sourceId);
        if (tombstone && tombstone.liftedAt === null) return { ok: false, reason: "not-lifted" };
        db.run(
          `UPDATE local_file_entries SET state = 'present', relative_path = ?, path_hash = ?,
             size = NULL, mtime_ns = NULL, content_hash = NULL, content_keyed_hash = NULL, file_no = NULL,
             revision = ?, pending_delete = 0, skip_reason = NULL, skipped_at = NULL, skip_limits = NULL,
             seq = ? WHERE external_id = ?`,
          [relativePath, pathHash, (row.revision as number) + 1, takeLocalSeq(db), externalId],
        );
        return { ok: true };
      }
      if (row.state !== "skipped") return { ok: false, reason: "not-found" };
      db.run(
        "UPDATE local_file_entries SET size = NULL, mtime_ns = NULL, revision = ?, seq = ? WHERE external_id = ?",
        [(row.revision as number) + 1, takeLocalSeq(db), externalId],
      );
      return { ok: true };
    },
    { immediate: true },
  );
}
