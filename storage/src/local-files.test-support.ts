// Test support (a `*.test-support.ts` file: refused in product code by lint and the bundle). The
// in-memory local file index: the same answers as `createLocalFileIndex` (the canonical one), with
// `scrub` standing in for the trigger on `tombstones` so that a test can drive both the same way.
// Plaintext keys stand in for the keyed hashes; nothing here reads a database.
import type {
  EntryFields,
  InsertResult,
  LocalFileEntry,
  LocalFileIndex,
  LocationState,
  NewEntry,
  UpdateResult,
} from "./local-files.ts";
import { WRITABLE_LOCATION_STATES } from "./local-files.ts";

interface Row extends LocalFileEntry {
  /** What the keyed hashes would hold; kept after a user deletion, dropped after a source deletion. */
  pathKey: string | null;
  contentKey: string | null;
}

export interface MemoryLocalFileIndex extends LocalFileIndex {
  setLocationState(locationId: string, state: LocationState): void;
  /** What the tombstone trigger does to a live entry of this file id; nothing to a scrubbed one. */
  scrub(externalId: string, reason: "user-deleted" | "source-deleted" | "access-revoked"): void;
}

export function createMemoryLocalFileIndex(
  locations: readonly { id: string; state: LocationState }[],
): MemoryLocalFileIndex {
  const states = new Map(locations.map((l) => [l.id, l.state]));
  const rows = new Map<string, Row>();
  let counter = 0;
  const strip = (row: Row): LocalFileEntry => {
    const entry: Partial<Row> = { ...row };
    delete entry.pathKey;
    delete entry.contentKey;
    return entry as LocalFileEntry;
  };
  const isRead = (locationId: string) => {
    const state = states.get(locationId);
    return state !== undefined && WRITABLE_LOCATION_STATES.includes(state);
  };
  const live = (row: Row) => row.state === "present" || row.state === "skipped";
  const heldByAnother = (locationId: string, path: string, except: string) =>
    [...rows.values()].some(
      (r) => r.locationId === locationId && r.relativePath === path && r.externalId !== except,
    );
  const plaintext = (next: EntryFields) =>
    next.state === "deleted"
      ? { relativePath: null, size: null, mtimeNs: null, contentHash: null, fileNo: null }
      : {
          relativePath: next.relativePath,
          size: next.size,
          mtimeNs: next.mtimeNs,
          contentHash: next.contentHash,
          fileNo: next.fileNo,
        };

  return {
    setLocationState: (locationId, state) => void states.set(locationId, state),
    lastSeq: () => counter,
    entryOf: (id) => {
      const row = rows.get(id);
      return row && strip(row);
    },
    findByPath(locationId, relativePath) {
      const all = [...rows.values()].filter((r) => r.locationId === locationId);
      const found =
        all.find((r) => r.relativePath === relativePath) ??
        all.find((r) => r.state === "forgotten" && r.pathKey === relativePath);
      return found && strip(found);
    },
    findForgottenByContent: (locationId, contentHash) =>
      [...rows.values()]
        .filter(
          (r) =>
            r.locationId === locationId && r.state === "forgotten" && r.contentKey === contentHash,
        )
        .sort((a, b) => a.seq - b.seq)
        .map(strip),
    entriesOfLocation: (locationId) =>
      [...rows.values()]
        .filter((r) => r.locationId === locationId)
        .sort((a, b) => a.seq - b.seq)
        .map(strip),
    entriesAfter: (seq, limit) =>
      [...rows.values()]
        .filter((r) => r.seq > seq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(strip),

    updateEntry(externalId, expectedSeq, next): UpdateResult {
      const current = rows.get(externalId);
      if (!current || current.seq !== expectedSeq) return { applied: false, reason: "stale" };
      if (!live(current)) return { applied: false, reason: "dead" };
      if (!isRead(current.locationId)) return { applied: false, reason: "location-closed" };
      const kept = plaintext(next);
      if (
        kept.relativePath !== null &&
        heldByAnother(current.locationId, kept.relativePath, externalId)
      ) {
        return { applied: false, reason: "path-taken" };
      }
      const deleted = next.state === "deleted";
      rows.set(externalId, {
        ...current,
        ...kept,
        pathKey: kept.relativePath,
        contentKey: kept.contentHash,
        revision: next.revision,
        normalizerVersion: next.normalizerVersion,
        state: next.state,
        pendingDelete: deleted ? 0 : next.pendingDelete,
        skipReason: deleted ? null : next.skipReason,
        skippedAt: deleted ? null : next.skippedAt,
        skipLimits: deleted ? null : next.skipLimits,
        seq: ++counter,
      });
      return { applied: true, seq: counter };
    },

    insertEntry(entry: NewEntry, seenPathsOfSameContent): InsertResult {
      if (!isRead(entry.locationId)) return { applied: false, reason: "location-closed" };
      if (
        rows.has(entry.externalId) ||
        heldByAnother(entry.locationId, entry.relativePath, entry.externalId)
      ) {
        return { applied: false, reason: "duplicate" };
      }
      const forgotten = [...rows.values()].filter(
        (r) => r.locationId === entry.locationId && r.state === "forgotten",
      );
      const byPath = forgotten.some((r) => r.pathKey === entry.relativePath);
      const byContent =
        entry.contentHash !== null &&
        forgotten.some(
          (r) =>
            r.contentKey === entry.contentHash &&
            !seenPathsOfSameContent.includes(r.pathKey as string),
        );
      if (byPath || byContent) return { applied: false, reason: "forgotten" };
      rows.set(entry.externalId, {
        externalId: entry.externalId,
        locationId: entry.locationId,
        relativePath: entry.relativePath,
        size: entry.size,
        mtimeNs: entry.mtimeNs,
        contentHash: entry.contentHash,
        fileNo: entry.fileNo,
        revision: entry.revision,
        normalizerVersion: entry.normalizerVersion,
        seq: ++counter,
        state: entry.state,
        pendingDelete: entry.pendingDelete,
        skipReason: entry.skipReason,
        skippedAt: entry.skippedAt,
        skipLimits: entry.skipLimits,
        pathKey: entry.relativePath,
        contentKey: entry.contentHash,
      });
      return { applied: true, seq: counter };
    },

    scrub(externalId, reason) {
      const row = rows.get(externalId);
      if (!row || !live(row)) return;
      const sourceDeleted = reason === "source-deleted";
      rows.set(externalId, {
        ...row,
        relativePath: null,
        size: null,
        mtimeNs: null,
        contentHash: null,
        fileNo: null,
        pathKey: sourceDeleted ? null : row.pathKey,
        contentKey: sourceDeleted ? null : row.contentKey,
        revision: sourceDeleted ? row.revision + 1 : row.revision,
        state: sourceDeleted ? "deleted" : "forgotten",
        pendingDelete: 0,
        skipReason: null,
        skippedAt: null,
        skipLimits: null,
        seq: ++counter,
      });
    },
  };
}
