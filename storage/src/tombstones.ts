// Tombstones (I04-R9, V02-R12, ADR 0013 decision 4): a deleted or access-revoked
// source's row keeps no content, only the product version it covers (every
// version up to it), the source system's revision at the deletion, the time, the
// reason and, once the user lifts it, when. A new tombstone and a moved cover
// raise the change sequence (triggers); a reason change, a revision and a lift do
// not. The rule of who overwrites whom lives here only (recordTombstone); the
// entries that also purge and propagate are @pki/knowledge-engine's.
import type { TombstoneOutcome } from "./derivatives.ts";
import type { SqlDriver } from "./sql-driver.ts";

/**
 * Who deleted: the screen's request (`user-deleted`, never lets the source back
 * until the user lifts it), the Connector reporting the source gone
 * (`source-deleted`) or its access lost (`access-revoked`).
 */
export type TombstoneReason = "user-deleted" | "source-deleted" | "access-revoked";

export interface TombstoneState {
  sourceId: number;
  /** Every product version up to this one is covered; 0 before any version. */
  coversVersion: number;
  /** The source system's revision at the deletion; null for the screen's and pre-v13 rows. */
  lastRevision: number | null;
  reason: TombstoneReason;
  at: string;
  /** When the user lifted it; null while it blocks arrivals. */
  liftedAt: string | null;
}

export function readTombstoneState(db: SqlDriver, sourceId: number): TombstoneState | undefined {
  const row = db.all(
    "SELECT covers_version, last_revision, reason, at, lifted_at FROM tombstones WHERE source_id = ?",
    [sourceId],
  )[0];
  if (!row) return undefined;
  return {
    sourceId,
    coversVersion: row.covers_version as number,
    lastRevision: row.last_revision as number | null,
    reason: row.reason as TombstoneReason,
    at: row.at as string,
    liftedAt: row.lifted_at as string | null,
  };
}

/** A deletion as it arrives: the cover is never the caller's to name. */
export interface TombstoneEvent {
  reason: TombstoneReason;
  lastRevision: number | null;
  at: string;
}

/**
 * Judges a deletion against the source's stored tombstone and writes what it
 * changes (I04-R9). The cover is max(the source's latest product version, the
 * stored cover): with every version purged, the stored cover alone keeps a lift
 * followed by a deletion from falling to 0.
 */
export function recordTombstone(
  db: SqlDriver,
  sourceId: number,
  event: TombstoneEvent,
): { outcome: TombstoneOutcome; tombstone: TombstoneState } {
  const old = readTombstoneState(db, sourceId);
  const latest =
    (db.all("SELECT max(version) AS v FROM source_versions WHERE source_id = ?", [sourceId])[0]
      ?.v as number | null) ?? 0;
  const written: TombstoneState = {
    sourceId,
    coversVersion: Math.max(latest, old?.coversVersion ?? 0),
    lastRevision: event.lastRevision,
    reason: event.reason,
    at: event.at,
    liftedAt: null,
  };
  if (!old) {
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, last_revision, at, reason) VALUES (?, ?, ?, ?, ?)",
      [sourceId, written.coversVersion, written.lastRevision, written.at, written.reason],
    );
    return { outcome: "created", tombstone: written };
  }
  const rewrite = (outcome: TombstoneOutcome) => {
    db.run(
      `UPDATE tombstones SET covers_version = ?, last_revision = ?, at = ?, reason = ?,
         lifted_at = NULL WHERE source_id = ?`,
      [written.coversVersion, written.lastRevision, written.at, written.reason, sourceId],
    );
    return { outcome, tombstone: written };
  };
  if (written.coversVersion > old.coversVersion) return rewrite("cover-extended");
  // lifted, and deleted again before any new version: whoever deletes, that reason
  if (old.liftedAt !== null) return rewrite("reason-changed");
  if (event.reason === "user-deleted") {
    return old.reason === "user-deleted"
      ? { outcome: "unchanged", tombstone: old }
      : rewrite("reason-changed");
  }
  // A source event never takes the reason, the user's included (I01-R11): only a
  // greater revision moves, and only the revision (provisional: an empty stored
  // revision is below any)
  if (event.lastRevision !== null && event.lastRevision > (old.lastRevision ?? 0)) {
    db.run("UPDATE tombstones SET last_revision = ? WHERE source_id = ?", [
      event.lastRevision,
      sourceId,
    ]);
    return { outcome: "revision-raised", tombstone: { ...old, lastRevision: event.lastRevision } };
  }
  return { outcome: "unchanged", tombstone: old };
}

/** Marks the source's tombstone lifted (I04-R9); nothing deleted comes back. */
export function recordTombstoneLift(
  db: SqlDriver,
  sourceId: number,
  at: string,
): "lifted" | "unchanged" {
  const { changes } = db.run(
    "UPDATE tombstones SET lifted_at = ? WHERE source_id = ? AND lifted_at IS NULL",
    [at, sourceId],
  );
  return changes === 1 ? "lifted" : "unchanged";
}

/** V02's tombstone, as deleteSource writes and reads it until I04-T13 and I01-T02 move to the entries. */
export interface Tombstone {
  sourceId: number;
  version: number;
  at: string;
  reason: TombstoneReason;
}

/** V02's write: the caller names the version, and only a higher one moves the tombstone. */
export function writeTombstone(db: SqlDriver, t: Tombstone): "written" | "unchanged" {
  const { changes } = db.run(
    `INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (source_id) DO UPDATE SET covers_version = excluded.covers_version,
       at = excluded.at, reason = excluded.reason, last_revision = NULL, lifted_at = NULL
     WHERE excluded.covers_version > tombstones.covers_version`,
    [t.sourceId, t.version, t.at, t.reason],
  );
  return changes === 1 ? "written" : "unchanged";
}

export function readTombstone(db: SqlDriver, sourceId: number): Tombstone | undefined {
  const state = readTombstoneState(db, sourceId);
  return state && { sourceId, version: state.coversVersion, at: state.at, reason: state.reason };
}
