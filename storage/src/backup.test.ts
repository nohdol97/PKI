// H01-C1a (R1, R3: the snapshot and its manifest are of one moment and describe what it holds) and the storage
// half of H01-C2a (R9: a file that is refused changes nothing; an older schema is lifted while staging).
// Real database files and real backup files in a temp directory.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  BACKUP_FOLDER_SETTING,
  BACKUP_TMP_DIR,
  RESTORE_DIR,
  PENDING_FILE,
  STAGED_FILE,
  createBackup,
  createSnapshot,
  listBackups,
  installationFingerprint,
  readPending,
  RestoreMarkerError,
  readSnapshotFacts,
  removeRestoreArtifacts,
  stageRestore,
  type BackupManifest,
} from "./backup.ts";
import { decryptSnapshot, openManifest, writeBackupFile } from "./backup-file.ts";
import { prepareCanonicalDb, readKey } from "./identity.ts";
import { insertItem, saveFact, saveRelation, type KnowledgeAttributes } from "./knowledge.ts";
import { migrate, migrations, schemaVersion } from "./migrations.ts";
import { registerJob } from "./jobs.ts";
import { readSetting } from "./settings.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const PASSPHRASE = "correct horse battery staple";
const FAST = { N: 1024, r: 8, p: 1 };
const NOW = new Date("2026-11-23T01:02:03.000Z");
const CANARY = "카나리-백업-91c2";
const SPACE = { modelId: "m", revision: "r1", dimension: 4 };
const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "verified",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};

let root: string;
let data: string;
let folder: string;
let live: SqlDriver;
const liveFile = () => join(data, "pki.sqlite");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A database as the backend opens it, with two sources, knowledge rows and a queued job. */
function seeded(file: string, versions?: number): SqlDriver {
  const db = openBetterSqlite3(file);
  if (versions === undefined) prepareCanonicalDb(db);
  else migrate(db, migrations.slice(0, versions));
  if (versions === undefined) {
    registerConnectorInstance(db, "c1", "jsonl-import");
    saveSourceRecord(db, "c1", { namespace: "n", externalId: "a", title: "A", body: CANARY });
    saveSourceRecord(db, "c1", { namespace: "n", externalId: "b", title: "B", body: "다른 본문" });
    const x = insertItem(db, { type: "project", name: "X", ...attrs });
    const y = insertItem(db, { type: "system", name: "Y", ...attrs });
    saveFact(db, { itemId: x, kind: "k", value: "v", ...attrs });
    saveRelation(db, { subjectId: x, type: "T", objectId: y, ...attrs });
    registerJob(db, { kind: "projection-rebuild", target: "engine" });
  }
  return db;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-backup-"));
  data = join(root, "data");
  folder = join(root, "backups");
  mkdirSync(data);
  mkdirSync(folder);
  live = seeded(liveFile());
});
afterEach(() => {
  live.close();
  rmSync(root, { recursive: true, force: true });
});

const make = (db = live, extra: Partial<Parameters<typeof createBackup>[0]> = {}) =>
  createBackup({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    folder,
    passphrase: PASSPHRASE,
    now: NOW,
    embeddingSpace: SPACE,
    vectorIndexSeq: 7,
    scrypt: FAST,
    ...extra,
  });
const stage = (
  fileName: string,
  extra: Partial<Parameters<typeof stageRestore>[0]> = {},
  into: SqlDriver = live,
) => {
  const manifest = openManifest(join(folder, fileName), PASSPHRASE).manifest as BackupManifest;
  return stageRestore({
    db: into,
    open: openBetterSqlite3,
    dataDir: data,
    file: join(folder, fileName),
    passphrase: PASSPHRASE,
    confirmBackupId: manifest.backupId,
    now: NOW,
    ...extra,
  });
};

describe("backup.manifest and snapshot (H01-C1a)", () => {
  it("the manifest counts, numbers and embedding space are those of the snapshot, and the file name and folder are recorded", () => {
    const { fileName, manifest } = make();
    expect(fileName).toMatch(/^pki-backup-20261123T010203Z\.pkibak$/);
    expect(readSetting(live, BACKUP_FOLDER_SETTING)).toBeUndefined(); // the folder is the API's to record
    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: NOW.toISOString(),
      schemaVersion: schemaVersion(live),
      embeddingSpace: SPACE,
      vectorIndexSeq: 7,
      counts: {
        sources: 2,
        sourceVersions: 2,
        items: 2,
        facts: 1,
        relations: 1,
        openJobs: 1,
        tombstones: 0,
        feedback: 0,
      },
    });
    // the installation is named by a keyed fingerprint, never by the identity key itself
    expect(manifest.installation).toBe(installationFingerprint(live));
    expect(manifest.installation).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain(
      Buffer.from(readKey(live) as Uint8Array).toString("hex"),
    );
    // the snapshot is the file the manifest says: unpack it and read it again
    const out = join(root, "unpacked.sqlite");
    const done = decryptSnapshot(join(folder, fileName), PASSPHRASE, out);
    expect(done.manifest).toEqual(manifest);
    expect(sha(out)).toBe(manifest.snapshotSha256);
    expect(readFileSync(out).length).toBe(manifest.snapshotBytes);
    const copy = openBetterSqlite3(out);
    const facts = readSnapshotFacts(copy);
    copy.close();
    expect({ ...facts }).toMatchObject({
      schemaVersion: manifest.schemaVersion,
      changeSeq: manifest.changeSeq,
      ledgerSeq: manifest.ledgerSeq,
      counts: manifest.counts,
    });
    // no plaintext stays: the temporary snapshot folder is empty and the file has no canary
    expect(readdirSync(join(data, BACKUP_TMP_DIR))).toEqual([]);
    expect(readFileSync(join(folder, fileName)).includes(CANARY)).toBe(false);
    expect(listBackups(folder).map((b) => b.fileName)).toEqual([fileName]);
  });

  it("a row written after the snapshot is in neither the manifest facts nor the copy", () => {
    const snapshot = createSnapshot(live, data);
    saveSourceRecord(live, "c1", { namespace: "n", externalId: "later", title: "L", body: "나중" });
    const copy = openBetterSqlite3(snapshot);
    expect(readSnapshotFacts(copy).counts.sources).toBe(2);
    expect(copy.all("SELECT count(*) AS n FROM sources WHERE external_id = 'later'")[0]?.n).toBe(0);
    copy.close();
    rmSync(snapshot);
    expect(readSnapshotFacts(live).counts.sources).toBe(3);
  });

  it("a name that exists is not overwritten and leaves no partial file or snapshot", () => {
    make();
    expect(() => make()).toThrow();
    expect(readdirSync(folder).filter((n) => n.endsWith(".partial"))).toEqual([]);
    expect(readdirSync(join(data, BACKUP_TMP_DIR))).toEqual([]);
  });
});

describe("restore.stage (H01-C2a, storage half)", () => {
  /** A fresh installation's data folder: no sources, nothing deleted. */
  const emptyInstall = () => {
    const file = join(root, "empty.sqlite");
    return openBetterSqlite3(file);
  };

  it("stages a same-installation backup: a verified staged file, the marker, and the live file untouched", () => {
    const { fileName, manifest } = make();
    const before = sha(liveFile());
    const result = stage(fileName);
    expect(result.status).toBe("staged");
    expect(sha(liveFile())).toBe(before);
    expect(readPending(data)).toMatchObject({ state: "staged", backupId: manifest.backupId });
    const staged = openBetterSqlite3(join(data, RESTORE_DIR, STAGED_FILE));
    expect(readSnapshotFacts(staged).counts).toEqual(manifest.counts);
    expect(staged.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    staged.close();
    // a second request while one is waiting is refused; cancelling clears everything
    expect(stage(fileName)).toEqual({ status: "refused", code: "already-pending" });
    removeRestoreArtifacts(data);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it.each([
    ["wrong passphrase", "wrong-passphrase", { passphrase: "not the passphrase" }],
    ["a confirmation of another backup", "confirm-mismatch", { confirmBackupId: "other-id" }],
  ] as const)(
    "refuses %s with %s, the live file byte for byte and no restore folder",
    (_n, code, extra) => {
      const { fileName } = make();
      const before = sha(liveFile());
      expect(stage(fileName, extra)).toEqual({ status: "refused", code });
      expect(sha(liveFile())).toBe(before);
      expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
    },
  );

  it("refuses a manifest that lies about the snapshot as damaged (encrypted correctly: only the hash check can see it)", () => {
    const snapshot = createSnapshot(live, data);
    writeBackupFile(join(folder, "lying.pkibak"), {
      passphrase: PASSPHRASE,
      createdAt: NOW.toISOString(),
      schemaVersion: schemaVersion(live),
      manifest: { ...make().manifest, backupId: "liar", snapshotSha256: "0".repeat(64) },
      snapshotPath: snapshot,
      scrypt: FAST,
    });
    rmSync(snapshot);
    const before = sha(liveFile());
    expect(stage("lying.pkibak", { confirmBackupId: "liar" })).toEqual({
      status: "refused",
      code: "damaged",
    });
    expect(sha(liveFile())).toBe(before);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it("refuses a flipped byte with damaged when the confirmation matches", () => {
    const { fileName, manifest } = make();
    const bytes = readFileSync(join(folder, fileName));
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] as number) ^ 1;
    writeFileSync(join(folder, "flipped.pkibak"), bytes);
    expect(stage("flipped.pkibak", { confirmBackupId: manifest.backupId })).toEqual({
      status: "refused",
      code: "damaged",
    });
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it("refuses a backup of a newer schema than this build (newer-schema), the live file untouched", () => {
    const newer = seeded(join(root, "newer.sqlite"));
    newer.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    const { fileName } = make(newer);
    newer.close();
    const before = sha(liveFile());
    expect(stage(fileName)).toEqual({ status: "refused", code: "newer-schema" });
    expect(sha(liveFile())).toBe(before);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it("refuses another installation's backup onto a database that holds sources (D8), but takes it onto an empty one", () => {
    const other = seeded(join(root, "other.sqlite"));
    const { fileName } = make(other);
    other.close();
    const before = sha(liveFile());
    expect(stage(fileName)).toEqual({ status: "refused", code: "other-installation" });
    expect(sha(liveFile())).toBe(before);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);

    const empty = emptyInstall();
    prepareCanonicalDb(empty);
    expect(stage(fileName, {}, empty).status).toBe("staged");
    empty.close();
  });

  it("refuses a snapshot that carries a trigger or any schema object the migrations do not make (S1), the live file untouched and no staging left", () => {
    const crafted = seeded(join(root, "crafted.sqlite"));
    crafted.exec(`CREATE TRIGGER keep_consent AFTER DELETE ON consents BEGIN
      INSERT INTO consents (provider, destination, policy_version, allowed_classes, granted_at)
      VALUES (old.provider, old.destination, old.policy_version, old.allowed_classes, old.granted_at); END`);
    const { fileName } = make(crafted);
    crafted.close();
    const empty = emptyInstall();
    prepareCanonicalDb(empty);
    const emptyFile = join(root, "empty.sqlite");
    const before = sha(emptyFile);
    expect(stage(fileName, {}, empty)).toEqual({ status: "refused", code: "foreign-schema" });
    expect(sha(emptyFile)).toBe(before);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
    // a view and a changed table are refused the same way
    const odd = seeded(join(root, "odd.sqlite"));
    odd.exec("CREATE VIEW sneaky AS SELECT * FROM consents");
    const viewed = make(odd, { now: new Date("2026-11-23T02:00:00Z") });
    odd.close();
    expect(stage(viewed.fileName, {}, empty)).toEqual({
      status: "refused",
      code: "foreign-schema",
    });
    empty.close();
  });

  it("readPending answers undefined only for a marker that is not there; an unreadable one is an error (M2)", () => {
    expect(readPending(data)).toBeUndefined();
    mkdirSync(join(data, RESTORE_DIR));
    expect(readPending(data)).toBeUndefined();
    writeFileSync(join(data, RESTORE_DIR, PENDING_FILE), '{"state":"sta');
    expect(() => readPending(data)).toThrow(RestoreMarkerError);
    // a marker that exists but cannot be read (here: a folder in its place) is no "none" either
    rmSync(join(data, RESTORE_DIR, PENDING_FILE));
    mkdirSync(join(data, RESTORE_DIR, PENDING_FILE));
    expect(() => readPending(data)).toThrow(RestoreMarkerError);
    rmSync(join(data, RESTORE_DIR, PENDING_FILE), { recursive: true });
    writeFileSync(join(data, RESTORE_DIR, PENDING_FILE), '{"state":"nonsense"}');
    expect(() => readPending(data)).toThrow(RestoreMarkerError);
  });

  it("lifts a backup of an older schema to this build's number while staging", () => {
    const older = seeded(join(root, "older.sqlite"), migrations.length - 1);
    const { fileName } = make(older);
    older.close();
    const empty = emptyInstall();
    prepareCanonicalDb(empty);
    expect(stage(fileName, {}, empty)).toMatchObject({ status: "staged" });
    empty.close();
    const staged = openBetterSqlite3(join(data, RESTORE_DIR, STAGED_FILE));
    expect(schemaVersion(staged)).toBe(migrations.length);
    staged.close();
    expect(existsSync(join(data, RESTORE_DIR, PENDING_FILE))).toBe(true);
  });
});
