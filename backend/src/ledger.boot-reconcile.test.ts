// I04-C3 `ledger.boot-reconcile` and the backend side of `restore.reapply` (I04-R17):
// a real process killed after the ledger line is fsynced and before COMMIT, then a normal
// start; the start applies the deletion before the API opens; a database restored older
// has its deletions applied again; a line that cannot be applied stops the start.
import { routes } from "@pki/contracts";
import {
  ENGINE_KIND,
  LedgerReapplyError,
  VECTOR_KIND,
  createProductRegistry,
  liftTombstone,
  userDelete,
} from "@pki/knowledge-engine";
import {
  LEDGER_FILE,
  canonicalTransaction,
  readLedgerSeq,
  readTombstoneState,
  registerConnectorInstance,
  saveSourceRecord,
  listInvalidations,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { send } from "@pki/testkit";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootBackend } from "./boot.ts";
import { CANONICAL_DB_FILE, openCanonicalDb } from "./composition.ts";
import { INTERIM_POLICY } from "./interim-policy.ts";
import { NO_SECRET_STORE } from "./secret-sources.ts";

const TOKEN = "t".repeat(43);
const ROOT = resolve(import.meta.dirname, "../..");
const CHILD = join(ROOT, "backend/src/ledger-kill.child.ts");
const AT = "2026-11-22T00:00:00.000Z";
const identity = (externalId = "chat") => ({
  connectorInstanceId: "c1",
  namespace: "n",
  externalId,
});

let dir: string;
let booted: Awaited<ReturnType<typeof bootBackend>> | undefined;

beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "pki-ledger-boot-"))));
afterEach(async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Two versions of one source, in a database prepared and ledgered as the backend opens it. */
function seeded(): SqlDriver {
  const db = openCanonicalDb(dir);
  registerConnectorInstance(db, "c1", "test-fixtures");
  for (const [i, externalId] of ["chat", "chat", "mail"].entries()) {
    saveSourceRecord(db, "c1", { namespace: "n", externalId, title: `t${i}`, body: `b${i} 본문` });
  }
  return db;
}
const start = async (registry?: DerivativeRegistry) =>
  (booted = await bootBackend({
    dataDir: dir,
    token: TOKEN,
    allowedOrigins: [],
    secrets: NO_SECRET_STORE,
    ...(registry ? { registry } : {}),
  }));
/** The product's registry that notes each propagation in `order`. */
function spiedRegistry(order: string[]): DerivativeRegistry {
  const base = createProductRegistry({ policy: INTERIM_POLICY });
  return {
    ...base,
    propagate: (tx, change) => {
      order.push("propagate");
      return base.propagate(tx, change);
    },
  };
}
const sourcesShown = async () => {
  const { port } = booted!.server;
  const res = await send(port, routes.sources.path, {
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${TOKEN}`,
  });
  return (res.body as { sources: { externalId: string }[] }).sources.map((s) => s.externalId);
};
const stop = async () => {
  await booted?.server.close();
  booted?.db.close();
  booted = undefined;
};
const versionsOf = (db: SqlDriver, externalId: string) =>
  db.all(
    `SELECT count(*) AS n FROM source_versions v JOIN sources s ON s.id = v.source_id
      WHERE s.external_id = ?`,
    [externalId],
  )[0]?.n;

describe("ledger.boot-reconcile", () => {
  it("a process killed after the ledger line is fsynced and before COMMIT: a normal start applies the deletion before the API opens, and records it", async () => {
    seeded().close();
    const child = spawnSync(process.execPath, [CHILD], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", PKI_KILL_DATA_DIR: dir },
      encoding: "utf8",
    });
    // killed by SIGKILL, not exited: the crash happened after the line was written
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const ledger = readFileSync(join(dir, LEDGER_FILE), "utf8");
    expect(ledger.match(/"t":"line"/g)).toHaveLength(1);
    expect(ledger).not.toContain("cancel");
    // the database did not commit: the next open sees the source whole and no tombstone
    const raw = openCanonicalDb(dir);
    expect(versionsOf(raw, "chat")).toBe(2);
    expect(readLedgerSeq(raw)).toBe(0);
    raw.close();

    await start();

    expect(await sourcesShown()).toEqual(["mail"]);
    expect(versionsOf(booted!.db, "chat")).toBe(0);
    expect(readLedgerSeq(booted!.db)).toBe(1);
    expect(listInvalidations(booted!.db).map((r) => r.changeKind)).toEqual(["user-deleted"]);
    // the removal from the engine and vector index is registered as for any deletion (I04-T04)
    const removals = booted!.db.all("SELECT kind FROM jobs WHERE kind = 'projection-remove'");
    expect(removals.length).toBeGreaterThan(0);
  });

  it("applies the deletion before the server listens", async () => {
    seeded().close();
    spawnSync(process.execPath, [CHILD], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", PKI_KILL_DATA_DIR: dir },
    });
    const order: string[] = [];
    const listen = http.Server.prototype.listen;
    vi.spyOn(http.Server.prototype, "listen").mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      order.push("listen");
      return listen.apply(this, args as never);
    });
    await start(spiedRegistry(order));
    expect(order.indexOf("propagate")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("listen")).toBeGreaterThan(order.indexOf("propagate"));
  });

  it("a line that cannot be applied stops the start: no server is opened and the database keeps its state", async () => {
    seeded().close();
    spawnSync(process.execPath, [CHILD], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", PKI_KILL_DATA_DIR: dir },
    });
    const listen = vi.spyOn(http.Server.prototype, "listen");
    const failing: DerivativeRegistry = {
      ...createProductRegistry({ policy: INTERIM_POLICY }),
      propagate: () => {
        throw new Error("a kind failed");
      },
    };
    await expect(start(failing)).rejects.toBeInstanceOf(LedgerReapplyError);
    expect(listen).not.toHaveBeenCalled();
    const raw = openCanonicalDb(dir);
    expect(versionsOf(raw, "chat")).toBe(2);
    expect(readLedgerSeq(raw)).toBe(0);
    raw.close();
  });

  it("is idempotent across starts: the second start applies nothing and registers no rebuild", async () => {
    seeded().close();
    spawnSync(process.execPath, [CHILD], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", PKI_KILL_DATA_DIR: dir },
    });
    await start();
    const rebuilds = () =>
      booted!.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n;
    expect(rebuilds()).toBe(2); // the engine and the vector index, whatever their applied sequence says
    await stop();
    await start();
    expect(readLedgerSeq(booted!.db)).toBe(1);
    expect(rebuilds()).toBe(2);
    expect(booted!.db.all("SELECT count(*) AS n FROM invalidations")[0]?.n).toBe(1);
  });
});

describe("restore.reapply through the backend start", () => {
  it("a database restored to before the deletions: both the deletion and the lift are applied again before anything is readable", async () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity(), AT);
    userDelete(db, identity("mail"), AT);
    const sourceId = readTombstoneState(db, 1)?.sourceId as number;
    canonicalTransaction(db, (tx) => liftTombstone(tx, sourceId, "2026-11-23T00:00:00.000Z"));
    const final = {
      chat: readTombstoneState(db, sourceId),
      mail: readTombstoneState(db, 2),
    };
    db.close();
    // the restore: the older database in place, the ledger (not a backup file) untouched
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));

    await start();

    expect(readTombstoneState(booted!.db, sourceId)).toEqual(final.chat);
    expect(readTombstoneState(booted!.db, 2)).toEqual(final.mail);
    expect(readLedgerSeq(booted!.db)).toBe(3);
    expect(await sourcesShown()).toEqual([]);
    expect(
      booted!.db.all(
        "SELECT kind, target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target",
      ),
    ).toEqual([
      { kind: "projection-rebuild", target: ENGINE_KIND },
      { kind: "projection-rebuild", target: VECTOR_KIND },
    ]);
  });

  it("an applied line that registers no removal still has both projections rebuilt: the request is the reconcile's, not the open removals'", async () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity("ghost"), AT); // a source never seen: a tombstone of cover 0, nothing to remove
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));

    await start();

    expect(readLedgerSeq(booted!.db)).toBe(1);
    expect(
      booted!.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-remove'")[0]?.n,
    ).toBe(0);
    expect(
      booted!.db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target"),
    ).toEqual([{ target: ENGINE_KIND }, { target: VECTOR_KIND }]);
  });

  it("a ledger file that is gone: the start goes on, a new ledger starts after the database's number, the notice is stored, the projections are rebuilt", async () => {
    const db = seeded();
    db.close();
    rmSync(join(dir, LEDGER_FILE));

    await start();

    const report = JSON.parse(
      booted!.db.all("SELECT value FROM settings WHERE key = 'tombstone-ledger.report'")[0]
        ?.value as string,
    ) as { missing: boolean; applied: number };
    expect(report).toMatchObject({ missing: true, applied: 0 });
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(true);
    // nothing was deleted, so no removal is open: the rebuilds are the reconcile's own request
    expect(
      booted!.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-remove'")[0]?.n,
    ).toBe(0);
    expect(
      booted!.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n,
    ).toBe(2);
    // and a deletion made now is written to the new ledger
    userDelete(booted!.db, identity("mail"), AT);
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toMatch(/"t":"line","seq":1,/);
  });

  it("another installation's ledger beside the database is set aside, none of its deletions applied, its count kept for the notice, and the projections rebuilt", async () => {
    seeded().close();
    // the ledger of another installation: same file name, another key, one deletion
    const header = JSON.stringify({ t: "header", v: 1, key: "ab".repeat(32) });
    const line = JSON.stringify({
      t: "line",
      seq: 1,
      i: "c1",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: AT,
      la: null,
    });
    writeFileSync(join(dir, LEDGER_FILE), `${header}\n${line}\n`);

    await start();

    const report = JSON.parse(
      booted!.db.all("SELECT value FROM settings WHERE key = 'tombstone-ledger.report'")[0]
        ?.value as string,
    ) as { applied: number; setAside: { file: string; deletions: number }[] };
    expect(report.applied).toBe(0);
    expect(report.setAside).toEqual([
      expect.objectContaining({
        deletions: 1,
        file: join(dir, "tombstone-ledger.other-key-1.jsonl"),
      }),
    ]);
    expect(existsSync(join(dir, "tombstone-ledger.other-key-1.jsonl"))).toBe(true);
    expect(versionsOf(booted!.db, "chat")).toBe(2);
    expect(
      booted!.db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n,
    ).toBe(2);
  });

  it("every delete route of the started backend writes its ledger line (the ledger is attached to the database the API uses)", async () => {
    const db = seeded();
    db.close();
    await start();
    const { port } = booted!.server;
    const headers = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` };
    const res = await send(port, routes.deleteSource.path, headers, "POST", {
      connectorId: "c1",
      namespace: "n",
      externalId: "mail",
    });
    expect(res.body).toEqual({ outcome: "deleted" });
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8")).toMatch(/"t":"line","seq":1,/);
  });
});
