// RLD-C1, C2 (R1..R4): a restored database that was never finished says so itself (the setting `restore.pending`),
// so a start that finds the mark and no previous copy finishes it, and one that finds a previous copy stops.
// Real files in a temp directory.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_DIR,
  RESTORE_LAST_SETTING,
  RESTORE_PENDING_SETTING,
  createBackup,
  insertLocation,
  listLocations,
  newLocalId,
  openManifest,
  readSetting,
  registerConnectorInstance,
  saveConsent,
  saveSourceRecord,
  stageRestore,
  writePending,
  writeSetting,
  type BackupManifest,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import { applyPendingRestore, rollbackRestore, RestoreStateError } from "./restore-boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const PASSPHRASE = "correct horse battery staple";
const NOW = new Date("2026-11-24T03:00:00.000Z");

let root: string;
let data: string;
let backupId: string;
const live = () => join(data, CANONICAL_DB_FILE);
const before = () => join(data, BEFORE_RESTORE_FILE);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const options = () => ({
  dataDir: data,
  token: "t".repeat(43),
  allowedOrigins: [],
  secrets: NO_SECRET_STORE,
});

/** A backup holding a consent and a readable folder, staged and swapped in: a restored database not yet finished. */
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-restore-adopt-"));
  data = join(root, "data");
  const folder = join(root, "backups");
  mkdirSync(folder);
  const db = openCanonicalDb(data);
  registerConnectorInstance(db, "c1", "jsonl-import");
  saveSourceRecord(db, "c1", { namespace: "n", externalId: "a", title: "a", body: "본문" });
  saveConsent(db, {
    provider: "openai-compatible",
    destination: "https://example.invalid",
    policyVersion: "1",
    allowedClasses: ["public"],
    grantedAt: NOW.toISOString(),
  });
  insertLocation(db, {
    id: newLocalId(),
    type: "folder",
    displayPath: root,
    realPath: root,
    rootDev: "1",
    rootIno: "2",
    createdAt: NOW.toISOString(),
  });
  const { fileName } = createBackup({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    folder,
    passphrase: PASSPHRASE,
    now: NOW,
    embeddingSpace: null,
    vectorIndexSeq: null,
    scrypt: { N: 1024, r: 8, p: 1 },
  });
  const file = join(folder, fileName);
  backupId = (openManifest(file, PASSPHRASE).manifest as BackupManifest).backupId;
  const staged = stageRestore({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    file,
    passphrase: PASSPHRASE,
    confirmBackupId: backupId,
    now: NOW,
  });
  expect(staged.status).toBe("staged");
  db.close();
  expect(applyPendingRestore(data, openBetterSqlite3).applied).toBe(true);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("restore.adopt (RLD-C1, C2)", () => {
  it("C1: the previous copy removed by hand after an unverified undo, the restored database is finished at the next start", async () => {
    writeFileSync(before(), "not a database");
    expect(() =>
      rollbackRestore({ dataDir: data, applied: true, finished: false }, "start-failed"),
    ).toThrow(RestoreStateError);
    rmSync(before());

    const booted = await bootBackend(options());
    const consents = Number(booted.db.all("SELECT count(*) AS n FROM consents")[0]?.n);
    const states = listLocations(booted.db).map((l) => [l.state, l.stateReason]);
    const last = JSON.parse(readSetting(booted.db, RESTORE_LAST_SETTING) as string);
    const mark = readSetting(booted.db, RESTORE_PENDING_SETTING);
    await booted.server.close();
    booted.db.close();
    expect(consents).toBe(0);
    expect(states).toEqual([["paused", "restored"]]);
    expect(last).toMatchObject({ backupId, clearedConsents: 1, pausedLocations: 1 });
    expect(mark).toBeUndefined();
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it.each(["{not json", "null"])(
    "C2b: an unreadable or non-object mark (%s) is still a mark: the restored database is finished at the next start (RPF-C2, FUB-C1)",
    async (value) => {
      const marked = openBetterSqlite3(live());
      writeSetting(marked, RESTORE_PENDING_SETTING, value);
      marked.close();
      writeFileSync(before(), "not a database");
      expect(() =>
        rollbackRestore({ dataDir: data, applied: true, finished: false }, "start-failed"),
      ).toThrow(RestoreStateError);
      rmSync(before());

      const booted = await bootBackend(options());
      const consents = Number(booted.db.all("SELECT count(*) AS n FROM consents")[0]?.n);
      const states = listLocations(booted.db).map((l) => [l.state, l.stateReason]);
      const mark = readSetting(booted.db, RESTORE_PENDING_SETTING);
      await booted.server.close();
      booted.db.close();
      expect(consents).toBe(0);
      expect(states).toEqual([["paused", "restored"]]);
      expect(mark).toBeUndefined();
    },
  );

  it("C2: a restored database with its previous copy still there stops the start and moves nothing", async () => {
    writePending(data, { state: "failed", code: "start-failed" });
    const hashes = [sha(live()), sha(before())];
    await expect(bootBackend(options())).rejects.toMatchObject({
      name: "RestoreStateError",
      code: "restore-state-inconsistent",
    });
    expect([sha(live()), sha(before())]).toEqual(hashes);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(true);
  });
});
