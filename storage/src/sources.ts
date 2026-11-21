// Canonical source storage (V01-R7). A source is identified by Connector
// instance + external id; a version is added only when its content hash differs
// from the source's latest version, numbered one past it (V02-R3). Callers wrap a
// page in one transaction.
import { createHash } from "node:crypto";
import type { SqlDriver } from "./sql-driver.ts";

export interface StoredRecord {
  externalId: string;
  title: string;
  body: string;
}

/** Title and body bound together: JSON array encoding keeps "ab"+"c" apart from "a"+"bc". */
export function contentHash(title: string, body: string): string {
  return createHash("sha256")
    .update(JSON.stringify([title, body]))
    .digest("hex");
}

export function saveSourceRecord(
  db: SqlDriver,
  connectorInstanceId: string,
  record: StoredRecord,
): "created" | "unchanged" {
  db.run(
    "INSERT INTO sources (connector_instance_id, external_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
    [connectorInstanceId, record.externalId],
  );
  const sourceId = db.all(
    "SELECT id FROM sources WHERE connector_instance_id = ? AND external_id = ?",
    [connectorInstanceId, record.externalId],
  )[0]?.id as number;
  const hash = contentHash(record.title, record.body);
  const latest = db.all(
    "SELECT content_hash, version FROM source_versions WHERE source_id = ? ORDER BY id DESC LIMIT 1",
    [sourceId],
  )[0];
  if (latest?.content_hash === hash) return "unchanged";
  db.run(
    "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (?, ?, ?, ?, ?)",
    [sourceId, ((latest?.version as number | undefined) ?? 0) + 1, hash, record.title, record.body],
  );
  return "created";
}

/** Records the instance's kind on first sight and refuses to rebind it to another kind. */
export function registerConnectorInstance(db: SqlDriver, id: string, kind: string): void {
  db.run("INSERT INTO connector_instances (id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING", [
    id,
    kind,
  ]);
  const stored = db.all("SELECT kind FROM connector_instances WHERE id = ?", [id])[0]?.kind;
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
