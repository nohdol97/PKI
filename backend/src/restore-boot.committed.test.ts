// H01F-C7 (R7): a restore whose finish already committed is not undone by a later failing start. The finish's
// record (`restore.last`) in the live file, equal to the marker's backup and staging time, makes `finished` true.
// Real files in a temp directory.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BEFORE_RESTORE_FILE,
  createBackup,
  openManifest,
  registerConnectorInstance,
  saveSourceRecord,
  stageRestore,
  type BackupManifest,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import {
  RestoreCrash,
  applyPendingRestore,
  finishRestore,
  type RestoreStep,
} from "./restore-boot.ts";

const PASSPHRASE = "correct horse battery staple";
const NOW = new Date("2026-11-23T03:00:00.000Z");
const REPORT = { reapplied: 0, embeddingSpace: null, now: NOW };

let root: string;
let data: string;
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-restore-committed-"));
  data = join(root, "data");
  const folder = join(root, "backups");
  mkdirSync(folder);
  const db = openCanonicalDb(data);
  registerConnectorInstance(db, "c1", "jsonl-import");
  saveSourceRecord(db, "c1", { namespace: "n", externalId: "a", title: "a", body: "본문" });
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
  const manifest = openManifest(file, PASSPHRASE).manifest as BackupManifest;
  const staged = stageRestore({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    file,
    passphrase: PASSPHRASE,
    confirmBackupId: manifest.backupId,
    now: NOW,
  });
  expect(staged.status).toBe("staged");
  db.close();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A start that applies and finishes, then dies at `step`. */
function crashAt(step: RestoreStep): void {
  let crashed = false;
  try {
    const run = applyPendingRestore(data, openBetterSqlite3);
    const db = openCanonicalDb(data);
    run.db = db;
    try {
      finishRestore(db, run, REPORT, { crashAfter: step });
    } finally {
      db.close();
    }
  } catch (error) {
    crashed = error instanceof RestoreCrash;
  }
  expect(crashed).toBe(true);
}

describe("restore.committed (H01F-C7)", () => {
  it("after the finish committed, applying again reports finished and leaves the files as they are", () => {
    crashAt("after-commit");
    const liveFile = join(data, CANONICAL_DB_FILE);
    const hashes = [sha(liveFile), sha(join(data, BEFORE_RESTORE_FILE))];
    const run = applyPendingRestore(data, openBetterSqlite3);
    expect(run).toMatchObject({ applied: true, finished: true });
    expect([sha(liveFile), sha(join(data, BEFORE_RESTORE_FILE))]).toEqual(hashes);
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(true);
  });

  it("before the finish committed, applying again does not report finished", () => {
    crashAt("before-commit");
    const run = applyPendingRestore(data, openBetterSqlite3);
    expect(run).toMatchObject({ applied: true, finished: false });
  });
});
