// H01-C2b (R11, R12, R13): the swap at start is crash-safe at every step boundary (a fault after each step,
// then a fresh start, on real files), the finish transaction does what R12 lists, and a start that fails after
// the swap puts the previous data back. Real files in a temp directory; nothing of `fs` is mocked.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BEFORE_RESTORE_FILE,
  RESTORE_DIR,
  RESTORE_LAST_SETTING,
  STAGED_FILE,
  createBackup,
  insertLocation,
  leaseNextJob,
  listLocations,
  newLocalId,
  openManifest,
  readPending,
  RestoreMarkerError,
  readSetting,
  registerConnectorInstance,
  registerJob,
  saveConsent,
  saveSourceRecord,
  stageRestore,
  defaultScopePolicy,
  type DerivativeRegistry,
  type BackupManifest,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import { LedgerReapplyError, createProductRegistry, userDelete } from "@pki/knowledge-engine";
import { bootBackend } from "./boot.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";
import {
  RestoreCrash,
  RestoreStateError,
  rollbackRestore,
  applyPendingRestore,
  finishRestore,
  type RestoreStep,
} from "./restore-boot.ts";

const PASSPHRASE = "correct horse battery staple";
const FAST = { N: 1024, r: 8, p: 1 };
const NOW = new Date("2026-11-23T03:00:00.000Z");

let root: string;
let data: string;
let folder: string;
let before: { sha: string; sources: number };
const live = () => join(data, CANONICAL_DB_FILE);
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sourceCount = (db: SqlDriver) => Number(db.all("SELECT count(*) AS n FROM sources")[0]?.n);

/** Opens a copy, so that looking at a database never changes the file under test. */
function healthy(path: string): boolean {
  const copy = join(root, `check-${Math.random().toString(36).slice(2)}.sqlite`);
  copyFileSync(path, copy);
  const db = openBetterSqlite3(copy);
  try {
    return db.all("PRAGMA integrity_check")[0]?.integrity_check === "ok";
  } finally {
    db.close();
  }
}

/**
 * A data folder whose backup holds two sources, the live database a third one that came after, and a restore
 * staged from that backup: the state a user is in when they quit the app after asking for the restore.
 */
function stagedFolder(withFolder = false): void {
  const db = openCanonicalDb(data);
  registerConnectorInstance(db, "c1", "jsonl-import");
  for (const externalId of ["a", "b"]) {
    saveSourceRecord(db, "c1", { namespace: "n", externalId, title: externalId, body: "본문" });
  }
  if (withFolder) {
    insertLocation(db, {
      id: newLocalId(),
      type: "folder",
      displayPath: root,
      realPath: root,
      rootDev: "1",
      rootIno: "2",
      createdAt: NOW.toISOString(),
    });
  }
  const { fileName } = createBackup({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    folder,
    passphrase: PASSPHRASE,
    now: NOW,
    embeddingSpace: null,
    vectorIndexSeq: null,
    scrypt: FAST,
  });
  saveSourceRecord(db, "c1", { namespace: "n", externalId: "after", title: "c", body: "나중" });
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
  expect(sourceCount(db)).toBe(3);
  db.close();
  before = { sha: sha(live()), sources: 3 };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pki-restore-boot-"));
  data = join(root, "data");
  folder = join(root, "backups");
  mkdirSync(folder);
  stagedFolder();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const REPORT = { reapplied: 0, embeddingSpace: null, now: NOW };

/** What the start does around the swap: apply, open, finish. */
function start() {
  const run = applyPendingRestore(data, openBetterSqlite3);
  const db = openCanonicalDb(data);
  run.db = db;
  const last = finishRestore(db, run, REPORT);
  return { run, db, last };
}

describe("restore.swap crash matrix (H01-C2b)", () => {
  it.each<RestoreStep>([
    "marker-read",
    "first-rename",
    "second-rename",
    "marker-swapped",
    "before-commit",
    "after-commit",
  ])("a crash after %s, then a fresh start: the restored database whole, never a mix", (step) => {
    const crashed = (() => {
      try {
        const run = applyPendingRestore(data, openBetterSqlite3, { crashAfter: step });
        const db = openCanonicalDb(data);
        run.db = db;
        try {
          finishRestore(db, run, REPORT, { crashAfter: step });
        } finally {
          db.close();
        }
      } catch (error) {
        return error instanceof RestoreCrash;
      }
      return false;
    })();
    expect(crashed).toBe(true);

    // whatever the crash left: each of the two database files that exists is one whole database
    for (const file of [live(), join(data, BEFORE_RESTORE_FILE)]) {
      if (existsSync(file)) expect(healthy(file), file).toBe(true);
    }
    // and at least one of them is there: never neither
    expect(existsSync(live()) || existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(true);

    const { db, last } = start();
    expect(sourceCount(db)).toBe(2); // the restored one: the third source is gone with the old file
    expect(db.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(JSON.parse(readSetting(db, RESTORE_LAST_SETTING) as string)).toMatchObject({
      backupId: readPendingBackupId(last),
    });
    db.close();
    // the previous data is gone (the deletion promise) and nothing is left to apply again
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(false);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it("another start after a finished restore changes nothing", () => {
    const first = start();
    first.db.close();
    const hash = sha(live());
    const second = applyPendingRestore(data, openBetterSqlite3);
    expect(second.applied).toBe(false);
    expect(sha(live())).toBe(hash);
  });

  it("a swap that never began leaves the live database byte for byte, with the marker staged", () => {
    expect(() =>
      applyPendingRestore(data, openBetterSqlite3, { crashAfter: "marker-read" }),
    ).toThrow(RestoreCrash);
    expect(sha(live())).toBe(before.sha);
    expect(readPending(data)).toMatchObject({ state: "staged" });
    expect(existsSync(join(data, RESTORE_DIR, STAGED_FILE))).toBe(true);
  });

  it("a hot journal beside the live file is rolled back before the rename and never reaches the restored file", () => {
    // a real crash image: the file and its rollback journal as they are in the middle of a write that spilled
    const writer = openBetterSqlite3(live());
    writer.exec("CREATE TABLE zz (v BLOB)");
    for (let i = 0; i < 50; i++)
      writer.run("INSERT INTO zz (v) VALUES (?)", [Buffer.alloc(8000, 1)]);
    writer.exec("PRAGMA cache_size = 10");
    writer.exec("BEGIN");
    writer.exec("UPDATE zz SET v = zeroblob(8000)");
    copyFileSync(live(), join(root, "hot.sqlite"));
    copyFileSync(`${live()}-journal`, join(root, "hot.sqlite-journal"));
    writer.exec("ROLLBACK");
    writer.close();
    copyFileSync(join(root, "hot.sqlite"), live());
    copyFileSync(join(root, "hot.sqlite-journal"), `${live()}-journal`);

    expect(() =>
      applyPendingRestore(data, openBetterSqlite3, { crashAfter: "first-rename" }),
    ).toThrow(RestoreCrash);
    // the old file was rolled back whole (no half-written zeroed rows), its journal is gone
    expect(existsSync(`${live()}-journal`)).toBe(false);
    const old = openBetterSqlite3(join(data, BEFORE_RESTORE_FILE));
    expect(old.all("SELECT count(*) AS n FROM zz WHERE v = zeroblob(8000)")[0]?.n).toBe(0);
    old.close();

    const { db } = start();
    expect(db.all("SELECT count(*) AS n FROM sqlite_master WHERE name = 'zz'")[0]?.n).toBe(0);
    expect(sourceCount(db)).toBe(2);
    db.close();
  });

  it("a journal left beside the live file does not travel to the restored one", () => {
    writeFileSync(`${live()}-journal`, Buffer.alloc(512, 3));
    const { db } = start();
    expect(sourceCount(db)).toBe(2);
    expect(existsSync(`${live()}-journal`)).toBe(false);
    db.close();
  });
});

describe("restore.finish (H01-R12)", () => {
  it("takes back a running job whatever its lease says, clears the consents, asks both projections to rebuild and records the numbers", () => {
    const run = applyPendingRestore(data, openBetterSqlite3);
    const db = openCanonicalDb(data);
    run.db = db;
    // the state a restored copy can be in: a running job whose lease is still alive (30 s left: the ordinary rule would keep it), a consent, a read folder
    registerJob(db, { kind: "wiki-build", at: NOW });
    expect(leaseNextJob(db, { kinds: ["wiki-build"], now: NOW, leaseMs: 30_000 })).toBeDefined();
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE status = 'running'")[0]?.n).toBe(1);
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
      displayPath: "/x",
      realPath: "/x",
      rootDev: "1",
      rootIno: "2",
      createdAt: NOW.toISOString(),
    });
    const last = finishRestore(db, run, { ...REPORT, reapplied: 4 });
    expect(db.all("SELECT count(*) AS n FROM jobs WHERE status = 'running'")[0]?.n).toBe(0);
    expect(db.all("SELECT count(*) AS n FROM consents")[0]?.n).toBe(0);
    expect(
      db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target"),
    ).toHaveLength(2);
    expect(last).toMatchObject({ reapplied: 4, clearedConsents: 1, pausedLocations: 1 });
    expect(JSON.parse(readSetting(db, RESTORE_LAST_SETTING) as string)).toEqual(last);
    db.close();
  });
});

describe("restore.pause (H01-R12, M1)", () => {
  it("a restart after a process that was gone right after the finish returned still finds the restored folders paused", async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    mkdirSync(folder);
    stagedFolder(true);
    const run = applyPendingRestore(data, openBetterSqlite3);
    const db = openCanonicalDb(data);
    run.db = db;
    // the start is gone right after the finish returned: marker and previous file removed, no driver started yet
    finishRestore(db, run, REPORT);
    db.close();
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
    const booted = await bootBackend({
      dataDir: data,
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    });
    const states = listLocations(booted.db).map((l) => [l.state, l.stateReason]);
    await booted.server.close();
    booted.db.close();
    expect(states).toEqual([["paused", "restored"]]);
  });
});

describe("restore.marker states that cannot be trusted (H01-R11, M2)", () => {
  const before = () => join(data, BEFORE_RESTORE_FILE);
  const staged = () => join(data, RESTORE_DIR, STAGED_FILE);
  const marker = () => join(data, RESTORE_DIR, "pending.json");

  it("an unreadable marker stops the start explicitly and deletes nothing (a torn write between the renames)", () => {
    expect(() =>
      applyPendingRestore(data, openBetterSqlite3, { crashAfter: "first-rename" }),
    ).toThrow(RestoreCrash);
    writeFileSync(marker(), '{"state":"sta');
    expect(() => applyPendingRestore(data, openBetterSqlite3)).toThrow(RestoreMarkerError);
    expect(existsSync(before())).toBe(true);
    expect(existsSync(staged())).toBe(true);
  });

  it("no marker but a previous-database file left: the start fails explicitly and deletes nothing", () => {
    expect(() =>
      applyPendingRestore(data, openBetterSqlite3, { crashAfter: "first-rename" }),
    ).toThrow(RestoreCrash);
    rmSync(marker());
    expect(() => applyPendingRestore(data, openBetterSqlite3)).toThrow(RestoreStateError);
    expect(existsSync(before())).toBe(true);
    expect(existsSync(staged())).toBe(true);
  });

  it("a live file beside a previous-database file and a staged one is never removed: the marker is marked failed", () => {
    copyFileSync(live(), before());
    const hash = sha(live());
    expect(() => applyPendingRestore(data, openBetterSqlite3)).toThrow(RestoreStateError);
    expect(sha(live())).toBe(hash);
    expect(existsSync(before())).toBe(true);
    expect(readPending(data)).toMatchObject({ state: "failed" });
  });

  it("a swapped restore whose live file is missing is marked failed and the previous file is kept", () => {
    expect(applyPendingRestore(data, openBetterSqlite3).applied).toBe(true);
    rmSync(live());
    expect(() => applyPendingRestore(data, openBetterSqlite3)).toThrow(RestoreStateError);
    expect(existsSync(before())).toBe(true);
    expect(readPending(data)).toMatchObject({ state: "failed" });
  });

  it("an undo does not remove the live file when the previous file is not a complete database", () => {
    expect(applyPendingRestore(data, openBetterSqlite3).applied).toBe(true);
    writeFileSync(before(), "not a database");
    const hash = sha(live());
    expect(() =>
      rollbackRestore({ dataDir: data, applied: true, finished: false }, "start-failed"),
    ).toThrow(RestoreStateError);
    expect(sha(live())).toBe(hash);
  });
});

describe("restore.rollback (H01-R13)", () => {
  it("a start that fails after the swap and before the finish commit puts the previous database back and marks the restore failed", async () => {
    // a deletion the user made after the backup: the restored copy needs it applied again, and it cannot be
    const db = openCanonicalDb(data);
    userDelete(
      db,
      { connectorInstanceId: "c1", namespace: "n", externalId: "a" },
      NOW.toISOString(),
    );
    db.close();
    const hash = sha(live());
    const failing: DerivativeRegistry = {
      ...createProductRegistry({ policy: defaultScopePolicy }),
      propagate: () => {
        throw new Error("a kind failed");
      },
    };
    const options = {
      dataDir: data,
      token: "t".repeat(43),
      allowedOrigins: [],
      secrets: NO_SECRET_STORE,
    };
    // the rollback is done before the rejection reaches the caller's own handler (it is the first reaction)
    const started = bootBackend({ ...options, registry: failing });
    const seenByCaller = started.then(
      () => "started",
      () => sha(live()),
    );
    await expect(started).rejects.toBeInstanceOf(LedgerReapplyError);
    expect(await seenByCaller).toBe(hash);
    // the previous database, byte for byte, and no copy of anything left behind
    expect(sha(live())).toBe(hash);
    expect(readPending(data)).toEqual({ state: "failed", code: "start-failed" });
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(false);
    expect(existsSync(join(data, RESTORE_DIR, STAGED_FILE))).toBe(false);

    // the next start is an ordinary one on the previous data
    const running = await bootBackend(options);
    expect(sourceCount(running.db)).toBe(before.sources);
    await running.server.close();
    running.db.close();
  });
});

function readPendingBackupId(last: { backupId: string } | undefined): string {
  if (!last) throw new Error("the finish recorded nothing");
  return last.backupId;
}
