// H01-C2c (R12, R14): nothing a user did after a backup comes back with it. Real `bootBackend`, the real deletion
// route, the real import handler for an access revocation, the real consent route, and the real
// `reapplyAtStart`: back up, delete one source, revoke access to another, withdraw the consent, restore the older
// backup and start. Synthetic data only.
import { routes } from "@pki/contracts";
import {
  RESTORE_DIR,
  RESTORE_LAST_SETTING,
  BEFORE_RESTORE_FILE,
  createBackup,
  leaseNextJob,
  readLedgerSeq,
  readSetting,
  registerConnectorInstance,
  registerJob,
  saveConsent,
  saveSourceRecord,
  stageRestore,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft, send } from "@pki/testkit";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { openCanonicalDb } from "./composition.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "r".repeat(43);
const PASSPHRASE = "correct horse battery staple";
const DELETED = "ZQDELETEDBODY4417";
const REVOKED = "ZQREVOKEDBODY8802";
const KEPT = "ZQKEPTBODY3351";

let root: string;
let data: string;
let folder: string;
let watched: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-restore-ledger-")));
  data = join(root, "data");
  folder = join(root, "backups");
  watched = join(root, "watched");
  mkdirSync(folder);
  mkdirSync(watched);
});
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  rmSync(root, { recursive: true, force: true });
});

const start = async () =>
  (booted = await bootBackend({
    dataDir: data,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    localFiles: { normalizer: inProcessNormalizer() },
  }));
const live = () => {
  if (!booted) throw new Error("the backend is not started");
  return booted;
};
const call = (path: string, body?: unknown, method = "POST") => {
  const { port } = live().server;
  return send(
    port,
    path,
    { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
    method,
    body,
  );
};
const stop = async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
};
const shown = async () =>
  (
    (await call(routes.sources.path, undefined, "GET")).body as {
      sources: { externalId: string }[];
    }
  ).sources
    .map((s) => s.externalId)
    .sort();

/** One JSONL record for POST /api/imports (the importer's own line format). */
const importLine = (patch: Record<string, unknown>) => {
  const content = String(patch.content ?? "");
  return JSON.stringify({
    id: "syn-1",
    source_type: "wiki",
    external_id: "rev",
    title: "합성 제목",
    content,
    author: "a@example.test",
    participants: [],
    thread_id: "",
    source_url: "https://wiki.example.test/1",
    created_at: "2026-11-01T09:00:00+09:00",
    updated_at: "2026-11-02T09:00:00+09:00",
    content_hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    version: 1,
    access_scope: ["org:all"],
    metadata: {},
    connector_instance_id: "conn-w",
    operation: "upsert",
    schema_version: "1",
    ...patch,
  });
};
const importLines = (text: string) =>
  call(routes.imports.path, { instanceId: "api-inst", content: text });

/** What a data folder holds before the first start: two sources, a consent and a running job. */
function seed(): void {
  const db = openCanonicalDb(data);
  registerConnectorInstance(db, "c1", "jsonl-import");
  saveSourceRecord(db, "c1", { namespace: "n", externalId: "keep", title: "keep", body: KEPT });
  saveSourceRecord(db, "c1", {
    namespace: "n",
    externalId: "del",
    title: "del",
    body: `지울 본문 ${DELETED}`,
  });
  saveConsent(db, {
    provider: "local-model",
    destination: "local",
    policyVersion: "1",
    allowedClasses: ["public"],
    grantedAt: "2026-11-23T00:00:00.000Z",
  });
  // a job a handler of the old process held: its lease is alive in the copy that goes into the backup
  registerJob(db, { kind: "zz-held-job", at: new Date(Date.now() - 1000) });
  const at = new Date();
  expect(leaseNextJob(db, { kinds: ["zz-held-job"], now: at, leaseMs: 3_600_000 })).toBeDefined();
  expect(db.all("SELECT count(*) AS n FROM jobs WHERE status = 'running'")[0]?.n).toBe(1);
  db.close();
}

/** Backs up the running backend's database, then stages that file for the next start. */
function backUp(): void {
  const { fileName, manifest } = createBackup({
    db: live().db,
    open: openBetterSqlite3,
    dataDir: data,
    folder,
    passphrase: PASSPHRASE,
    now: new Date(),
    embeddingSpace: null,
    vectorIndexSeq: null,
    scrypt: { N: 1024, r: 8, p: 1 },
  });
  backups.push({ fileName, backupId: manifest.backupId });
}
const backups: { fileName: string; backupId: string }[] = [];
function stage(db: SqlDriver): void {
  const last = backups[backups.length - 1];
  if (!last) throw new Error("no backup was made");
  const staged = stageRestore({
    db,
    open: openBetterSqlite3,
    dataDir: data,
    file: join(folder, last.fileName),
    passphrase: PASSPHRASE,
    confirmBackupId: last.backupId,
    now: new Date(),
  });
  expect(staged.status).toBe("staged");
}
beforeEach(() => void (backups.length = 0));

describe("restore.ledger (H01-C2c)", () => {
  it("a deleted source, a revoked access and a withdrawn consent stay gone after an older backup is restored; the running job and the read folder are taken back", async () => {
    seed();
    await start();
    expect((await importLines(importLine({ content: `접근 본문 ${REVOKED}` }))).status).toBe(200);
    const approved = await call(routes.approveLocalLocation.path, {
      type: "folder",
      path: watched,
    });
    expect(approved.status).toBe(200);
    expect(await shown()).toEqual(["del", "keep", "rev"]);
    // the held job is running in the database the backup copies
    expect(
      live().db.all(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'zz-held-job' AND status = 'running'",
      )[0]?.n,
    ).toBe(1);
    backUp();

    // later: the user deletes one source, access to another is revoked, the consent is withdrawn
    expect(
      (
        await call(routes.deleteSource.path, {
          connectorId: "c1",
          namespace: "n",
          externalId: "del",
        })
      ).body,
    ).toEqual({ outcome: "deleted" });
    await importLines(importLine({ operation: "access-revoked", content: "", version: 2 }));
    await call(routes.revokeConsent.path, { providerId: "local-model" });
    expect(await shown()).toEqual(["keep"]);
    expect(live().db.all("SELECT count(*) AS n FROM consents")[0]?.n).toBe(0);
    stage(live().db);
    await stop();

    await start();

    // the content is gone from every file of the data folder, and the tombstones are back
    expect(canariesLeft(data, [DELETED, REVOKED])).toEqual([]);
    expect(live().db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(2);
    expect(await shown()).toEqual(["keep"]);
    expect(canariesLeft(data, [KEPT])).toEqual([KEPT]); // what was kept is read
    // the withdrawn consent did not come back with the old row
    expect(live().db.all("SELECT count(*) AS n FROM consents")[0]?.n).toBe(0);
    const consents = (await call(routes.consents.path, undefined, "GET")).body as {
      providers: { providerId: string; consent: unknown }[];
    };
    expect(consents.providers.every((p) => p.consent === null)).toBe(true);
    // the folder the old process read is paused as restored, the held job is not running
    const locations = (await call(routes.localLocations.path, undefined, "GET")).body as {
      locations: { state: string; stateReason: string }[];
    };
    expect(locations.locations.map((l) => [l.state, l.stateReason])).toEqual([
      ["paused", "restored"],
    ]);
    expect(
      live().db.all(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'zz-held-job' AND status = 'running'",
      )[0]?.n,
    ).toBe(0);
    expect(readLedgerSeq(live().db)).toBe(2);
    expect(
      live().db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target"),
    ).toHaveLength(2);
    // R12-4: the numbers
    expect(JSON.parse(readSetting(live().db, RESTORE_LAST_SETTING) as string)).toMatchObject({
      reapplied: 2,
      clearedConsents: 1,
      pausedLocations: 1,
      embeddingSpaceDiffers: false,
    });
    // the previous data and the marker are gone
    expect(existsSync(join(data, BEFORE_RESTORE_FILE))).toBe(false);
    expect(existsSync(join(data, RESTORE_DIR))).toBe(false);
  });

  it("a backup whose ledger sequence equals the ledger's still has both projections rebuilt and its folders paused", async () => {
    seed();
    await start();
    await call(routes.approveLocalLocation.path, { type: "folder", path: watched });
    // nothing is queued for a rebuild in the copy that goes into the backup
    live().db.run("DELETE FROM jobs WHERE kind = 'projection-rebuild'");
    backUp();
    stage(live().db);
    await stop();

    await start();

    expect(readLedgerSeq(live().db)).toBe(0); // no deletion to carry over: the sequences are equal
    expect(
      live().db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target"),
    ).toHaveLength(2);
    const locations = (await call(routes.localLocations.path, undefined, "GET")).body as {
      locations: { state: string; stateReason: string }[];
    };
    expect(locations.locations.map((l) => [l.state, l.stateReason])).toEqual([
      ["paused", "restored"],
    ]);
    expect(JSON.parse(readSetting(live().db, RESTORE_LAST_SETTING) as string)).toMatchObject({
      reapplied: 0,
    });
  });
});
