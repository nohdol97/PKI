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
  defaultScopePolicy,
  ledgerOf,
  listInvalidations,
  purgeEndedJobs,
  type DerivativeRegistry,
  type SqlDriver,
} from "@pki/storage";
import { EmptyVectorIndex } from "@pki/storage/adapters";
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
import {
  CANONICAL_DB_FILE,
  openCanonicalDb,
  productEngine,
  productRegistry,
} from "./composition.ts";
import { reapplyAtStart } from "./ledger-boot.ts";
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
const live = () => {
  if (!booted) throw new Error("the backend is not started");
  return booted;
};
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
  const base = createProductRegistry({ policy: defaultScopePolicy });
  return {
    ...base,
    propagate: (tx, change) => {
      order.push("propagate");
      return base.propagate(tx, change);
    },
  };
}
const sourcesShown = async () => {
  const { port } = live().server;
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
    expect(versionsOf(live().db, "chat")).toBe(0);
    expect(readLedgerSeq(live().db)).toBe(1);
    expect(listInvalidations(live().db).map((r) => r.changeKind)).toEqual(["user-deleted"]);
    // the removal from the engine and vector index is registered as for any deletion (I04-T04)
    const removals = live().db.all("SELECT kind FROM jobs WHERE kind = 'projection-remove'");
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
      ...createProductRegistry({ policy: defaultScopePolicy }),
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
      live().db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n;
    expect(rebuilds()).toBe(2); // the engine and the vector index, whatever their applied sequence says
    await stop();
    await start();
    expect(readLedgerSeq(live().db)).toBe(1);
    expect(rebuilds()).toBe(2);
    expect(live().db.all("SELECT count(*) AS n FROM invalidations")[0]?.n).toBe(1);
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

    expect(readTombstoneState(live().db, sourceId)).toEqual(final.chat);
    expect(readTombstoneState(live().db, 2)).toEqual(final.mail);
    expect(readLedgerSeq(live().db)).toBe(3);
    expect(await sourcesShown()).toEqual([]);
    expect(
      live().db.all(
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

    expect(readLedgerSeq(live().db)).toBe(1);
    expect(
      live().db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-remove'")[0]?.n,
    ).toBe(0);
    expect(
      live().db.all("SELECT target FROM jobs WHERE kind = 'projection-rebuild' ORDER BY target"),
    ).toEqual([{ target: ENGINE_KIND }, { target: VECTOR_KIND }]);
  });

  it("a ledger file that is gone: the start goes on, a new ledger starts after the database's number, the notice is stored, the projections are rebuilt", async () => {
    const db = seeded();
    db.close();
    rmSync(join(dir, LEDGER_FILE));

    await start();

    const report = JSON.parse(
      live().db.all("SELECT value FROM settings WHERE key = 'tombstone-ledger.report'")[0]
        ?.value as string,
    ) as { missing: boolean; applied: number };
    expect(report).toMatchObject({ missing: true, applied: 0 });
    expect(existsSync(join(dir, LEDGER_FILE))).toBe(true);
    // nothing was deleted, so no removal is open: the rebuilds are the reconcile's own request
    expect(
      live().db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-remove'")[0]?.n,
    ).toBe(0);
    expect(
      live().db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n,
    ).toBe(2);
    // and a deletion made now is written to the new ledger
    userDelete(live().db, identity("mail"), AT);
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
      live().db.all("SELECT value FROM settings WHERE key = 'tombstone-ledger.report'")[0]
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
    expect(versionsOf(live().db, "chat")).toBe(2);
    expect(
      live().db.all("SELECT count(*) AS n FROM jobs WHERE kind = 'projection-rebuild'")[0]?.n,
    ).toBe(2);
  });

  it("every delete route of the started backend writes its ledger line (the ledger is attached to the database the API uses)", async () => {
    const db = seeded();
    db.close();
    await start();
    const { port } = live().server;
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

describe("retention and the re-applied removals", () => {
  it("purgeEndedJobs never deletes the open projection-remove jobs a re-applied tombstone registered", () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity(), AT);
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    const restored = openCanonicalDb(dir);
    reapplyAtStart(
      restored,
      productRegistry({ engine: productEngine(), vectorIndex: new EmptyVectorIndex() }),
      Date.parse(AT),
    );
    const open = () =>
      restored.all(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'projection-remove' AND status NOT IN ('succeeded', 'superseded', 'cancelled', 'dead_letter')",
      )[0]?.n as number;
    const before = open();
    expect(before).toBeGreaterThan(0);
    purgeEndedJobs(restored, Date.parse(AT) + 10 ** 12);
    expect(open()).toBe(before);
    restored.close();
  });
});

describe("re-apply onto a database that lacks the line's connector instance", () => {
  const expectDeletedAndSyncable = () => {
    const db = live().db;
    expect(db.all("SELECT count(*) AS n FROM tombstones")[0]?.n).toBe(1);
    expect(versionsOf(db, "chat")).toBe(0);
    // the instance is registered with its real kind, so a later sync of the same kind is not refused
    expect(() => registerConnectorInstance(db, "c1", "test-fixtures")).not.toThrow();
  };

  it("a fresh database beside a ledger (the ledger's key is adopted): the instance is registered with its real kind and the deletion applies", async () => {
    const db = seeded();
    userDelete(db, identity(), AT);
    db.close();
    rmSync(join(dir, CANONICAL_DB_FILE));

    await start();

    expectDeletedAndSyncable();
  });

  it("a backup older than the instance that later had a deletion: the start goes on and the deletion applies", async () => {
    const early = openCanonicalDb(dir);
    early.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    early.close();
    const db = seeded();
    userDelete(db, identity(), AT);
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));

    await start();

    expectDeletedAndSyncable();
  });

  it("a line written without a kind for an instance the database does not know is counted, its number taken, and the start goes on", async () => {
    seeded().close();
    const header = JSON.stringify({ t: "header", v: 1, key: "" });
    const real = readFileSync(join(dir, LEDGER_FILE), "utf8").split("\n")[0] ?? header;
    const line = JSON.stringify({
      t: "line",
      seq: 1,
      i: "unknown-instance",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: AT,
      la: null,
    });
    writeFileSync(join(dir, LEDGER_FILE), `${real}\n${line}\n`);

    await start();

    const report = JSON.parse(
      live().db.all("SELECT value FROM settings WHERE key = 'tombstone-ledger.report'")[0]
        ?.value as string,
    ) as { applied: number; unrecoverable: number };
    expect(report).toMatchObject({ applied: 0, unrecoverable: 1 });
    expect(readLedgerSeq(live().db)).toBe(1);
  });
});

describe("a ledger started over existing tombstones", () => {
  it("is seeded with them: after the ledger is lost, a later restore of an older database brings the deletion back no more", async () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity(), AT);
    db.close();
    rmSync(join(dir, LEDGER_FILE));

    await start();
    expect(readFileSync(join(dir, LEDGER_FILE), "utf8").match(/"t":"line"/g)).toHaveLength(1);
    await stop();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    await start();

    expect(versionsOf(live().db, "chat")).toBe(0);
    expect(versionsOf(live().db, "mail")).toBe(1);
  });

  it("carries a lifted state as it is", async () => {
    const db = seeded();
    userDelete(db, identity(), AT);
    const sourceId = readTombstoneState(db, 1)?.sourceId as number;
    canonicalTransaction(db, (tx) => liftTombstone(tx, sourceId, "2026-11-23T00:00:00.000Z"));
    db.close();
    rmSync(join(dir, LEDGER_FILE));
    await start();
    const lines = readFileSync(join(dir, LEDGER_FILE), "utf8").trimEnd().split("\n").slice(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      la: "2026-11-23T00:00:00.000Z",
      k: "test-fixtures",
    });
  });
});

describe("the status API's data protection item shows the ledger", () => {
  const ledgerOfStatus = async () => {
    const { port } = live().server;
    const res = await send(port, routes.status.path, {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    // the history is tested apart (it outlives the state): only the current state is compared here
    const { history: _history, ...current } = (
      res.body as { dataProtection: { ledger: { history: unknown } } }
    ).dataProtection.ledger;
    return current;
  };
  const OK = {
    state: "ok",
    reapplied: 0,
    unrecoverable: 0,
    ignoredLines: 0,
    setAsideLedgers: 0,
    setAsideDeletions: 0,
  };

  it("ok with zeros after an ordinary start", async () => {
    seeded().close();
    await start();
    expect(await ledgerOfStatus()).toEqual(OK);
  });

  it("missing-created when the ledger file was gone", async () => {
    seeded().close();
    rmSync(join(dir, LEDGER_FILE));
    await start();
    expect(await ledgerOfStatus()).toEqual({ ...OK, state: "missing-created" });
  });

  it("the number of deletions re-applied at the start", async () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity(), AT);
    db.close();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    await start();
    expect(await ledgerOfStatus()).toEqual({ ...OK, reapplied: 1 });
  });

  it("the set-aside ledgers and their deletions, and still after the next start", async () => {
    seeded().close();
    const header = JSON.stringify({ t: "header", v: 1, key: "ab".repeat(32) });
    const line = JSON.stringify({
      t: "line",
      seq: 1,
      i: "c1",
      k: "test-fixtures",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: AT,
      la: null,
    });
    writeFileSync(join(dir, LEDGER_FILE), `${header}\n${line}\n`);
    await start();
    expect(await ledgerOfStatus()).toMatchObject({ setAsideLedgers: 1, setAsideDeletions: 1 });
    await stop();
    await start();
    expect(await ledgerOfStatus()).toEqual({ ...OK, setAsideLedgers: 1, setAsideDeletions: 1 });
  });

  it("a cut last line is counted as one ignored line", async () => {
    seeded().close();
    writeFileSync(
      join(dir, LEDGER_FILE),
      `${readFileSync(join(dir, LEDGER_FILE), "utf8")}{"t":"li`,
    );
    await start();
    expect(await ledgerOfStatus()).toEqual({ ...OK, ignoredLines: 1 });
  });

  it("degraded while the ledger is locked", async () => {
    seeded().close();
    await start();
    ledgerOf(live().db)?.lock();
    expect(await ledgerOfStatus()).toEqual({ ...OK, state: "degraded" });
  });

  it("the unrecoverable lines of a ledger that carries no kind", async () => {
    seeded().close();
    const real = readFileSync(join(dir, LEDGER_FILE), "utf8").split("\n")[0];
    const line = JSON.stringify({
      t: "line",
      seq: 1,
      i: "unknown-instance",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: AT,
      la: null,
    });
    writeFileSync(join(dir, LEDGER_FILE), `${real}\n${line}\n`);
    await start();
    expect(await ledgerOfStatus()).toEqual({ ...OK, unrecoverable: 1 });
  });
});

describe("a seed that was cut short, and the history that outlives the current state", () => {
  const headerOnly = () => {
    const [header] = readFileSync(join(dir, LEDGER_FILE), "utf8").split("\n");
    writeFileSync(join(dir, LEDGER_FILE), `${header}\n`);
  };
  const statusOf = async () => {
    const { port } = live().server;
    const res = await send(port, routes.status.path, {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${TOKEN}`,
    });
    return (res.body as { dataProtection: { ledger: Record<string, unknown> } }).dataProtection
      .ledger as {
      state: string;
      history: Record<string, { total: number; last: string | null }>;
    };
  };

  it("a header-only ledger over a database with deletions is completed at the start, reported, and a later restore of an older backup applies the deletion", async () => {
    const db = seeded();
    db.exec(`VACUUM INTO '${join(dir, "backup.sqlite")}'`);
    userDelete(db, identity(), AT);
    db.close();
    headerOnly(); // the state a crash between the header and the seed left in an earlier build

    await start();

    expect(readFileSync(join(dir, LEDGER_FILE), "utf8").match(/"t":"line"/g)).toHaveLength(1);
    const status = await statusOf();
    expect(status.history.seeded?.total).toBe(1);
    expect(status.history.seeded?.last).not.toBeNull();
    await stop();
    copyFileSync(join(dir, "backup.sqlite"), join(dir, CANONICAL_DB_FILE));
    await start();
    expect(versionsOf(live().db, "chat")).toBe(0);
  });

  it("a ledger created because it was missing is not forgotten after a restart: the state is ok, the history says when", async () => {
    seeded().close();
    rmSync(join(dir, LEDGER_FILE));
    await start();
    expect((await statusOf()).state).toBe("missing-created");
    const first = (await statusOf()).history.missingCreated;
    expect(first?.total).toBe(1);
    await stop();
    await start();
    const second = await statusOf();
    expect(second.state).toBe("ok");
    expect(second.history.missingCreated).toEqual(first); // kept, not counted twice
    await stop();
    await start();
    expect((await statusOf()).history.missingCreated).toEqual(first);
  });

  it("an unrecoverable line stays in the history after the restarts that follow, and an unreadable line already seen is not counted again", async () => {
    seeded().close();
    const real = readFileSync(join(dir, LEDGER_FILE), "utf8").split("\n")[0];
    const good = {
      t: "line",
      seq: 1,
      i: "unknown-instance",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: AT,
      la: null,
    };
    writeFileSync(join(dir, LEDGER_FILE), `${real}\n${JSON.stringify(good)}\n{broken\n`);
    await start();
    const first = await statusOf();
    expect(first.history.unrecoverable?.total).toBe(1);
    expect(first.history.ignoredLines?.total).toBe(1);
    await stop();
    await start();
    const second = await statusOf();
    expect(second.state).toBe("ok");
    expect(second.history.unrecoverable).toEqual(first.history.unrecoverable);
    expect(second.history.ignoredLines).toEqual(first.history.ignoredLines);
  });

  it("a well-formed line whose time is not a date never stops the start: it is unreadable, counted and skipped", async () => {
    seeded().close();
    const real = readFileSync(join(dir, LEDGER_FILE), "utf8").split("\n")[0];
    const bad = {
      t: "line",
      seq: 1,
      i: "c1",
      k: "test-fixtures",
      h: "00".repeat(32),
      cv: 1,
      lr: null,
      reason: "user-deleted",
      at: "not a date",
      la: null,
    };
    writeFileSync(join(dir, LEDGER_FILE), `${real}\n${JSON.stringify(bad)}\n`);
    await start();
    expect((await statusOf()).history.ignoredLines?.total).toBe(1);
    expect(versionsOf(live().db, "chat")).toBe(2);
  });
});
