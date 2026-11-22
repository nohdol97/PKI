// Canonical source storage (V01-R7). A source is identified by Connector
// instance + namespace + external id (I01-R8). The product numbers each
// source's versions itself, one past its latest and past its tombstone's cover
// (V02-R3, I04-R9); the origin system's `revision` is kept on the version and
// only orders arrivals (I01-R9). `saveSourceRecord` and `saveScopeChange` are the
// arrival judgment of I01-R10 and R12: they find the source by its plain
// identity, then by its keyed hash (I04-R7), and decide before anything is
// written, so a record the tombstone would block never reaches its trigger.
// Tombstone events are judged where they are applied (@pki/knowledge-engine,
// arrival.ts). Callers wrap a page in one transaction.
import { createHash } from "node:crypto";
import { parseScope, type AccessScope } from "./derivatives.ts";
import { findHashedSourceId } from "./identity.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { readTombstoneState, type TombstoneState } from "./tombstones.ts";

export interface StoredRecord {
  /** Where the external id is unique within the instance; absent is "", its one range (I01-R5). */
  namespace?: string | undefined;
  externalId: string;
  title: string;
  body: string;
  /**
   * The origin system's own number for this record. Absent: the record is unordered
   * (a seed): the revision steps are skipped and the last revision is left alone.
   */
  revision?: number | undefined;
  /** The record's schema version (I01-R13); absent is 1, what rows from before it hold. */
  schemaVersion?: number | undefined;
  /** Locator-carrying ranges of the body, kept as given (I01-R7); part of the content hash. */
  blocks?: readonly unknown[] | undefined;
  /** Author, participants, times and the like; kept with the version, not part of the hash. */
  provenance?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Who may see it. Absent: the row's scope is left alone. null: unknown (the
   * strictest). The scope is the source's, not the version's (I01-R13).
   */
  accessScope?: readonly string[] | null | undefined;
}

export interface SaveOptions {
  /** The scope is a user's own claim (an import, I01-R15): marked on the row with the scope. */
  scopeClaimed?: boolean | undefined;
}

export type SaveOutcome =
  | { status: "created"; sourceId: number; version: number }
  | { status: "unchanged"; sourceId: number }
  | { status: "scope-updated"; sourceId: number; from: AccessScope; to: AccessScope }
  /** Older than what was accepted: not an error, nothing is written. */
  | { status: "stale" }
  /** A tombstone stands in front of it: nothing is written. */
  | { status: "blocked" }
  | { status: "rejected"; code: "revision-conflict" };

export interface ScopeChange {
  namespace: string;
  externalId: string;
  revision: number;
  accessScope: readonly string[];
}

export type ScopeChangeOutcome =
  | { status: "scope-updated"; sourceId: number; from: AccessScope; to: AccessScope }
  | { status: "unchanged"; sourceId: number }
  | { status: "stale" }
  | { status: "blocked" };

/** JSON with object keys in order, so equal content hashes equal whoever built the object. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Title, body and blocks bound together: JSON array encoding keeps "ab"+"c" apart
 * from "a"+"bc". Without blocks (none, or an empty list) it is the hash of
 * `[title, body]` as it was before blocks existed (I01-R10).
 */
export function contentHash(
  title: string,
  body: string,
  blocks?: readonly unknown[] | undefined,
): string {
  const parts: unknown[] = blocks && blocks.length > 0 ? [title, body, blocks] : [title, body];
  return createHash("sha256").update(stableJson(parts)).digest("hex");
}

/** A scope as stored: sorted, no duplicates (I01-R13). */
export function normalizeScope(scope: readonly string[]): string[] {
  return [...new Set(scope)].sort();
}

const sameScope = (a: AccessScope, b: AccessScope) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((v, i) => v === b[i]);

/** The source's latest version: the (source_id, version) index, no sort. */
export const LATEST_VERSION_SQL =
  "SELECT content_hash, version, revision FROM source_versions WHERE source_id = ? ORDER BY version DESC LIMIT 1";

/**
 * The content hash of the source's latest version, or undefined when it has none (a
 * purged or never-stored source). `scope-change-content-mismatch` compares it (I01-R22).
 */
export function readLatestContentHash(db: SqlDriver, sourceId: number): string | undefined {
  return db.all(LATEST_VERSION_SQL, [sourceId])[0]?.content_hash as string | undefined;
}

interface Standing {
  last: number | null;
  scope: AccessScope;
  tombstone: TombstoneState | undefined;
  latest: { hash: string; version: number } | undefined;
}

function readStanding(db: SqlDriver, sourceId: number): Standing {
  const row = db.all("SELECT last_revision, access_scope FROM sources WHERE id = ?", [sourceId])[0];
  const latest = db.all(LATEST_VERSION_SQL, [sourceId])[0];
  return {
    last: (row?.last_revision ?? null) as number | null,
    scope: parseScope((row?.access_scope ?? null) as string | null),
    tombstone: readTombstoneState(db, sourceId),
    latest: latest && { hash: latest.content_hash as string, version: latest.version as number },
  };
}

/**
 * I01-R10 step 0: a tombstone not lifted blocks what the user deleted until the
 * user lifts it, and what the source deleted or revoked unless the arrival's
 * revision is greater than the tombstone's. Without a revision on either side
 * nothing can pass. A lifted tombstone is no door.
 */
function blockedByTombstone(t: TombstoneState | undefined, revision: number | undefined) {
  if (!t || t.liftedAt !== null) return false;
  if (t.reason === "user-deleted") return true;
  return t.lastRevision === null || revision === undefined || revision <= t.lastRevision;
}

/** Writes a scope on the row: the scope, and whether it is a user's claim. */
function writeScope(
  db: SqlDriver,
  sourceId: number,
  scope: readonly string[] | null,
  claimed: boolean,
) {
  db.run("UPDATE sources SET access_scope = ?, scope_claimed = ? WHERE id = ?", [
    scope === null ? null : JSON.stringify(normalizeScope(scope)),
    claimed ? 1 : 0,
    sourceId,
  ]);
}

/** Raises the source's last accepted revision; never lowers it. */
export function raiseLastRevision(db: SqlDriver, sourceId: number, revision: number): void {
  db.run(
    "UPDATE sources SET last_revision = ? WHERE id = ? AND (last_revision IS NULL OR last_revision < ?)",
    [revision, sourceId, revision],
  );
}

/** The source's last accepted revision, or null (none yet, or a source from before it). */
export function readLastRevision(db: SqlDriver, sourceId: number): number | null {
  return (db.all("SELECT last_revision FROM sources WHERE id = ?", [sourceId])[0]?.last_revision ??
    null) as number | null;
}

/**
 * Judges one upsert and stores what it comes to (I01-R10, the figure "upsert 하나를
 * 받아들이는 판정"): blocked by a tombstone, stale, unchanged, a scope update,
 * rejected for a revision conflict, or a new version numbered one past the latest
 * and the tombstone's cover. A source found by its hash gets its plain identity
 * back (I01-R8). Only `created` and `scope-updated` write; a scope update leaves
 * the propagation to the caller, which holds the registry (I01-R12).
 */
export function saveSourceRecord(
  db: SqlDriver,
  connectorInstanceId: string,
  record: StoredRecord,
  options: SaveOptions = {},
): SaveOutcome {
  const namespace = record.namespace ?? "";
  const found = findSourceId(db, connectorInstanceId, namespace, record.externalId);
  const standing = found === undefined ? undefined : readStanding(db, found);
  const revision = record.revision;
  if (blockedByTombstone(standing?.tombstone, revision)) return { status: "blocked" };
  const hash = contentHash(record.title, record.body, record.blocks);
  const last = standing?.last ?? null;
  if (revision !== undefined && last !== null) {
    if (revision < last) return { status: "stale" };
    if (revision === last) {
      if (!standing?.latest) return { status: "stale" };
      if (standing.latest.hash !== hash) return { status: "rejected", code: "revision-conflict" };
    }
  }
  const claimed = options.scopeClaimed ?? false;
  if (found !== undefined && standing?.latest?.hash === hash) {
    if (revision !== undefined) raiseLastRevision(db, found, revision);
    if (record.accessScope === undefined) return { status: "unchanged", sourceId: found };
    const to = record.accessScope === null ? null : normalizeScope(record.accessScope);
    if (sameScope(standing.scope, to)) return { status: "unchanged", sourceId: found };
    writeScope(db, found, to, claimed);
    return { status: "scope-updated", sourceId: found, from: standing.scope, to };
  }
  const sourceId = found ?? ensureSourceId(db, connectorInstanceId, namespace, record.externalId);
  if (found !== undefined) {
    // found by its hash: it lives again, under the plain identity its Connector reads
    db.run(
      "UPDATE sources SET namespace = ?, external_id = ?, identity_hashed = 0 WHERE id = ? AND identity_hashed = 1",
      [namespace, record.externalId, found],
    );
  }
  const version = nextSourceVersion(db, sourceId);
  const meta = record.provenance ? stableJson(record.provenance) : "{}";
  db.run(
    `INSERT INTO source_versions
       (source_id, version, content_hash, title, body, revision, record_schema_version, meta, blocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sourceId,
      version,
      hash,
      record.title,
      record.body,
      revision ?? null,
      record.schemaVersion ?? 1,
      meta === "{}" ? null : meta,
      record.blocks && record.blocks.length > 0 ? stableJson(record.blocks) : null,
    ],
  );
  if (revision !== undefined) raiseLastRevision(db, sourceId, revision);
  if (record.accessScope !== undefined) writeScope(db, sourceId, record.accessScope, claimed);
  return { status: "created", sourceId, version };
}

/**
 * Judges one scope-change event (I01-R12): the tombstone's door and the revision
 * compare as for an upsert, the same revision is taken, and a source with no
 * version is stale. A new scope is written on the row and no version is made; the
 * propagation is the caller's.
 */
export function saveScopeChange(
  db: SqlDriver,
  connectorInstanceId: string,
  change: ScopeChange,
  options: SaveOptions = {},
): ScopeChangeOutcome {
  const sourceId = findSourceId(db, connectorInstanceId, change.namespace, change.externalId);
  if (sourceId === undefined) return { status: "stale" };
  const standing = readStanding(db, sourceId);
  if (blockedByTombstone(standing.tombstone, change.revision)) return { status: "blocked" };
  if (standing.last !== null && change.revision < standing.last) return { status: "stale" };
  if (!standing.latest) return { status: "stale" };
  raiseLastRevision(db, sourceId, change.revision);
  const to = normalizeScope(change.accessScope);
  if (sameScope(standing.scope, to)) return { status: "unchanged", sourceId };
  writeScope(db, sourceId, to, options.scopeClaimed ?? false);
  return { status: "scope-updated", sourceId, from: standing.scope, to };
}

/**
 * The source's next product version (I04-R9): one past its latest and past its
 * tombstone's cover, so a number is never reused once every version is purged.
 */
export function nextSourceVersion(db: SqlDriver, sourceId: number): number {
  const row = db.all(
    `SELECT (SELECT max(version) FROM source_versions WHERE source_id = ?) AS latest,
            (SELECT covers_version FROM tombstones WHERE source_id = ?) AS covers`,
    [sourceId, sourceId],
  )[0];
  return Math.max((row?.latest as number | null) ?? 0, (row?.covers as number | null) ?? 0) + 1;
}

/** The id of the source with this identity, its row created if it was never seen. */
export function ensureSourceId(
  db: SqlDriver,
  connectorInstanceId: string,
  namespace: string,
  externalId: string,
): number {
  // a purged source's row holds the hash, never this plain identity (I04-R7)
  const found = findSourceId(db, connectorInstanceId, namespace, externalId);
  if (found !== undefined) return found;
  return db.run(
    "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, ?, ?)",
    [connectorInstanceId, namespace, externalId],
  ).lastInsertRowid;
}

/**
 * The id of the source an instance names `externalId` in `namespace`, or undefined if
 * never stored: the plain row first, then the row of a purged source by its keyed
 * hash (I04-R7; throws `IdentityKeyMissingError` if hashed rows exist and the key is gone).
 */
export function findSourceId(
  db: SqlDriver,
  connectorInstanceId: string,
  namespace: string,
  externalId: string,
): number | undefined {
  const plain = db.all(
    "SELECT id FROM sources WHERE connector_instance_id = ? AND namespace = ? AND external_id = ?",
    [connectorInstanceId, namespace, externalId],
  )[0]?.id as number | undefined;
  return plain ?? findHashedSourceId(db, connectorInstanceId, namespace, externalId);
}

/** The kind an instance is bound to, or undefined before its first sync. */
export function readConnectorKind(db: SqlDriver, id: string): string | undefined {
  return db.all("SELECT kind FROM connector_instances WHERE id = ?", [id])[0]?.kind as
    string | undefined;
}

/** Records the instance's kind on first sight and refuses to rebind it to another kind. */
export function registerConnectorInstance(db: SqlDriver, id: string, kind: string): void {
  db.run("INSERT INTO connector_instances (id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING", [
    id,
    kind,
  ]);
  const stored = readConnectorKind(db, id);
  if (stored !== kind) {
    throw new Error(`connector instance ${id} is a ${String(stored)}, not a ${kind}`);
  }
}

export function readCursor(db: SqlDriver, id: string): string | null {
  return (db.all("SELECT cursor FROM connector_instances WHERE id = ?", [id])[0]?.cursor ??
    null) as string | null;
}

/** The rescan state of an instance (I01-R17); both false before its first sync. */
export function readRescanState(
  db: SqlDriver,
  id: string,
): { pending: boolean; deletionsMayBeMissed: boolean } {
  const row = db.all(
    "SELECT rescan_pending AS p, deletions_may_be_missed AS m FROM connector_instances WHERE id = ?",
    [id],
  )[0];
  return { pending: row?.p === 1, deletionsMayBeMissed: row?.m === 1 };
}

/**
 * Starts a rescan: drops the cursor (the next read starts from null, whether or not
 * this sync gets any page stored) and marks the rescan pending until it ends. It only
 * raises the deletions mark: the mark stays until a rescan ends, and the page that ends
 * it (finishRescan) is the one that clears it (I01-R17).
 */
export function beginRescan(db: SqlDriver, id: string, deletionsMayBeMissed: boolean): void {
  if (
    db.run(
      `UPDATE connector_instances
         SET cursor = NULL, rescan_pending = 1,
             deletions_may_be_missed = CASE WHEN ? = 1 THEN 1 ELSE deletions_may_be_missed END
       WHERE id = ?`,
      [deletionsMayBeMissed ? 1 : 0, id],
    ).changes !== 1
  ) {
    throw new Error(`connector instance ${id} is not registered`);
  }
}

/** Ends a pending rescan; call it in the transaction of the page that ends it. */
export function finishRescan(db: SqlDriver, id: string, deletionsMayBeMissed: boolean): void {
  if (
    db.run(
      "UPDATE connector_instances SET rescan_pending = 0, deletions_may_be_missed = ? WHERE id = ?",
      [deletionsMayBeMissed ? 1 : 0, id],
    ).changes !== 1
  ) {
    throw new Error(`connector instance ${id} is not registered`);
  }
}

export function writeCursor(db: SqlDriver, id: string, cursor: string): void {
  if (
    db.run("UPDATE connector_instances SET cursor = ? WHERE id = ?", [cursor, id]).changes !== 1
  ) {
    throw new Error(`connector instance ${id} is not registered`);
  }
}

export interface StoredSourceVersion {
  id: number;
  title: string;
  body: string;
  accessScope: string | null;
  /** The kind of the Connector instance the source came from; null if no such row. */
  connectorKind: string | null;
}

/** The row ID of one source's version (a job's source and fence version), or undefined. */
export function findSourceVersionId(
  db: SqlDriver,
  sourceId: number,
  version: number,
): number | undefined {
  return db.all("SELECT id FROM source_versions WHERE source_id = ? AND version = ?", [
    sourceId,
    version,
  ])[0]?.id as number | undefined;
}

/** One stored version with what the Broker needs to grade it, or undefined if absent. */
export function readSourceVersion(db: SqlDriver, id: number): StoredSourceVersion | undefined {
  const row = db.all(
    `SELECT v.id, v.title, v.body, s.access_scope, c.kind
       FROM source_versions v
       JOIN sources s ON s.id = v.source_id
       LEFT JOIN connector_instances c ON c.id = s.connector_instance_id
      WHERE v.id = ?`,
    [id],
  )[0];
  if (!row) return undefined;
  return {
    id: row.id as number,
    title: row.title as string,
    body: row.body as string,
    accessScope: row.access_scope as string | null,
    connectorKind: row.kind as string | null,
  };
}
