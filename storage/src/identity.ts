// The identity of a purged source (I04-R7): the namespace and external id in its
// `sources` row become one keyed hash (HMAC-SHA-256 over the length-prefixed
// instance, namespace and external id), so the file no longer names what was
// deleted. The key is a row of the canonical database made by the v14 migration;
// it is never made quietly later: a database with hashed sources and no key stops
// the start. Finding a source by identity tries the plain row, then the hash.
// `prepareCanonicalDb` is what opens the canonical store: `migrate`, the key
// check, hashing the plain rows an earlier build left, and one clean-up of what
// earlier deletions left in the file (I04-R6).
import { createHmac, randomBytes } from "node:crypto";
import { migrate, schemaVersion } from "./migrations.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

export interface SourceIdentity {
  connectorInstanceId: string;
  namespace: string;
  externalId: string;
}

/** The key row is gone while a source's identifier is a hash: no deletion could be told apart. */
export class IdentityKeyMissingError extends Error {
  constructor() {
    super(
      "the identity key is missing from the database while deleted sources are stored by hash; " +
        "import and sync stay closed (restore the database that holds the key)",
    );
    this.name = "IdentityKeyMissingError";
  }
}

export function readKey(db: SqlDriver): Uint8Array | undefined {
  return db.all("SELECT key FROM identity_key WHERE id = 1")[0]?.key as Uint8Array | undefined;
}

/** The keyed hash (hex) of an identity; throws `IdentityKeyMissingError` without a key. */
export function identityKey(
  db: SqlDriver,
  connectorInstanceId: string,
  namespace: string,
  externalId: string,
): string {
  const key = readKey(db);
  if (!key) throw new IdentityKeyMissingError();
  const mac = createHmac("sha256", key);
  for (const part of [connectorInstanceId, namespace, externalId]) {
    const bytes = Buffer.from(part, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length).update(bytes);
  }
  return mac.digest("hex");
}

const hasHashedSources = (db: SqlDriver) =>
  db.all("SELECT 1 FROM sources WHERE identity_hashed = 1 LIMIT 1").length > 0;

/** The id of the source whose hashed row stands for this identity, or undefined. */
export function findHashedSourceId(
  db: SqlDriver,
  connectorInstanceId: string,
  namespace: string,
  externalId: string,
): number | undefined {
  // no hashed row: nothing to find, and no key is needed (or made) to say so
  if (!hasHashedSources(db)) return undefined;
  const hash = identityKey(db, connectorInstanceId, namespace, externalId);
  return db.all(
    // namespace too: a hashed row holds the hash in both, and the unique index starts there
    "SELECT id FROM sources WHERE connector_instance_id = ? AND namespace = ? AND external_id = ? AND identity_hashed = 1",
    [connectorInstanceId, hash, hash],
  )[0]?.id as number | undefined;
}

/**
 * The source row of an identity a tombstone names, made with the hash from the
 * start when the source was never seen (the plain identity is never written).
 */
export function ensureTombstoneSource(db: SqlDriver, identity: SourceIdentity): number {
  const { connectorInstanceId, namespace, externalId } = identity;
  const plain = db.all(
    "SELECT id FROM sources WHERE connector_instance_id = ? AND namespace = ? AND external_id = ?",
    [connectorInstanceId, namespace, externalId],
  )[0]?.id as number | undefined;
  const found = plain ?? findHashedSourceId(db, connectorInstanceId, namespace, externalId);
  if (found !== undefined) return found;
  const hash = identityKey(db, connectorInstanceId, namespace, externalId);
  return db.run(
    "INSERT INTO sources (connector_instance_id, namespace, external_id, identity_hashed) VALUES (?, ?, ?, 1)",
    [connectorInstanceId, hash, hash],
  ).lastInsertRowid;
}

/**
 * The source of a ledger line (I04-R17): the connector instance and the keyed hash of its identity.
 * A hashed row holds the hash itself; a source still held plain is found by hashing the plain
 * identities of that instance (a restored database older than the deletion). A source never seen
 * gets its hashed row, as a tombstone for an unseen source does.
 */
export function ensureSourceByHash(
  db: SqlDriver,
  connectorInstanceId: string,
  hash: string,
): number {
  const hashed = db.all(
    "SELECT id FROM sources WHERE connector_instance_id = ? AND namespace = ? AND external_id = ? AND identity_hashed = 1",
    [connectorInstanceId, hash, hash],
  )[0]?.id as number | undefined;
  if (hashed !== undefined) return hashed;
  for (const row of db.all(
    "SELECT id, namespace, external_id FROM sources WHERE connector_instance_id = ? AND identity_hashed = 0",
    [connectorInstanceId],
  )) {
    const identity = identityKey(
      db,
      connectorInstanceId,
      row.namespace as string,
      row.external_id as string,
    );
    if (identity === hash) return row.id as number;
  }
  return db.run(
    "INSERT INTO sources (connector_instance_id, namespace, external_id, identity_hashed) VALUES (?, ?, ?, 1)",
    [connectorInstanceId, hash, hash],
  ).lastInsertRowid;
}

/** The connector instance and keyed hash that name a stored source in the ledger. */
export function sourceLedgerName(
  db: SqlDriver,
  sourceId: number,
): { connectorInstanceId: string; connectorKind: string; identityHash: string } {
  const row = db.all(
    "SELECT connector_instance_id, namespace, external_id, identity_hashed FROM sources WHERE id = ?",
    [sourceId],
  )[0];
  if (!row) throw new RangeError(`source ${sourceId} does not exist`);
  const instance = row.connector_instance_id as string;
  return {
    connectorInstanceId: instance,
    connectorKind: db.all("SELECT kind FROM connector_instances WHERE id = ?", [instance])[0]
      ?.kind as string,
    identityHash:
      row.identity_hashed === 1
        ? (row.namespace as string)
        : identityKey(db, instance, row.namespace as string, row.external_id as string),
  };
}

/**
 * Replaces a purged source's plain namespace and external id by the hash. Only a
 * source with a tombstone and no version left is hashed: one that holds versions
 * (a lift, then new arrivals) is live and keeps the plain identity its Connector
 * reads. Returns whether the row changed.
 */
export function hashSourceIdentity(db: SqlDriver, sourceId: number): boolean {
  const row = db.all(
    `SELECT connector_instance_id AS instance, namespace, external_id AS externalId
       FROM sources s
      WHERE s.id = ? AND s.identity_hashed = 0
        AND EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM source_versions v WHERE v.source_id = s.id)`,
    [sourceId],
  )[0];
  if (!row) return false;
  const hash = identityKey(
    db,
    row.instance as string,
    row.namespace as string,
    row.externalId as string,
  );
  db.run("UPDATE sources SET namespace = ?, external_id = ?, identity_hashed = 1 WHERE id = ?", [
    hash,
    hash,
    sourceId,
  ]);
  return true;
}

export interface PreparedCanonicalDb {
  /** `skipped`: done by an earlier start. `failed`: tried again at the next start. */
  legacyCleanup: "done" | "skipped" | "failed";
}

/** The setting that holds `done` once the one-time clean-up finished (the status API reads it). */
export const LEGACY_CLEANUP_SETTING = "purge.legacy-cleanup";

/**
 * Brings a canonical database up to date before anything opens it (I04-R6, R7):
 * `migrate` (an older database takes the ledger's key, `options.ledgerKey`); a key (made only when no source is hashed; otherwise a start error);
 * the plain rows of earlier tombstones hashed; and once, FTS `optimize` and
 * `VACUUM` (outside any transaction: `VACUUM` cannot run in one) for the traces
 * earlier deletions left. A `VACUUM` that fails (no room for the copy) does not
 * stop the start: it is tried again at the next one.
 */
export function prepareCanonicalDb(
  db: SqlDriver,
  options: { ledgerKey?: Uint8Array | undefined } = {},
): PreparedCanonicalDb {
  // a database from before v14 holds no key and no hashed row: the key the migration makes
  // is a stranger to the ledger beside it, so the ledger's key is taken first (I04-R17)
  const keyless = schemaVersion(db) < 14;
  migrate(db);
  if (keyless && options.ledgerKey?.length === 32) {
    db.run("UPDATE identity_key SET key = ? WHERE id = 1", [options.ledgerKey]);
  }
  if (!readKey(db)) {
    if (hasHashedSources(db)) throw new IdentityKeyMissingError();
    db.run("INSERT INTO identity_key (id, key) VALUES (1, ?)", [randomBytes(32)]);
  }
  db.transaction(() => {
    const ids = db.all(
      `SELECT s.id FROM sources s WHERE s.identity_hashed = 0
          AND EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = s.id)`,
    );
    for (const { id } of ids) hashSourceIdentity(db, id as number);
  });
  if (readSetting(db, LEGACY_CLEANUP_SETTING) === "done") return { legacyCleanup: "skipped" };
  try {
    db.run("INSERT INTO keyword_index (keyword_index) VALUES ('optimize')");
    db.exec("VACUUM");
  } catch {
    return { legacyCleanup: "failed" };
  }
  writeSetting(db, LEGACY_CLEANUP_SETTING, "done");
  return { legacyCleanup: "done" };
}
