// H01-C1c (R2, R6) and the API half of H01-C2a (R9): through the started backend's six routes, a passphrase
// never leaves the request that carried it, the secrets file and the ledger are neither backed up nor changed
// by a restore, and a file that is refused changes nothing. Real files, the real server, synthetic data.
import { routes } from "@pki/contracts";
import {
  BACKUP_FOLDER_SETTING,
  BEFORE_RESTORE_FILE,
  RESTORE_DIR,
  createBackup,
  migrations,
  readSetting,
  registerConnectorInstance,
  saveSourceRecord,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft, send } from "@pki/testkit";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import { LEDGER_FILE } from "@pki/storage";

const TOKEN = "b".repeat(43);
const PASSPHRASE = "p4ssphrase-CANARY-5521-unique";
const BODY = "ZQBACKUPBODY6643";
const FAST = { N: 1024, r: 8, p: 1 };

let root: string;
let folder: string;
const running: Awaited<ReturnType<typeof bootBackend>>[] = [];
const seen: string[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-backup-api-")));
  folder = join(root, "backups");
  mkdirSync(folder);
  seen.length = 0;
  const capture = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
});
afterEach(async () => {
  for (const b of running.splice(0)) {
    await b.server.close();
    b.db.close();
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const missingKeys = {
  read: async () => ({ state: "missing" as const }),
  has: async () => "missing" as const,
  deleteOthers: async () => "done" as const,
};

/** A backend on its own data folder, with a caller for its routes. */
async function boot(name: string) {
  const data = join(root, name);
  const started = await bootBackend({
    dataDir: data,
    token: TOKEN,
    allowedOrigins: [],
    secrets: missingKeys,
    providers: [],
    backupScrypt: FAST,
  });
  running.push(started);
  const h = { host: `127.0.0.1:${started.server.port}`, authorization: `Bearer ${TOKEN}` };
  const call = async (path: string, method: string, body?: unknown) => {
    const res = await send(started.server.port, path, h, method, body);
    seen.push(JSON.stringify(res.body)); // every response is looked through for the passphrase
    return res;
  };
  const stop = async () => {
    running.splice(running.indexOf(started), 1);
    await started.server.close();
    started.db.close();
  };
  return { data, db: started.db, call, stop };
}
type Booted = Awaited<ReturnType<typeof boot>>;

const addSource = (b: Booted, externalId: string, body: string) => {
  registerConnectorInstance(b.db, "c1", "jsonl-import");
  saveSourceRecord(b.db, "c1", { namespace: "n", externalId, title: externalId, body });
};
const shown = async (b: Booted) =>
  ((await b.call(routes.sources.path, "GET")).body as { sources: { externalId: string }[] }).sources
    .map((s) => s.externalId)
    .sort();
const chooseFolder = (b: Booted) => b.call(routes.setBackupFolder.path, "PUT", { path: folder });
const makeBackup = async (b: Booted) => {
  const res = await b.call(routes.createBackup.path, "POST", { passphrase: PASSPHRASE });
  expect(res.body).toMatchObject({ status: "created" });
  return res.body as { fileName: string; summary: { backupId: string } };
};
/** Every table of the database as text, for a canary scan of its rows. */
function dump(b: Booted): string {
  const tables = b.db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return tables
    .map((t) =>
      JSON.stringify(b.db.all(`SELECT * FROM "${String(t.name)}"`), (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      ),
    )
    .join("\n");
}

describe("backup.api (H01-C1c)", () => {
  it("backs up and restores without the passphrase reaching a table, a log line, a response or the data folder; secrets and ledger are neither backed up nor changed", async () => {
    const a = await boot("a");
    addSource(a, "keep", BODY);
    await a.call(routes.writeSettings.path, "POST", {
      openaiCompatible: { baseUrl: "https://api.example.invalid/v1", model: "m" },
    });
    const secretsFile = join(a.data, "secrets.json");
    writeFileSync(secretsFile, "SECRETS-FILE-SENTINEL-8841");
    expect(await chooseFolder(a)).toMatchObject({ status: 200, body: { status: "ok" } });
    const created = await makeBackup(a);
    expect(readSetting(a.db, BACKUP_FOLDER_SETTING)).toBe(folder);
    const listed = (await a.call(routes.backupStatus.path, "GET")).body as {
      files: { fileName: string }[];
    };
    expect(listed.files.map((f) => f.fileName)).toEqual([created.fileName]);

    // the file holds no plaintext of the database, of the secrets file or of the passphrase
    const bytes = readFileSync(join(folder, created.fileName));
    expect(bytes.includes("SQLite format 3")).toBe(false);
    expect(bytes.includes(BODY)).toBe(false);
    expect(bytes.includes("SECRETS-FILE-SENTINEL-8841")).toBe(false);

    // stage and cancel, then stage again and restart: the same installation
    const inspected = await a.call(routes.inspectRestore.path, "POST", {
      fileName: created.fileName,
      passphrase: PASSPHRASE,
    });
    expect(inspected.body).toMatchObject({
      status: "ok",
      schema: "same",
      installation: "same",
      summary: { backupId: created.summary.backupId },
    });
    const staged = await a.call(routes.restoreBackup.path, "POST", {
      fileName: created.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: created.summary.backupId,
    });
    expect(staged.body).toMatchObject({ status: "staged" });
    expect(
      (await a.call(routes.backupStatus.path, "GET")).body as { pending: unknown },
    ).toMatchObject({ pending: { backupId: created.summary.backupId } });
    expect((await a.call(routes.cancelRestore.path, "DELETE")).body).toEqual({
      status: "cancelled",
    });
    expect(existsSync(join(a.data, RESTORE_DIR))).toBe(false);
    await a.call(routes.restoreBackup.path, "POST", {
      fileName: created.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: created.summary.backupId,
    });
    const ledgerBefore = sha(join(a.data, LEDGER_FILE));
    const secretsBefore = sha(secretsFile);
    expect(dump(a)).not.toContain(PASSPHRASE);
    await a.stop();
    const again = await boot("a");
    expect(await shown(again)).toEqual(["keep"]);
    expect(sha(secretsFile)).toBe(secretsBefore);
    expect(sha(join(again.data, LEDGER_FILE))).toBe(ledgerBefore);
    const last = (await again.call(routes.backupStatus.path, "GET")).body as { last: unknown };
    expect(last.last).toMatchObject({ backupId: created.summary.backupId });

    // nowhere: no table, no log line, no response, no file of the data folder or the backup folder
    expect(dump(again)).not.toContain(PASSPHRASE);
    expect(seen.join("\n")).not.toContain(PASSPHRASE);
    expect(canariesLeft(again.data, [PASSPHRASE])).toEqual([]);
    expect(canariesLeft(folder, [PASSPHRASE])).toEqual([]);
    expect(readdirSync(again.data)).not.toContain("backup-tmp");
  });

  it("restores onto an installation that has no secrets: the knowledge reads, and the backup's provider address is not applied (H01F-R6)", async () => {
    const a = await boot("a");
    addSource(a, "keep", BODY);
    await a.call(routes.writeSettings.path, "POST", {
      openaiCompatible: { baseUrl: "https://api.example.invalid/v1", model: "m" },
    });
    await chooseFolder(a);
    const created = await makeBackup(a);
    await a.stop();

    const b = await boot("b"); // another, empty installation (D8 allows this)
    await chooseFolder(b);
    expect(await shown(b)).toEqual([]);
    const staged = await b.call(routes.restoreBackup.path, "POST", {
      fileName: created.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: created.summary.backupId,
    });
    expect(staged.body).toMatchObject({ status: "staged" });
    await b.stop();
    const restored = await boot("b");
    expect(await shown(restored)).toEqual(["keep"]);
    const settings = (await restored.call(routes.settings.path, "GET")).body as {
      openaiCompatible: { baseUrl: string | null };
    };
    expect(settings.openaiCompatible.baseUrl).toBeNull();
  });
});

describe("backup.api refusals (H01-C2a)", () => {
  /** A backup file of another installation, or one of a newer schema, written straight into the folder. */
  function foreign(name: string, bumpSchema = false): { fileName: string; backupId: string } {
    const data = join(root, name);
    mkdirSync(data);
    const db = openCanonicalDb(data);
    registerConnectorInstance(db, "c9", "jsonl-import");
    saveSourceRecord(db, "c9", { namespace: "n", externalId: "x", title: "x", body: "다른 설치" });
    if (bumpSchema) db.exec(`PRAGMA user_version = ${migrations.length + 1}`);
    const made = createBackup({
      db,
      open: openBetterSqlite3,
      dataDir: data,
      folder,
      passphrase: PASSPHRASE,
      now: new Date(bumpSchema ? "2026-11-23T05:00:00Z" : "2026-11-23T04:00:00Z"),
      embeddingSpace: null,
      vectorIndexSeq: null,
      scrypt: FAST,
    });
    db.close();
    return { fileName: made.fileName, backupId: made.manifest.backupId };
  }

  it("each refusal has its own code, leaves pki.sqlite byte for byte and no restore folder", async () => {
    const live = await boot("live");
    addSource(live, "mine", BODY);
    await chooseFolder(live);
    const own = await makeBackup(live);
    const other = foreign("other");
    const newer = foreign("newer", true);
    // a copy of the live backup with one byte changed
    const damagedBytes = readFileSync(join(folder, own.fileName));
    damagedBytes[damagedBytes.length - 20] = (damagedBytes[damagedBytes.length - 20] as number) ^ 1;
    writeFileSync(join(folder, "pki-backup-damaged.pkibak"), damagedBytes);

    const file = join(live.data, CANONICAL_DB_FILE);
    const hash = sha(file);
    const ask = (fileName: string, confirmBackupId: string, passphrase = PASSPHRASE) =>
      live.call(routes.restoreBackup.path, "POST", { fileName, passphrase, confirmBackupId });
    const cases: [string, Awaited<ReturnType<typeof ask>>][] = [
      ["wrong-passphrase", await ask(own.fileName, own.summary.backupId, "another passphrase!!")],
      ["confirm-mismatch", await ask(own.fileName, "not-the-id")],
      ["damaged", await ask("pki-backup-damaged.pkibak", own.summary.backupId)],
      ["newer-schema", await ask(newer.fileName, newer.backupId)],
      ["other-installation", await ask(other.fileName, other.backupId)],
      ["not-found", await ask("pki-backup-missing.pkibak", "x")],
      ["bad-file-name", await ask("../escape.pkibak", "x")],
    ];
    for (const [code, res] of cases) {
      expect(res.body, code).toEqual({ status: "refused", code });
    }
    expect(sha(file)).toBe(hash);
    expect(existsSync(join(live.data, RESTORE_DIR))).toBe(false);
    expect(
      (await live.call(routes.backupStatus.path, "GET")).body as { pending: unknown },
    ).toMatchObject({ pending: null });
    // the inspection says the same about the other installation without staging anything
    expect(
      (
        await live.call(routes.inspectRestore.path, "POST", {
          fileName: other.fileName,
          passphrase: PASSPHRASE,
        })
      ).body,
    ).toMatchObject({ status: "ok", installation: "other" });
    expect(existsSync(join(live.data, RESTORE_DIR))).toBe(false);
  });

  it("an unreadable restore marker is shown as a failure code and blocks a new staging, deleting nothing (M2)", async () => {
    const live = await boot("live");
    await chooseFolder(live);
    const own = await makeBackup(live);
    mkdirSync(join(live.data, RESTORE_DIR));
    const marker = join(live.data, RESTORE_DIR, "pending.json");
    writeFileSync(marker, '{"state":"sta');
    const status = (await live.call(routes.backupStatus.path, "GET")).body as {
      failure: string | null;
      pending: unknown;
    };
    expect(status).toMatchObject({ failure: "restore-marker-unreadable", pending: null });
    const res = await live.call(routes.restoreBackup.path, "POST", {
      fileName: own.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: own.summary.backupId,
    });
    expect(res.body).toEqual({ status: "refused", code: "already-pending" });
    expect(readFileSync(marker, "utf8")).toBe('{"state":"sta');
  });

  it("H01F-C2: with no previous-data copy, cancel clears an unreadable marker and a new staging is accepted", async () => {
    const live = await boot("live");
    await chooseFolder(live);
    const own = await makeBackup(live);
    mkdirSync(join(live.data, RESTORE_DIR));
    writeFileSync(join(live.data, RESTORE_DIR, "pending.json"), '{"state":"sta');
    expect((await live.call(routes.cancelRestore.path, "DELETE")).body).toEqual({
      status: "cancelled",
    });
    expect(existsSync(join(live.data, RESTORE_DIR))).toBe(false);
    const res = await live.call(routes.restoreBackup.path, "POST", {
      fileName: own.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: own.summary.backupId,
    });
    expect(res.body).toMatchObject({ status: "staged" });
  });

  it("H01F-C2: a previous-data copy makes cancel and a new staging refuse, deleting nothing, and the status shows it", async () => {
    const live = await boot("live");
    await chooseFolder(live);
    const own = await makeBackup(live);
    mkdirSync(join(live.data, RESTORE_DIR));
    const marker = join(live.data, RESTORE_DIR, "pending.json");
    writeFileSync(marker, JSON.stringify({ state: "failed", code: "start-failed" }));
    const before = join(live.data, BEFORE_RESTORE_FILE);
    writeFileSync(before, "previous data");
    expect((await live.call(routes.backupStatus.path, "GET")).body).toMatchObject({
      previousCopy: true,
    });
    expect((await live.call(routes.cancelRestore.path, "DELETE")).body).toEqual({
      status: "refused",
    });
    const res = await live.call(routes.restoreBackup.path, "POST", {
      fileName: own.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: own.summary.backupId,
    });
    expect(res.body).toEqual({ status: "refused", code: "already-pending" });
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(before, "utf8")).toBe("previous data");
  });

  it("an older schema is lifted by the staging: the restart opens it at this build's number", async () => {
    const live = await boot("live");
    await chooseFolder(live);
    const older = join(root, "older");
    mkdirSync(older);
    // a database at the schema before the last migration, with the live installation's identity (empty live: any key)
    const { migrate } = await import("@pki/storage");
    const db = openBetterSqlite3(join(older, CANONICAL_DB_FILE));
    migrate(db, migrations.slice(0, migrations.length - 1));
    const made = createBackup({
      db,
      open: openBetterSqlite3,
      dataDir: older,
      folder,
      passphrase: PASSPHRASE,
      now: new Date("2026-11-23T06:00:00Z"),
      embeddingSpace: null,
      vectorIndexSeq: null,
      scrypt: FAST,
    });
    db.close();
    const res = await live.call(routes.restoreBackup.path, "POST", {
      fileName: made.fileName,
      passphrase: PASSPHRASE,
      confirmBackupId: made.manifest.backupId,
    });
    expect(res.body).toMatchObject({ status: "staged" });
    await live.stop();
    const restarted = await boot("live");
    expect(
      (await restarted.call(routes.settings.path, "GET")).body as { schemaVersion: number },
    ).toMatchObject({ schemaVersion: migrations.length });
  });
});
