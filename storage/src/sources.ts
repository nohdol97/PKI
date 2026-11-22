// Canonical source storage (V01-R7). A source is identified by Connector
// instance + namespace + external id (I01-R8). The product numbers each
// source's versions itself, one past its latest (V02-R3); a Connector's own
// version of a record, when it gives one, is kept as the version's `revision`
// and only orders arrivals (cross-spec decision D1). Callers wrap a page in one
// transaction.
import { createHash } from "node:crypto";
import type { SqlDriver } from "./sql-driver.ts";

export interface StoredRecord {
  /** Where the external id is unique within the instance; absent is "", its one range (I01-R5). */
  namespace?: string | undefined;
  externalId: string;
  title: string;
  body: string;
  /** The Connector's own version of the record, if it has one (a JSONL line's `version`). */
  revision?: number | undefined;
}

export type SaveOutcome =
  | { status: "created"; sourceId: number; version: number }
  | { status: "unchanged" }
  | { status: "refused"; reason: "revision-not-newer" | "tombstoned" };

/** Title and body bound together: JSON array encoding keeps "ab"+"c" apart from "a"+"bc". */
export function contentHash(title: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([title, body]))
    .digest("hex");
}

/** The source's latest version: the (source_id, version) index, no sort. */
export const LATEST_VERSION_SQL =
  "SELECT content_hash, version, revision FROM source_versions WHERE source_id = ? ORDER BY version DESC LIMIT 1";

/**
 * Adds a version unless the content equals the latest's, or the same revision with
 * the same content is stored already. With a revision, the
 * same revision is no new version, and an equal or lower revision with other
 * content is refused (provisional; I01 owns the general revision rule). A version
 * the tombstone would block is refused here, before its trigger aborts the
 * caller's transaction. A refusal writes nothing.
 */
export function saveSourceRecord(
  db: SqlDriver,
  connectorInstanceId: string,
  record: StoredRecord,
): SaveOutcome {
  const sourceId = ensureSourceId(
    db,
    connectorInstanceId,
    record.namespace ?? "",
    record.externalId,
  );
  const hash = contentHash(record.title, record.body);
  const latest = db.all(LATEST_VERSION_SQL, [sourceId])[0];
  if (latest?.content_hash === hash) return { status: "unchanged" };
  // An older line already stored (same revision, same content) is nothing new:
  // re-importing a file with several versions of a source reports no error.
  // Provisional until I01's general revision rule (sources.last_revision).
  if (
    record.revision !== undefined &&
    db.all(
      "SELECT 1 FROM source_versions WHERE source_id = ? AND revision = ? AND content_hash = ?",
      [sourceId, record.revision, hash],
    ).length > 0
  ) {
    return { status: "unchanged" };
  }
  const latestRevision = latest?.revision as number | null | undefined;
  if (
    record.revision !== undefined &&
    latestRevision != null &&
    record.revision <= latestRevision
  ) {
    return { status: "refused", reason: "revision-not-newer" };
  }
  // Provisional until I01-T02 judges arrivals by revision: a tombstone not lifted
  // blocks the source while no version stands above its cover (I04-R9).
  const tombstone = db.all("SELECT covers_version, lifted_at FROM tombstones WHERE source_id = ?", [
    sourceId,
  ])[0];
  if (
    tombstone &&
    tombstone.lifted_at === null &&
    ((latest?.version as number | undefined) ?? 0) <= (tombstone.covers_version as number)
  ) {
    return { status: "refused", reason: "tombstoned" };
  }
  const version = nextSourceVersion(db, sourceId);
  db.run(
    "INSERT INTO source_versions (source_id, version, content_hash, title, body, revision) VALUES (?, ?, ?, ?, ?, ?)",
    [sourceId, version, hash, record.title, record.body, record.revision ?? null],
  );
  return { status: "created", sourceId, version };
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
  db.run(
    "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    [connectorInstanceId, namespace, externalId],
  );
  return findSourceId(db, connectorInstanceId, namespace, externalId) as number;
}

/** The id of the source an instance names `externalId` in `namespace`, or undefined if never stored. */
export function findSourceId(
  db: SqlDriver,
  connectorInstanceId: string,
  namespace: string,
  externalId: string,
): number | undefined {
  return db.all(
    "SELECT id FROM sources WHERE connector_instance_id = ? AND namespace = ? AND external_id = ?",
    [connectorInstanceId, namespace, externalId],
  )[0]?.id as number | undefined;
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
