// I04-R6, R7 (I04-T07): the installation's identity key, the keyed hash that
// replaces a purged source's identifier, and the one clean-up after `migrate`.
// Tests: identity.key, identity.hash, purge.legacy-residue.
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canariesLeft } from "@pki/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  IdentityKeyMissingError,
  ensureSourceByHash,
  ensureTombstoneSource,
  hashSourceIdentity,
  identityKey,
  prepareCanonicalDb,
} from "./identity.ts";
import { migrate, schemaVersion } from "./migrations.ts";
import { readSetting } from "./settings.ts";
import { findSourceId, registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { recordTombstone } from "./tombstones.ts";

let dir: string;
let db: SqlDriver;
const FILE = () => join(dir, "pki.sqlite");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-identity-"));
  db = openBetterSqlite3(FILE());
  prepareCanonicalDb(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const AT = "2026-11-22T00:00:00.000Z";
/** Length-prefixed (instance, namespace, external id): the hash input R7 names. */
function expectedHash(key: Uint8Array, parts: string[]): string {
  const mac = createHmac("sha256", key);
  for (const p of parts) {
    const bytes = Buffer.from(p, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    mac.update(length).update(bytes);
  }
  return mac.digest("hex");
}
const storedKey = () => db.all("SELECT key FROM identity_key")[0]?.key as Uint8Array;
/** Stores a source with one version, then purges it the way the entries do. */
function purged(externalId: string, namespace = "ns") {
  const saved = saveSourceRecord(db, "c1", { namespace, externalId, title: "t", body: "b" });
  if (saved.status !== "created") throw new Error(saved.status);
  recordTombstone(db, saved.sourceId, { reason: "source-deleted", lastRevision: null, at: AT });
  db.run("DELETE FROM source_versions WHERE source_id = ?", [saved.sourceId]);
  return saved.sourceId;
}
const row = (id: number) =>
  db.all("SELECT namespace, external_id, identity_hashed FROM sources WHERE id = ?", [id])[0];

describe("identity.key", () => {
  it("is created by the migration in the canonical database, 32 random bytes", () => {
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(14);
    expect(storedKey()).toHaveLength(32);
    const other = openBetterSqlite3(":memory:");
    migrate(other);
    expect(other.all("SELECT key FROM identity_key")[0]?.key).not.toEqual(storedKey());
  });

  it("hashes the length-prefixed (instance, namespace, external id) with HMAC-SHA-256", () => {
    const hash = identityKey(db, "c1", "ns", "e1");
    expect(hash).toBe(expectedHash(storedKey(), ["c1", "ns", "e1"]));
    expect(identityKey(db, "c1", "ns", "e1")).toBe(hash);
    // moving a character between neighbours changes the hash (length prefix)
    expect(identityKey(db, "c1", "a", "bc")).not.toBe(identityKey(db, "c1", "ab", "c"));
    expect(identityKey(db, "c2", "ns", "e1")).not.toBe(hash);
  });

  it("stops the start when a database with hashed sources lost its key, and makes no new key", () => {
    const id = purged("gone");
    hashSourceIdentity(db, id);
    db.run("DELETE FROM identity_key");
    expect(() => prepareCanonicalDb(db)).toThrow(IdentityKeyMissingError);
    expect(db.all("SELECT count(*) AS n FROM identity_key")[0]?.n).toBe(0);
  });

  it("does not store the deleted record's source again while the key is missing", () => {
    const id = purged("gone");
    hashSourceIdentity(db, id);
    const before = db.all("SELECT count(*) AS n FROM sources")[0]?.n;
    db.run("DELETE FROM identity_key");
    expect(() =>
      saveSourceRecord(db, "c1", { namespace: "ns", externalId: "gone", title: "t", body: "b" }),
    ).toThrow(IdentityKeyMissingError);
    expect(db.all("SELECT count(*) AS n FROM sources")[0]?.n).toBe(before);
    expect(db.all("SELECT count(*) AS n FROM identity_key")[0]?.n).toBe(0);
  });

  it("makes a new key only when no source is hashed (nothing is then forgotten)", () => {
    db.run("DELETE FROM identity_key");
    prepareCanonicalDb(db);
    expect(storedKey()).toHaveLength(32);
  });
});

describe("identity.hash", () => {
  it("replaces a purged source's namespace and external id with the keyed hash", () => {
    const id = purged("secret-ext-id", "secret-ns");
    expect(hashSourceIdentity(db, id)).toBe(true);
    const hash = identityKey(db, "c1", "secret-ns", "secret-ext-id");
    expect(row(id)).toEqual({ namespace: hash, external_id: hash, identity_hashed: 1 });
    expect(hashSourceIdentity(db, id)).toBe(false);
  });

  it("finds the hashed row by identity, plain first", () => {
    const id = purged("e1");
    hashSourceIdentity(db, id);
    expect(findSourceId(db, "c1", "ns", "e1")).toBe(id);
    expect(findSourceId(db, "c1", "ns", "other")).toBeUndefined();
    expect(findSourceId(db, "c2", "ns", "e1")).toBeUndefined();
  });

  it("keeps a source that still has a version in plain text", () => {
    const saved = saveSourceRecord(db, "c1", { externalId: "live", title: "t", body: "b" });
    if (saved.status !== "created") throw new Error(saved.status);
    recordTombstone(db, saved.sourceId, { reason: "source-deleted", lastRevision: null, at: AT });
    expect(hashSourceIdentity(db, saved.sourceId)).toBe(false);
    expect(row(saved.sourceId)?.external_id).toBe("live");
  });

  it("creates a never-seen source's row with the hash from the start", () => {
    const id = ensureTombstoneSource(db, {
      connectorInstanceId: "c1",
      namespace: "n",
      externalId: "ghost",
    });
    const hash = identityKey(db, "c1", "n", "ghost");
    expect(row(id)).toEqual({ namespace: hash, external_id: hash, identity_hashed: 1 });
    expect(
      ensureTombstoneSource(db, { connectorInstanceId: "c1", namespace: "n", externalId: "ghost" }),
    ).toBe(id);
    expect(db.all("SELECT count(*) AS n FROM sources")[0]?.n).toBe(1);
  });

  it("prepareCanonicalDb hashes the plain rows an earlier build left behind", () => {
    const id = purged("old-delete");
    const live = saveSourceRecord(db, "c1", { externalId: "alive", title: "t", body: "b" });
    expect(row(id)?.identity_hashed).toBe(0);
    prepareCanonicalDb(db);
    expect(row(id)?.identity_hashed).toBe(1);
    expect(findSourceId(db, "c1", "ns", "old-delete")).toBe(id);
    expect(live.status === "created" && row(live.sourceId)?.external_id).toBe("alive");
  });
});

describe("purge.legacy-residue: a clean-up that cannot finish", () => {
  /** A driver whose VACUUM fails while `failing.on`, as with no room for the copy. */
  const failing = { on: true };
  const withVacuumFailure = (inner: SqlDriver): SqlDriver => ({
    ...inner,
    exec: (sql) => {
      if (failing.on && sql === "VACUUM") throw new Error("database or disk is full");
      inner.exec(sql);
    },
  });

  it("does not stop the start, records nothing as done and tries again at the next start", () => {
    db.run("DELETE FROM settings WHERE key = 'purge.legacy-cleanup'");
    failing.on = true;
    expect(prepareCanonicalDb(withVacuumFailure(db))).toEqual({ legacyCleanup: "failed" });
    expect(readSetting(db, "purge.legacy-cleanup")).toBeUndefined();
    failing.on = false;
    expect(prepareCanonicalDb(withVacuumFailure(db))).toEqual({ legacyCleanup: "done" });
    expect(readSetting(db, "purge.legacy-cleanup")).toBe("done");
  });
});

describe("purge.legacy-residue", () => {
  const LEGACY = { body: "kvzlegacybody", old: "jwxlegacyword" };
  /** What a build without the settings left: deleted text still in the file. */
  function plantResidue(file: string, canary: string) {
    const raw = openBetterSqlite3(file);
    raw.exec("PRAGMA secure_delete = OFF");
    raw.run("INSERT INTO keyword_index (keyword_index, rank) VALUES ('secure-delete', 0)");
    registerConnectorInstance(raw, "c1", "test-fixtures");
    const saved = saveSourceRecord(raw, "c1", {
      externalId: `legacy-${canary.slice(0, 3)}`,
      title: "t",
      body: `x ${canary} y`,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    raw.run("DELETE FROM source_versions WHERE source_id = ?", [saved.sourceId]);
    raw.close();
  }

  it("clears an earlier deletion's residue once, and does not run again", () => {
    // beforeEach already started this database once: make it one that never was
    db.run("DELETE FROM settings WHERE key = 'purge.legacy-cleanup'");
    db.close();
    plantResidue(FILE(), LEGACY.body);
    // the planted residue is really there (else the clean-up proves nothing)
    expect(canariesLeft(dir, [LEGACY.body])).toEqual([LEGACY.body]);

    db = openBetterSqlite3(FILE());
    expect(readSetting(db, "purge.legacy-cleanup")).toBeUndefined();
    expect(prepareCanonicalDb(db)).toEqual({ legacyCleanup: "done" });
    expect(readSetting(db, "purge.legacy-cleanup")).toBe("done");
    db.close();
    expect(canariesLeft(dir, [LEGACY.body])).toEqual([]);

    // a second start does not run it: new residue stays where it is
    plantResidue(FILE(), LEGACY.old);
    db = openBetterSqlite3(FILE());
    expect(prepareCanonicalDb(db)).toEqual({ legacyCleanup: "skipped" });
    db.close();
    expect(canariesLeft(dir, [LEGACY.old])).toEqual([LEGACY.old]);
  });
});

describe("identity.ledger-lookup (F123)", () => {
  const plain = (externalId: string, instance = "c1") => {
    const saved = saveSourceRecord(db, instance, {
      namespace: "ns",
      externalId,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    return saved.sourceId;
  };
  const count = () => db.all("SELECT count(*) AS n FROM sources")[0]?.n;

  it("F123-C2 finds a plain source, a hashed row and an unseen identity through one shared index", () => {
    const index = new Map<string, Map<string, number>>();
    const a = plain("a");
    const hashedId = purged("b");
    hashSourceIdentity(db, hashedId);
    expect(ensureSourceByHash(db, "c1", identityKey(db, "c1", "ns", "a"), index)).toBe(a);
    expect(ensureSourceByHash(db, "c1", identityKey(db, "c1", "ns", "b"), index)).toBe(hashedId);

    const before = count();
    const unseen = identityKey(db, "c1", "ns", "never");
    const made = ensureSourceByHash(db, "c1", unseen, index);
    expect(row(made)).toEqual({ namespace: unseen, external_id: unseen, identity_hashed: 1 });
    expect(count()).toBe((before as number) + 1);
    expect(ensureSourceByHash(db, "c1", unseen, index)).toBe(made);
    expect(count()).toBe((before as number) + 1);

    // the same namespace and external id under another instance is another identity
    registerConnectorInstance(db, "c2", "test-fixtures");
    const other = plain("a", "c2");
    expect(ensureSourceByHash(db, "c2", identityKey(db, "c1", "ns", "a"), index)).not.toBe(a);
    expect(ensureSourceByHash(db, "c2", identityKey(db, "c2", "ns", "a"), index)).toBe(other);
  });

  it("F123-C2 reads no key for an instance with no plain source", () => {
    const index = new Map<string, Map<string, number>>();
    db.run("DELETE FROM identity_key");
    expect(() => ensureSourceByHash(db, "c1", "f".repeat(64), index)).not.toThrow();
    // a plain source appears (a hashed row is already there, so the row is written directly)
    db.run("INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, ?, ?)", [
      "c1",
      "ns",
      "a",
    ]);
    expect(() => ensureSourceByHash(db, "c1", "e".repeat(64), new Map())).toThrow(
      IdentityKeyMissingError,
    );
  });

  it("F123-C3 still finds a source the run hashed after the index was built", () => {
    const index = new Map<string, Map<string, number>>();
    const id = purged("a");
    const hash = identityKey(db, "c1", "ns", "a");
    // a miss builds the index while the source is still plain
    ensureSourceByHash(db, "c1", identityKey(db, "c1", "ns", "other"), index);
    expect(hashSourceIdentity(db, id)).toBe(true);
    const before = count();
    expect(ensureSourceByHash(db, "c1", hash, index)).toBe(id);
    expect(count()).toBe(before);
  });
});
