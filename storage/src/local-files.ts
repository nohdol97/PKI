// The local file index (I02B-R33, D11): where the approved locations and the per-file index of the
// `local-files` connector live, in the canonical database. The index is source identity (what a file
// is and where it was seen), not a derivative: it is written before the source exists, keeps rows
// after a deletion, and is scrubbed by the trigger on `tombstones` (migration v22), whoever wrote the
// tombstone. This module is the connector's only way to read and write it.
//
// Writes are compare-and-set. A scan reads the index, works for a long while and then writes; the
// user may delete the source in between (that path takes no instance lock). The entry's `seq` is the
// fence: an update applies only while the entry still has the `seq` the scan read, so a scrubbed or
// changed entry is never overwritten by the scan's old plaintext. Every sequence number comes from the
// one-row counter `local_index_seq`, never from MAX(seq).
import { randomBytes } from "node:crypto";
import { identityKey, keyedTextHash, keyedTextHasher } from "./identity.ts";
import type { SqlDriver, SqlValue } from "./sql-driver.ts";

/** The connector instance the trigger and the index belong to. */
export const LOCAL_FILES_INSTANCE_ID = "local-files";

export type LocationType = "folder" | "file" | "jsonl-file";
export type LocationState = "active" | "paused" | "unavailable" | "needs-confirmation" | "revoking";
/** The states in which the connector reads the location, and so may write its entries (I02B-R33). */
export const WRITABLE_LOCATION_STATES: readonly LocationState[] = ["active", "needs-confirmation"];

export interface LocalLocation {
  id: string;
  type: LocationType;
  /** What the user chose, shown on screen. */
  displayPath: string;
  /** The path the OS resolved when it was approved (symlinks followed). */
  realPath: string;
  /** The identity of the root as decimal text (a 64-bit file number does not fit a JS number). */
  rootDev: string;
  rootIno: string;
  state: LocationState;
  stateReason: string | null;
  limitExceeded: boolean;
  lastPassAt: string | null;
  createdAt: string;
}

export type NewLocation = Pick<
  LocalLocation,
  "id" | "type" | "displayPath" | "realPath" | "rootDev" | "rootIno" | "createdAt"
>;

/** A location or file id (I02B-R2): 16 random bytes as 22 base64url characters. */
export const newLocalId = (): string => randomBytes(16).toString("base64url");

export function insertLocation(db: SqlDriver, location: NewLocation): void {
  db.run(
    `INSERT INTO local_locations (id, type, display_path, real_path, root_dev, root_ino, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      location.id,
      location.type,
      location.displayPath,
      location.realPath,
      location.rootDev,
      location.rootIno,
      location.createdAt,
    ],
  );
}

const locationOf = (row: Record<string, SqlValue>): LocalLocation => ({
  id: row.id as string,
  type: row.type as LocationType,
  displayPath: row.display_path as string,
  realPath: row.real_path as string,
  rootDev: row.root_dev as string,
  rootIno: row.root_ino as string,
  state: row.state as LocationState,
  stateReason: row.state_reason as string | null,
  limitExceeded: row.limit_exceeded === 1,
  lastPassAt: row.last_pass_at as string | null,
  createdAt: row.created_at as string,
});

export function readLocation(db: SqlDriver, id: string): LocalLocation | undefined {
  const row = db.all("SELECT * FROM local_locations WHERE id = ?", [id])[0];
  return row && locationOf(row);
}

export function listLocations(db: SqlDriver): LocalLocation[] {
  return db.all("SELECT * FROM local_locations ORDER BY created_at, id").map(locationOf);
}

/**
 * Moves a location to a state; false when there is no such location, or, given `expected`, when it is no
 * longer in that state (a pass writes only from the state it decided from, so a user's change is kept).
 */
export function setLocationState(
  db: SqlDriver,
  id: string,
  state: LocationState,
  reason: string | null,
  expected?: LocationState,
): boolean {
  return (
    db.run(
      `UPDATE local_locations SET state = ?, state_reason = ? WHERE id = ?${expected ? " AND state = ?" : ""}`,
      expected ? [state, reason, id, expected] : [state, reason, id],
    ).changes === 1
  );
}

export type EntryState = "present" | "skipped" | "deleted" | "forgotten";

/** An entry as the connector reads it. The keyed hashes stay inside storage. */
export interface LocalFileEntry {
  externalId: string;
  locationId: string;
  /** Null once the entry is `deleted` or `forgotten` (scrubbed). */
  relativePath: string | null;
  size: number | null;
  mtimeNs: string | null;
  contentHash: string | null;
  fileNo: string | null;
  revision: number;
  normalizerVersion: number | null;
  seq: number;
  state: EntryState;
  /** 0 none, 1 held for the user's confirmation, 2 confirmed (I02B-R8). */
  pendingDelete: 0 | 1 | 2;
  skipReason: string | null;
  skippedAt: string | null;
  skipLimits: string | null;
}

/** What a write sets. `deleted` clears the plaintext fields whatever they hold; `forgotten` is never written here. */
export interface EntryFields {
  relativePath: string;
  size: number | null;
  mtimeNs: string | null;
  contentHash: string | null;
  fileNo: string | null;
  revision: number;
  normalizerVersion: number | null;
  state: "present" | "skipped" | "deleted";
  pendingDelete: 0 | 1 | 2;
  skipReason: string | null;
  skippedAt: string | null;
  skipLimits: string | null;
}

export type NewEntry = Omit<EntryFields, "state"> & {
  externalId: string;
  locationId: string;
  state: "present" | "skipped";
};

export type WriteRefusal = "stale" | "dead" | "location-closed" | "path-taken";
export type InsertRefusal = "forgotten" | "duplicate" | "location-closed";

/** A write that does not apply changes nothing and says why; a write that applies says the entry's new sequence. */
export type UpdateResult =
  { applied: true; seq: number } | { applied: false; reason: WriteRefusal };
export type InsertResult =
  { applied: true; seq: number } | { applied: false; reason: InsertRefusal };

export interface LocalFileIndex {
  /** The counter's value: the greatest sequence number ever handed out. */
  lastSeq(): number;
  entryOf(externalId: string): LocalFileEntry | undefined;
  /** By the plaintext path first, then by its keyed hash (a forgotten entry has only the hash). */
  findByPath(locationId: string, relativePath: string): LocalFileEntry | undefined;
  /** The forgotten entries of the location whose content is the given one (a moved file is told by it). */
  findForgottenByContent(locationId: string, contentHash: string): LocalFileEntry[];
  entriesOfLocation(locationId: string): LocalFileEntry[];
  /** The entries with a sequence above `seq`, in sequence order. */
  entriesAfter(seq: number, limit: number): LocalFileEntry[];
  /** Applies only while the entry still has `expectedSeq`, is live and its location is read. */
  updateEntry(externalId: string, expectedSeq: number, next: EntryFields): UpdateResult;
  /**
   * Adds an entry unless a forgotten entry of the same location matches it: by the path, or by the
   * content when the forgotten file's path holds no file of that content now. `seenPathsOfSameContent`
   * is what this scan saw in the location with the same content (paths), judged in the same transaction.
   */
  insertEntry(entry: NewEntry, seenPathsOfSameContent: readonly string[]): InsertResult;
}

const entryOf = (row: Record<string, SqlValue>): LocalFileEntry => ({
  externalId: row.external_id as string,
  locationId: row.location_id as string,
  relativePath: row.relative_path as string | null,
  size: row.size as number | null,
  mtimeNs: row.mtime_ns as string | null,
  contentHash: row.content_hash as string | null,
  fileNo: row.file_no as string | null,
  revision: row.revision as number,
  normalizerVersion: row.normalizer_version as number | null,
  seq: row.seq as number,
  state: row.state as EntryState,
  pendingDelete: row.pending_delete as 0 | 1 | 2,
  skipReason: row.skip_reason as string | null,
  skippedAt: row.skipped_at as string | null,
  skipLimits: row.skip_limits as string | null,
});

/** The values the plaintext columns take for a write; a deleted entry keeps none of them. */
const plaintext = (next: EntryFields) =>
  next.state === "deleted"
    ? { path: null, size: null, mtimeNs: null, contentHash: null, fileNo: null }
    : {
        path: next.relativePath,
        size: next.size,
        mtimeNs: next.mtimeNs,
        contentHash: next.contentHash,
        fileNo: next.fileNo,
      };

/** The next number from the counter: the one place a sequence number is made. */
export function takeLocalSeq(db: SqlDriver): number {
  db.run("UPDATE local_index_seq SET value = value + 1 WHERE id = 1");
  return db.all("SELECT value FROM local_index_seq WHERE id = 1")[0]?.value as number;
}

export function createLocalFileIndex(db: SqlDriver): LocalFileIndex {
  const pathHash = (locationId: string, path: string) =>
    keyedTextHash(db, "local-path", `${locationId}\n${path}`);
  const contentHashOf = (locationId: string, content: string) =>
    keyedTextHash(db, "local-content", `${locationId}\n${content}`);
  const takeSeq = (): number => takeLocalSeq(db);
  const locationIsRead = (locationId: string): boolean => {
    const state = db.all("SELECT state FROM local_locations WHERE id = ?", [locationId])[0]
      ?.state as LocationState | undefined;
    return state !== undefined && WRITABLE_LOCATION_STATES.includes(state);
  };
  const pathHeldByAnother = (locationId: string, path: string, except: string): boolean =>
    db.all(
      "SELECT 1 FROM local_file_entries WHERE location_id = ? AND relative_path = ? AND external_id <> ?",
      [locationId, path, except],
    ).length > 0;

  /**
   * Whether a forgotten entry of the location matches the new one: by path, or by content when its path
   * holds no file of that content now. Nothing is hashed while the location has no forgotten entry (the
   * usual case); otherwise the key is read once and the seen paths are compared here, not bound one
   * parameter each (a location can hold more same-content files than SQLite has variables).
   */
  const forgottenMatches = (entry: NewEntry, seenPaths: readonly string[]): boolean => {
    const any = db.all(
      "SELECT 1 FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' LIMIT 1",
      [entry.locationId],
    );
    if (any.length === 0) return false;
    const pathOf = keyedTextHasher(db, "local-path");
    const here = (path: string) => pathOf(`${entry.locationId}\n${path}`);
    const byPath = db.all(
      "SELECT 1 FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' AND path_hash = ?",
      [entry.locationId, here(entry.relativePath)],
    );
    if (byPath.length > 0) return true;
    if (entry.contentHash === null) return false;
    const sameContent = db
      .all(
        "SELECT path_hash FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' AND content_keyed_hash = ?",
        [entry.locationId, contentHashOf(entry.locationId, entry.contentHash)],
      )
      .map((r) => r.path_hash as string);
    if (sameContent.length === 0) return false;
    const seen = new Set(seenPaths.map(here));
    return sameContent.some((hash) => !seen.has(hash));
  };

  return {
    lastSeq: () => db.all("SELECT value FROM local_index_seq WHERE id = 1")[0]?.value as number,

    entryOf(externalId) {
      const row = db.all("SELECT * FROM local_file_entries WHERE external_id = ?", [externalId])[0];
      return row && entryOf(row);
    },

    findByPath(locationId, relativePath) {
      const plain = db.all(
        "SELECT * FROM local_file_entries WHERE location_id = ? AND relative_path = ?",
        [locationId, relativePath],
      )[0];
      if (plain) return entryOf(plain);
      const hashed = db.all(
        "SELECT * FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' AND path_hash = ?",
        [locationId, pathHash(locationId, relativePath)],
      )[0];
      return hashed && entryOf(hashed);
    },

    findForgottenByContent: (locationId, contentHash) =>
      db
        .all(
          "SELECT * FROM local_file_entries WHERE location_id = ? AND state = 'forgotten' AND content_keyed_hash = ? ORDER BY seq",
          [locationId, contentHashOf(locationId, contentHash)],
        )
        .map(entryOf),

    entriesOfLocation: (locationId) =>
      db
        .all("SELECT * FROM local_file_entries WHERE location_id = ? ORDER BY seq", [locationId])
        .map(entryOf),

    entriesAfter: (seq, limit) =>
      db
        .all("SELECT * FROM local_file_entries WHERE seq > ? ORDER BY seq LIMIT ?", [seq, limit])
        .map(entryOf),

    updateEntry(externalId, expectedSeq, next) {
      return db.transaction(
        () => {
          const current = db.all("SELECT * FROM local_file_entries WHERE external_id = ?", [
            externalId,
          ])[0];
          if (!current || current.seq !== expectedSeq) return { applied: false, reason: "stale" };
          if (current.state !== "present" && current.state !== "skipped") {
            return { applied: false, reason: "dead" };
          }
          const locationId = current.location_id as string;
          if (!locationIsRead(locationId)) return { applied: false, reason: "location-closed" };
          const kept = plaintext(next);
          if (kept.path !== null && pathHeldByAnother(locationId, kept.path, externalId)) {
            return { applied: false, reason: "path-taken" };
          }
          const seq = takeSeq();
          db.run(
            `UPDATE local_file_entries SET relative_path = ?, path_hash = ?, size = ?, mtime_ns = ?,
             content_hash = ?, content_keyed_hash = ?, file_no = ?, revision = ?, normalizer_version = ?,
             state = ?, pending_delete = ?, skip_reason = ?, skipped_at = ?, skip_limits = ?, seq = ?
           WHERE external_id = ? AND seq = ?`,
            [
              kept.path,
              kept.path === null ? null : pathHash(locationId, kept.path),
              kept.size,
              kept.mtimeNs,
              kept.contentHash,
              kept.contentHash === null ? null : contentHashOf(locationId, kept.contentHash),
              kept.fileNo,
              next.revision,
              next.normalizerVersion,
              next.state,
              next.state === "deleted" ? 0 : next.pendingDelete,
              next.state === "deleted" ? null : next.skipReason,
              next.state === "deleted" ? null : next.skippedAt,
              next.state === "deleted" ? null : next.skipLimits,
              seq,
              externalId,
              expectedSeq,
            ],
          );
          return { applied: true, seq };
        },
        { immediate: true },
      );
    },

    insertEntry(entry, seenPathsOfSameContent) {
      return db.transaction(
        () => {
          if (!locationIsRead(entry.locationId))
            return { applied: false, reason: "location-closed" };
          if (
            db.all("SELECT 1 FROM local_file_entries WHERE external_id = ?", [entry.externalId])
              .length > 0 ||
            pathHeldByAnother(entry.locationId, entry.relativePath, entry.externalId)
          ) {
            return { applied: false, reason: "duplicate" };
          }
          if (forgottenMatches(entry, seenPathsOfSameContent)) {
            return { applied: false, reason: "forgotten" };
          }
          const seq = takeSeq();
          db.run(
            `INSERT INTO local_file_entries (external_id, location_id, identity_hash, relative_path,
             path_hash, size, mtime_ns, content_hash, content_keyed_hash, file_no, revision,
             normalizer_version, seq, state, pending_delete, skip_reason, skipped_at, skip_limits)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              entry.externalId,
              entry.locationId,
              identityKey(db, LOCAL_FILES_INSTANCE_ID, entry.locationId, entry.externalId),
              entry.relativePath,
              pathHash(entry.locationId, entry.relativePath),
              entry.size,
              entry.mtimeNs,
              entry.contentHash,
              entry.contentHash === null
                ? null
                : contentHashOf(entry.locationId, entry.contentHash),
              entry.fileNo,
              entry.revision,
              entry.normalizerVersion,
              seq,
              entry.state,
              entry.pendingDelete,
              entry.skipReason,
              entry.skippedAt,
              entry.skipLimits,
            ],
          );
          return { applied: true, seq };
        },
        { immediate: true },
      );
    },
  };
}
