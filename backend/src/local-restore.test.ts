// I02B-T04 T7 (I02B-R34, R49; C41, C40 restart): a restored database starts with every location it read
// paused as `restored` and no sync registered, a revocation left `revoking` is finished by the start, and
// an ordinary restart leaves the states. Real boots over one data directory; the backup is VACUUM INTO.
import { routes, type LocalLocationInfo } from "@pki/contracts";
import { findCanaries, send } from "@pki/testkit";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import { inProcessNormalizer } from "./local-normalizer.test-support.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "q".repeat(43);
let root: string;
let data: string;
let running: Awaited<ReturnType<typeof bootBackend>> | undefined;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pki-local-restore-")));
  data = join(root, "data");
});
afterEach(async () => {
  await running?.server.close();
  running?.db.close();
  running = undefined;
  rmSync(root, { recursive: true, force: true });
});

const put = (dir: string, name: string, text: string) => {
  writeFileSync(join(dir, name), `# ${name}\n\n${text}\n`);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, name), old, old);
};
async function boot() {
  const started = await bootBackend({
    dataDir: data,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    providers: [],
    localFiles: { normalizer: inProcessNormalizer() },
  });
  running = started;
  const h = { host: `127.0.0.1:${started.server.port}`, authorization: `Bearer ${TOKEN}` };
  const call = (path: string, body?: unknown) => send(started.server.port, path, h, "POST", body);
  const get = (path: string) => send(started.server.port, path, h, "GET");
  /** Syncs until `done` holds (a sync the approval registered may hold the instance; a new file needs two looks). */
  const sync = async (done: () => boolean = () => false, min = 2) => {
    for (let i = 0; i < 20 && (i < min || !done()); i++) {
      await new Promise((r) => setTimeout(r, 15));
      await call(routes.syncConnector.path, { connectorId: "local-files" });
    }
  };
  const locations = async () =>
    ((await get(routes.localLocations.path)).body as { locations: LocalLocationInfo[] }).locations;
  return { call, get, sync, locations, db: started.db };
}
async function stop() {
  await running?.server.close();
  running?.db.close();
  running = undefined;
}
const liveIn = (
  db: { all: (sql: string, p?: string[]) => Record<string, unknown>[] },
  id: string,
) =>
  Number(
    db.all(
      "SELECT count(*) AS n FROM sources WHERE connector_instance_id = 'local-files' AND namespace = ? AND identity_hashed = 0",
      [id],
    )[0]?.n,
  );

describe("C41 a restored database", () => {
  it("applies the later deletions from the ledger, pauses every read location as restored with no sync registered, and reads a revoked folder again only after the user turns it on", async () => {
    const folderA = join(root, "a");
    const folderB = join(root, "b");
    mkdirSync(folderA);
    mkdirSync(folderB);
    put(folderA, "a-canary-path-7731.md", "ZQBODY-a-8842");
    put(folderA, "b-canary-path-7731.md", "ZQBODY-b-8842");
    put(folderB, "c-canary-path-7731.md", "ZQBODY-c-8842");

    // the backup: three sources are in
    let first = await boot();
    await first.call(routes.setLocalFilesSettings.path, { settleMs: 1 });
    const a = (
      await first.call(routes.approveLocalLocation.path, { type: "folder", path: folderA })
    ).body as LocalLocationInfo;
    const b = (
      await first.call(routes.approveLocalLocation.path, { type: "folder", path: folderB })
    ).body as LocalLocationInfo;
    await first.sync(() => liveIn(first.db, a.id) + liveIn(first.db, b.id) === 3);
    expect(liveIn(first.db, a.id) + liveIn(first.db, b.id)).toBe(3);
    const backup = join(root, "backup.sqlite");
    first.db.exec(`VACUUM INTO '${backup}'`);

    // later: one deleted from the disk, one deleted by the user, the other folder revoked
    unlinkSync(join(folderA, "a-canary-path-7731.md"));
    await first.sync(() => liveIn(first.db, a.id) === 1);
    const sources = (await first.get(routes.sources.path)).body as {
      sources: { connectorId: string; namespace: string; externalId: string; title: string }[];
    };
    const mine = sources.sources.filter((s) => s.connectorId === "local-files");
    const userDeleted = mine.find((s) => s.title.includes("b-canary")) as (typeof mine)[number];
    expect(
      (
        await first.call(routes.deleteSource.path, {
          connectorId: userDeleted.connectorId,
          namespace: userDeleted.namespace,
          externalId: userDeleted.externalId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await first.call(routes.revokeLocalLocation.path, { locationId: b.id, count: 1 })).body,
    ).toEqual({
      state: "revoked",
      revoked: 1,
    });
    await stop();

    // the restore: the older database in place, the ledger untouched
    copyFileSync(backup, join(data, CANONICAL_DB_FILE));
    const before = openCanonicalDb(data);
    const jobsBefore = Number(
      before.all("SELECT count(*) AS n FROM jobs WHERE kind = 'connector-sync'")[0]?.n,
    );
    before.close();
    first = await boot();

    expect(Number(first.db.all("SELECT count(*) AS n FROM tombstones")[0]?.n)).toBe(3);
    // the entries of the three (deleted on disk, user-deleted, revoked) hold no plaintext path or content hash
    expect(
      first.db.all(
        "SELECT state FROM local_file_entries WHERE relative_path IS NULL AND content_hash IS NULL AND size IS NULL",
      ),
    ).toHaveLength(3);
    expect(
      first.db.all(
        "SELECT 1 FROM local_file_entries WHERE state IN ('forgotten', 'deleted') AND (relative_path IS NOT NULL OR content_hash IS NOT NULL)",
      ),
    ).toEqual([]);
    const states = (await first.locations()).map((l) => [l.id, l.state, l.stateReason]);
    expect(states.sort()).toEqual(
      [
        [a.id, "paused", "restored"],
        [b.id, "paused", "restored"],
      ].sort(),
    );
    expect(
      Number(first.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'connector-sync'")[0]?.n),
    ).toBe(jobsBefore);
    first.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");

    // a file made in the folder that was revoked is not read until the user turns the location on
    put(folderB, "new-7731.md", "ZQBODY-new-8842");
    await first.sync(() => liveIn(first.db, b.id) === 0, 4);
    expect(liveIn(first.db, b.id)).toBe(0);
    await first.call(routes.resumeLocalLocation.path, { locationId: b.id });
    await first.sync(() => liveIn(first.db, b.id) === 1);
    expect(liveIn(first.db, b.id)).toBe(1);
    // the files the user and the revocation deleted stay out when their locations are read again
    await first.call(routes.resumeLocalLocation.path, { locationId: a.id });
    await first.sync(() => liveIn(first.db, a.id) === 0, 4);
    expect(liveIn(first.db, a.id)).toBe(0);
    expect(liveIn(first.db, b.id)).toBe(1);
    const skipped = (await first.call(routes.localSkipped.path, { locationId: a.id })).body as {
      items: { reason: string }[];
    };
    expect(skipped.items.map((i) => i.reason)).toEqual(["user-deleted"]);
    await stop();
    expect(
      findCanaries(data, ["a-canary-path-7731", "b-canary-path-7731", "c-canary-path-7731"]),
    ).toEqual([]);
  }, 30_000);

  it("an ordinary restart leaves the states as they were, and a location left revoking is finished by the start", async () => {
    const folder = join(root, "docs");
    mkdirSync(folder);
    for (const n of ["a", "b", "c", "d", "e"]) put(folder, `${n}.md`, `body ${n}`);
    let started = await boot();
    await started.call(routes.setLocalFilesSettings.path, {
      settleMs: 1,
      revoke: { maxPerTransaction: 2 },
    });
    const loc = (
      await started.call(routes.approveLocalLocation.path, { type: "folder", path: folder })
    ).body as LocalLocationInfo;
    await started.sync(() => liveIn(started.db, loc.id) === 5);
    expect(liveIn(started.db, loc.id)).toBe(5);
    await stop();

    started = await boot(); // no ledger line to apply: nothing is paused
    expect((await started.locations())[0]).toMatchObject({ state: "active" });
    // stopped between batches: the location is revoking and its sources are still alive
    started.db.run("UPDATE local_locations SET state = 'revoking' WHERE id = ?", [loc.id]);
    await stop();

    started = await boot();
    for (let i = 0; i < 100 && (await started.locations()).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await started.locations()).toEqual([]);
    expect(liveIn(started.db, loc.id)).toBe(0);
    expect(Number(started.db.all("SELECT count(*) AS n FROM local_file_entries")[0]?.n)).toBe(0);
  });
});
