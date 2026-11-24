// The ledger applied again (I04-R17, I04-C3 `restore.reapply`): a database restored to
// before a deletion is brought to the state the deletion left, from the ledger beside it,
// and the same function is the start-up reconcile (the crash and the backend start are
// backend/src/ledger.boot-reconcile.test.ts). Backups here are real copies of a file
// database (`VACUUM INTO`); the ledger's file is in memory with failures injected.
import {
  addEvidence,
  attachLedger,
  defaultScopePolicy,
  type ScopePolicy,
  canonicalTransaction,
  identityKey,
  insertItem,
  LEDGER_SEQ_SETTING,
  listInvalidations,
  migrate,
  migrations,
  openLedger,
  parseLedger,
  prepareCanonicalDb,
  readKey,
  readLedgerSeq,
  schemaVersion,
  readSetting,
  readTombstoneState,
  registerConnectorInstance,
  saveFact,
  saveSourceRecord,
  writeLedgerSeq,
  writeSetting,
  type KnowledgeAttributes,
  type SqlDriver,
  type TombstoneLedger,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { memoryLedgerIo, type MemoryLedgerIo } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProductRegistry, derivativeRegistry } from "./canonical-kinds.ts";
import { COMPLETION_DATE } from "./dependency-delay.ts";
import { createLedgerReapply, LedgerReapplyError, reapplyLedger } from "./ledger-reapply.ts";
import { applyTombstone, liftTombstone } from "./tombstone-entry.ts";

const attrs: KnowledgeAttributes = {
  epistemic: "explicit",
  status: "candidate",
  validAt: null,
  observedAt: "2026-11-21T00:00:00Z",
};
const AT = "2026-11-22T00:00:00.000Z";
const LATER = "2026-11-23T00:00:00.000Z";
const P = "/data/tombstone-ledger.jsonl";

let dir: string;
let io: MemoryLedgerIo;
let db: SqlDriver;
let chat: number;
let n = 0;
const opened: SqlDriver[] = [];

/** A migrated database with the ledger of `io` attached: two sources, `chat` with two versions. */
function fresh(): SqlDriver {
  const d = openBetterSqlite3(join(dir, `db${n++}.sqlite`));
  opened.push(d);
  return d;
}
function attach(d: SqlDriver): TombstoneLedger {
  const l = openLedger({
    path: P,
    key: readKey(d) as Uint8Array,
    canonicalSeq: readLedgerSeq(d),
    hasData: d.all("SELECT 1 FROM sources LIMIT 1").length > 0,
    io,
  });
  attachLedger(d, l);
  return l;
}
function seed(d: SqlDriver, versions = 2): number {
  const item = insertItem(d, { type: "Project", name: "미리내 프로젝트", ...attrs });
  let id = 0;
  for (let v = 1; v <= versions; v++) {
    const saved = saveSourceRecord(d, "c1", {
      namespace: "n",
      externalId: "chat",
      title: "chat",
      body: `완료 ${v}`,
    });
    if (saved.status !== "created") throw new Error(saved.status);
    id = saved.sourceId;
    const vid = d.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;
    const fact = saveFact(d, {
      itemId: item,
      kind: COMPLETION_DATE,
      value: `2026-12-1${v}`,
      ...attrs,
    });
    addEvidence(d, {
      target: { factId: fact.id },
      sourceVersionId: vid,
      start: 0,
      end: 4,
      quote: `완료 ${v}`,
    });
  }
  return id;
}
const identity = { connectorInstanceId: "c1", namespace: "n", externalId: "chat" };
const mailIdentity = { connectorInstanceId: "c1", namespace: "n", externalId: "mail" };
function seedSecond(d: SqlDriver): number {
  const saved = saveSourceRecord(d, "c1", {
    namespace: "n",
    externalId: "mail",
    title: "m",
    body: "x",
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return saved.sourceId;
}
const del = (d: SqlDriver, reason: "user-deleted" | "source-deleted" = "user-deleted", at = AT) =>
  canonicalTransaction(d, (tx) =>
    applyTombstone(tx, {
      identity,
      reason,
      lastRevision: reason === "user-deleted" ? null : 4,
      at,
    }),
  );
const lift = (d: SqlDriver, sourceId: number, at = LATER) =>
  canonicalTransaction(d, (tx) => liftTombstone(tx, sourceId, at));
const file = () => parseLedger(io.files.get(P) as string);
/** A copy of the database as it is now: the backup. */
function backup(d: SqlDriver): SqlDriver {
  const path = join(dir, `backup${n++}.sqlite`);
  d.exec(`VACUUM INTO '${path}'`);
  const copy = openBetterSqlite3(path);
  opened.push(copy);
  return copy;
}
/** The restored database starts: prepared with the ledger's key, the ledger attached. */
function restart(d: SqlDriver): TombstoneLedger {
  const text = io.files.get(P);
  const key = text === undefined ? undefined : parseLedger(text).key;
  prepareCanonicalDb(d, key ? { ledgerKey: Uint8Array.from(Buffer.from(key, "hex")) } : {});
  return attach(d);
}
const rows = (d: SqlDriver, table: string) => d.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n;
const state = (d: SqlDriver) => ({
  versions: rows(d, "source_versions"),
  facts: rows(d, "facts"),
  evidence: rows(d, "evidence"),
  tombstone: readTombstoneState(d, chat),
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-reapply-"));
  io = memoryLedgerIo();
  db = fresh();
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  prepareCanonicalDb(db);
  attach(db);
  chat = seed(db);
});
afterEach(() => {
  for (const d of opened) d.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("restore.reapply", () => {
  it("brings a database restored to before the deletion to the state the deletion left, with the same record", () => {
    const old = backup(db);
    del(db);
    const afterDeletion = state(db);
    expect(afterDeletion.versions).toBe(0);
    restart(old);
    expect(state(old).versions).toBe(2); // the backup still holds the chat

    const report = reapplyLedger(old);

    expect(report).toMatchObject({ applied: 1, lifted: 0, skipped: 0, canonicalSeq: 1 });
    expect(state(old)).toEqual(afterDeletion);
    expect(readLedgerSeq(old)).toBe(1);
    const record = listInvalidations(old).filter((r) => r.sourceId === chat);
    expect(record).toHaveLength(1);
    expect(record[0]).toMatchObject({ changeKind: "user-deleted" });
    // the plain identity of the source is the keyed hash from here on (I04-R7)
    expect(old.all("SELECT namespace, identity_hashed FROM sources WHERE id = ?", [chat])).toEqual([
      { namespace: identityKey(old, "c1", "n", "chat"), identity_hashed: 1 },
    ]);
    // the reconcile writes no new line
    expect(file().lines).toHaveLength(1);
  });

  it("is idempotent: a second run, and the same line repeated in the file, change nothing", () => {
    const old = backup(db);
    del(db);
    restart(old);
    reapplyLedger(old);
    const once = state(old);
    const records = listInvalidations(old).length;

    expect(reapplyLedger(old)).toMatchObject({ applied: 0, skipped: 1 });
    const text = io.files.get(P) as string;
    io.files.set(P, `${text}${text.split("\n")[1]}\n`);
    expect(reapplyLedger(old)).toMatchObject({ applied: 0, skipped: 2 });
    expect(state(old)).toEqual(once);
    expect(listInvalidations(old)).toHaveLength(records);
  });

  it("carries a lift as it is, leaving no invalidation record for it, and the same sources lift in order", () => {
    const old = backup(db);
    del(db);
    lift(db, chat);
    expect(file().lines.map((l) => [l.seq, l.liftedAt !== null])).toEqual([
      [1, false],
      [2, true],
    ]);
    restart(old);

    expect(reapplyLedger(old)).toMatchObject({ applied: 2, lifted: 1, canonicalSeq: 2 });

    expect(readTombstoneState(old, chat)).toEqual(readTombstoneState(db, chat));
    expect(readTombstoneState(old, chat)?.liftedAt).toBe(LATER);
    expect(listInvalidations(old).filter((r) => r.sourceId === chat)).toHaveLength(1);
  });

  it("applies the lines in sequence order whatever their order in the file: none is passed over because a higher number came first", () => {
    const mail = seedSecond(db);
    const old = backup(db);
    del(db); // line 1: chat
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: mailIdentity,
        reason: "user-deleted",
        lastRevision: null,
        at: LATER,
      }),
    ); // line 2: mail
    const [header, one, two] = (io.files.get(P) as string).trimEnd().split("\n");
    io.files.set(P, [header, two, one].join("\n") + "\n");
    restart(old);
    expect(reapplyLedger(old)).toMatchObject({ applied: 2, skipped: 0 });
    expect(readTombstoneState(old, chat)).toMatchObject({ coversVersion: 2 });
    expect(readTombstoneState(old, mail)).toMatchObject({ coversVersion: 1 });
    expect(readLedgerSeq(old)).toBe(2);
  });

  it("a line that repeats the state the database already has is carried (its number is taken) without a second propagation", () => {
    const old = backup(db);
    del(db);
    const text = io.files.get(P) as string;
    const line = text.split("\n")[1] as string;
    io.files.set(P, `${text}${line.replace('"seq":1', '"seq":2')}\n`);
    restart(old);
    expect(reapplyLedger(old)).toMatchObject({ applied: 2, canonicalSeq: 2 });
    expect(listInvalidations(old).filter((r) => r.sourceId === chat)).toHaveLength(1);
  });

  it("does not apply a line at or below the database's number, or one a cancel record names", () => {
    const old = backup(db);
    del(db);
    restart(old);
    writeLedgerSeq(old, 1); // the database says it has applied line 1
    expect(reapplyLedger(old)).toMatchObject({ applied: 0, skipped: 1 });
    expect(state(old).versions).toBe(2);

    writeLedgerSeq(old, 0);
    io.files.set(P, `${io.files.get(P)}${JSON.stringify({ t: "cancel", seqs: [1] })}\n`);
    expect(reapplyLedger(old)).toMatchObject({ applied: 0, skipped: 0 });
    expect(state(old).versions).toBe(2);
    expect(readTombstoneState(old, chat)).toBeUndefined();
  });

  it("a ledger restored older than the database changes nothing, and the next deletion does not reuse a number the database has", () => {
    del(db);
    const stale = io.files.get(P) as string;
    lift(db, chat);
    expect(readLedgerSeq(db)).toBe(2);
    io.files.set(P, stale); // only line 1 survives in the file
    attach(db);
    expect(reapplyLedger(db)).toMatchObject({ applied: 0, skipped: 1 });
    del(db, "source-deleted", LATER);
    expect(file().lines.map((l) => l.seq)).toEqual([1, 3]);
  });

  it("gives the tombstone the line's cover when the restored database is older than it", () => {
    // the backup holds version 1 only: its latest version is below the line's cover of 2
    const early = fresh();
    migrate(early);
    registerConnectorInstance(early, "c1", "test-fixtures");
    prepareCanonicalDb(early);
    early.run("UPDATE identity_key SET key = ?", [readKey(db) as Uint8Array]);
    seed(early, 1);
    del(db);
    const linesBefore = file().lines.length;
    attachLedger(
      early,
      openLedger({
        path: P,
        key: readKey(early) as Uint8Array,
        canonicalSeq: 0,
        hasData: true,
        io,
      }),
    );

    reapplyLedger(early);

    expect(readTombstoneState(early, chat)).toMatchObject({ coversVersion: 2 });
    expect(readLedgerSeq(early)).toBe(1);
    expect(rows(early, "source_versions")).toBe(0);
    expect(file().lines).toHaveLength(linesBefore); // no new line
  });

  it("carries the line's cover as it stands, even below the cover the database holds (no judging against the stored row)", () => {
    const old = backup(db);
    del(db); // line 1: cover 2
    restart(old);
    old.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, 5, 'x', 'source-deleted')",
      [chat],
    );
    reapplyLedger(old);
    expect(readTombstoneState(old, chat)).toMatchObject({
      coversVersion: 2,
      reason: "user-deleted",
    });
  });

  it("a line that fails leaves its tombstone and its number as they were and names the line; the lines before it stay", () => {
    const mail = seedSecond(db);
    const old = backup(db);
    del(db);
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: mailIdentity,
        reason: "user-deleted",
        lastRevision: null,
        at: LATER,
      }),
    );
    restart(old);
    const failing = createLedgerReapply({
      ...derivativeRegistry,
      propagate: (tx, change) => {
        if (change.sourceId === mail) throw new Error("kind failed");
        return derivativeRegistry.propagate(tx, change);
      },
    });

    let error: unknown;
    try {
      failing(old);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(LedgerReapplyError);
    expect((error as LedgerReapplyError).seq).toBe(2);
    expect(readLedgerSeq(old)).toBe(1);
    expect(readTombstoneState(old, chat)).toMatchObject({ reason: "user-deleted" });
    expect(readTombstoneState(old, mail)).toBeUndefined();
    expect(
      old.all("SELECT count(*) AS n FROM source_versions WHERE source_id = ?", [mail]),
    ).toEqual([{ n: 1 }]);
    // the next run, with a registry that works, applies it
    expect(reapplyLedger(old)).toMatchObject({ applied: 1, canonicalSeq: 2 });
    expect(readTombstoneState(old, mail)).toMatchObject({ coversVersion: 1 });
  });

  it("F123-C1 does not read the instance's plain sources again for each line of a source never seen", () => {
    const M = 300;
    const N = 20;
    for (let i = 0; i < M; i++) {
      db.run(
        "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, ?, ?)",
        ["c1", "n", `plain-${i}`],
      );
    }
    const old = backup(db);
    for (let i = 0; i < N; i++) {
      canonicalTransaction(db, (tx) =>
        applyTombstone(tx, {
          identity: { connectorInstanceId: "c1", namespace: "n", externalId: `never-${i}` },
          reason: "user-deleted",
          lastRevision: null,
          at: AT,
        }),
      );
    }
    restart(old);
    let returned = 0;
    const all = old.all.bind(old);
    old.all = (sql, params) => {
      const found = all(sql, params);
      returned += found.length;
      return found;
    };

    const report = reapplyLedger(old);

    expect(report.applied).toBe(N);
    // one pass over the M plain sources, not one per line (base: at least M * N)
    expect(returned).toBeLessThan(3 * M);
  });

  it("RFU-C5 neither adds nor removes a plain source, nor unhashes one, when lines are re-applied", () => {
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES (?, ?, ?)",
        ["c1", "n", `plain-${i}`],
      );
    }
    const old = backup(db);
    for (const externalId of ["plain-2", "never-seen"]) {
      canonicalTransaction(db, (tx) =>
        applyTombstone(tx, {
          identity: { connectorInstanceId: "c1", namespace: "n", externalId },
          reason: "user-deleted",
          lastRevision: null,
          at: AT,
        }),
      );
    }
    restart(old);
    const sourcesOf = (d: SqlDriver) =>
      d.all("SELECT id, namespace, external_id, identity_hashed FROM sources");
    const before = sourcesOf(old);

    expect(reapplyLedger(old).applied).toBe(2);

    const after = sourcesOf(old);
    // every row there before is there after
    const idsAfter = after.map((r) => r.id);
    for (const r of before) expect(idsAfter).toContain(r.id);
    // a row that is plain after was the same plain row before
    for (const r of after.filter((x) => x.identity_hashed === 0)) {
      expect(before).toContainEqual(r);
    }
  });
});

describe("under a scope policy (I04-T09)", () => {
  const refusing = {
    ...defaultScopePolicy,
    allows: () => false,
    combinable: () => false,
    strictest: () => ({ incomparable: [] }),
  } as unknown as ScopePolicy;
  const throwing = new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("a scope policy was asked during a deletion");
      },
    },
  ) as unknown as ScopePolicy;

  it.each([
    ["refusing", refusing],
    ["throwing", throwing],
  ])(
    "a deletion is re-applied under a %s policy, and the source's drop rows go with it",
    (_name, policy) => {
      const mail = seedSecond(db);
      const old = backup(db);
      del(db);
      const afterDeletion = state(db);
      restart(old);
      const drop = (sourceId: number) =>
        old.run(
          "INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at) VALUES (?, 1, 'fact', 'h', 'scope-policy', 'x')",
          [sourceId],
        );
      drop(chat);
      drop(mail);

      createLedgerReapply(createProductRegistry({ policy }))(old);

      expect(state(old)).toEqual(afterDeletion);
      expect(old.all("SELECT source_id FROM scope_policy_drops")).toEqual([{ source_id: mail }]);
    },
  );
});

describe("what the ledger and the database say about each other", () => {
  it("reports a missing ledger when the database holds data, and starts a new one that continues the numbers", () => {
    del(db);
    const old = backup(db);
    io.files.clear();
    restart(old);
    const report = reapplyLedger(old);
    expect(report).toMatchObject({ missing: true, applied: 0 });
    expect(JSON.parse(readSetting(old, "tombstone-ledger.report") as string)).toMatchObject({
      missing: true,
    });
    // a deletion after the backup is unknown, but the next one is written and numbered after the database's
    expect(parseLedger(io.files.get(P) as string).key).toBe(
      Buffer.from(readKey(old) as Uint8Array).toString("hex"),
    );
  });

  it("does not report a missing ledger for a database with no data (a fresh install)", () => {
    const empty = fresh();
    migrate(empty);
    prepareCanonicalDb(empty);
    io.files.clear();
    attach(empty);
    expect(reapplyLedger(empty)).toMatchObject({ missing: false });
  });

  it("sets another installation's ledger aside, shows how many deletions it held, applies none of them, and the new ledger continues after the database's number", () => {
    del(db);
    const foreign = parseLedger(io.files.get(P) as string);
    expect(foreign.lines).toHaveLength(1);
    const other = fresh();
    migrate(other);
    registerConnectorInstance(other, "c1", "test-fixtures");
    prepareCanonicalDb(other); // its own random key, not the ledger's
    seed(other);
    restart(other);

    const report = reapplyLedger(other);

    expect(report.applied).toBe(0);
    expect(report.setAside).toEqual([
      { file: "/data/tombstone-ledger.other-key-1.jsonl", deletions: 1, reason: "other-key" },
    ]);
    expect(rows(other, "source_versions")).toBe(2); // nothing the foreign ledger said was applied
    del(other);
    expect(file().lines.map((l) => l.seq)).toEqual([1]);
    expect(readLedgerSeq(other)).toBe(1);
  });

  it("an I04-before database, with no key of its own, takes the ledger's key, and hashes its plain tombstones with it", () => {
    const legacy = fresh();
    migrate(legacy, migrations.slice(0, 13));
    legacy.run("INSERT INTO connector_instances (id, kind) VALUES ('c1', 'k')");
    legacy.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c1', 'n', 'gone')",
    );
    legacy.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (1, 0, 'x', 'user-deleted')",
    );
    const ledgerKey = readKey(db) as Uint8Array;
    expect(schemaVersion(legacy)).toBe(13);

    prepareCanonicalDb(legacy, { ledgerKey });

    expect(Buffer.from(readKey(legacy) as Uint8Array).equals(Buffer.from(ledgerKey))).toBe(true);
    // the plain row of the earlier build is hashed with the ledger's key, so the ledger's lines name it
    expect(legacy.all("SELECT namespace FROM sources WHERE id = 1")).toEqual([
      { namespace: identityKey(db, "c1", "n", "gone") },
    ]);
  });

  it("an I04-before database with no ledger beside it makes a key of its own", () => {
    const legacy = fresh();
    migrate(legacy, migrations.slice(0, 13));
    prepareCanonicalDb(legacy);
    expect(readKey(legacy)).toHaveLength(32);
  });

  it("a database that already has its key keeps it when the ledger's differs", () => {
    const own = fresh();
    migrate(own);
    prepareCanonicalDb(own);
    const key = Buffer.from(readKey(own) as Uint8Array);
    prepareCanonicalDb(own, { ledgerKey: new Uint8Array(32).fill(3) });
    expect(Buffer.from(readKey(own) as Uint8Array).equals(key)).toBe(true);
  });

  it("ignores a cut last line, says so, and applies the whole lines before it", () => {
    const old = backup(db);
    del(db);
    io.files.set(P, `${io.files.get(P)}{"t":"line","seq":2,"i":"c1","h":"x`);
    restart(old);
    expect(reapplyLedger(old)).toMatchObject({ applied: 1, truncated: true });
    expect(file().lines).toHaveLength(1);
    expect(io.files.get(P)?.endsWith("\n")).toBe(true);
  });

  it("reports a complete line it cannot read, and keeps the lines around it", () => {
    const old = backup(db);
    del(db);
    const [header, line] = (io.files.get(P) as string).trimEnd().split("\n");
    io.files.set(P, [header, "{broken", line].join("\n") + "\n");
    restart(old);
    expect(reapplyLedger(old)).toMatchObject({ applied: 1, damaged: 1 });
  });

  it("refuses to run without a ledger attached, rather than pass as if there were nothing to apply", () => {
    const bare = fresh();
    migrate(bare);
    expect(() => reapplyLedger(bare)).toThrow(/no tombstone ledger/);
    expect(readSetting(bare, LEDGER_SEQ_SETTING)).toBeUndefined();
  });
});

describe("lines the build could not apply wait and are applied when the kind returns (I04-R20, #121)", () => {
  const DEFERRED = "tombstone-ledger.deferred";
  const F = "f1";
  const fid = (externalId: string) => ({
    connectorInstanceId: F,
    namespace: "n",
    externalId,
  });
  /** A build that does not know the fork's kind, and one that does. */
  const without = () => createLedgerReapply(derivativeRegistry, { knownKind: () => false });
  const withKind = () => createLedgerReapply(derivativeRegistry, { knownKind: () => true });
  const listOf = (d: SqlDriver) => readSetting(d, DEFERRED);
  const tombstoneCount = (d: SqlDriver) => rows(d, "tombstones");

  /** Instance F of a kind only a fork has, a source of it deleted: the line is in the ledger, the backup has none of it. */
  function forkDeletion(externalId = "doc"): SqlDriver {
    const old = backup(db);
    registerConnectorInstance(db, F, "fork-kind");
    saveSourceRecord(db, F, { namespace: "n", externalId, title: "t", body: "본문" });
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: fid(externalId),
        reason: "user-deleted",
        lastRevision: null,
        at: AT,
      }),
    );
    return old;
  }
  /** The line of this sequence loses its kind, as a line of the first ledger format has none. */
  function dropKind(seq: number): void {
    const text = io.files.get(P) as string;
    io.files.set(
      P,
      text
        .split("\n")
        .map((piece) => {
          const r = piece.startsWith("{") ? (JSON.parse(piece) as Record<string, unknown>) : {};
          if (r.t !== "line" || r.seq !== seq) return piece;
          return JSON.stringify({ ...r, k: null });
        })
        .join("\n"),
    );
  }

  it("C5 b) keeps the position and the list while the kind is unknown, applies once it is known, and then does nothing", () => {
    const old = forkDeletion();
    restart(old);

    expect(without()(old)).toMatchObject({
      applied: 0,
      unrecoverable: 1,
      newlyDeferred: 1,
      canonicalSeq: 1,
    });
    expect(listOf(old)).toBe("[1]");
    expect(tombstoneCount(old)).toBe(0);

    expect(without()(old)).toMatchObject({
      applied: 0,
      unrecoverable: 1,
      newlyDeferred: 0,
      canonicalSeq: 1,
      skipped: 0,
    });
    expect(listOf(old)).toBe("[1]");

    expect(withKind()(old)).toMatchObject({
      applied: 1,
      unrecoverable: 0,
      newlyDeferred: 0,
      canonicalSeq: 1,
    });
    expect(listOf(old)).toBe("[]");
    expect(tombstoneCount(old)).toBe(1);
    expect(old.all("SELECT kind FROM connector_instances WHERE id = ?", [F])).toEqual([
      { kind: "fork-kind" },
    ]);
    const records = listInvalidations(old).length;

    expect(withKind()(old)).toMatchObject({ applied: 0, unrecoverable: 0, skipped: 1 });
    expect(tombstoneCount(old)).toBe(1);
    expect(listInvalidations(old)).toHaveLength(records);
  });

  it("C6 the applied position is never lowered by a deferred line, and the next deletion is numbered after it", () => {
    const mail = seedSecond(db);
    const old = forkDeletion();
    del(db); // line 2: chat, an instance the database knows
    restart(old);

    expect(without()(old)).toMatchObject({ applied: 1, unrecoverable: 1, canonicalSeq: 2 });
    expect(listOf(old)).toBe("[1]");
    expect(withKind()(old)).toMatchObject({ applied: 1, unrecoverable: 0, canonicalSeq: 2 });
    expect(readLedgerSeq(old)).toBe(2);
    expect(listOf(old)).toBe("[]");

    canonicalTransaction(old, (tx) =>
      applyTombstone(tx, {
        identity: mailIdentity,
        reason: "user-deleted",
        lastRevision: null,
        at: LATER,
      }),
    );
    expect(file().lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(readLedgerSeq(old)).toBe(3);
    expect(readTombstoneState(old, mail)).toBeDefined();
  });

  it("C7 a later line of the same source that is already reflected wins: the deferred line is dropped, not applied", () => {
    const old = backup(db);
    registerConnectorInstance(db, F, "fork-kind");
    const doc = saveSourceRecord(db, F, {
      namespace: "n",
      externalId: "doc",
      title: "t",
      body: "본문",
    });
    if (doc.status !== "created") throw new Error(doc.status);
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, {
        identity: fid("doc"),
        reason: "user-deleted",
        lastRevision: null,
        at: AT,
      }),
    );
    lift(db, doc.sourceId, LATER);
    expect(file().lines.map((l) => [l.seq, l.liftedAt !== null])).toEqual([
      [1, false],
      [2, true],
    ]);
    restart(old);
    expect(withKind()(old)).toMatchObject({ applied: 2, lifted: 1, canonicalSeq: 2 });
    // after the lift a new version arrives
    const again = saveSourceRecord(old, F, {
      namespace: "n",
      externalId: "doc",
      title: "t",
      body: "해제 뒤 본문",
    });
    expect(again.status).toBe("created");
    const versions = () =>
      old.all("SELECT count(*) AS n FROM source_versions WHERE source_id = ?", [doc.sourceId])[0]
        ?.n;
    const kept = versions();
    expect(kept).toBeGreaterThan(0);
    // the list still names line 1 (set by hand: the list as it stands between the two passes of a start where the deletion line ahead was deferred and the lift behind it registered the instance; the second pass would drop it)
    writeSetting(old, DEFERRED, "[1]");

    const report = withKind()(old);
    // the version received after the lift survives, and the tombstone stays lifted
    expect(versions()).toBe(kept);
    expect(readTombstoneState(old, doc.sourceId)).toMatchObject({ liftedAt: LATER });
    expect(report).toMatchObject({ applied: 0, unrecoverable: 0, skipped: 2 });
    expect(listOf(old)).toBe("[]");
  });

  it("C8 an old kind-less line ahead of a kinded line of the same instance is applied in the same start", () => {
    const old = backup(db);
    registerConnectorInstance(db, F, "fork-kind");
    for (const externalId of ["a", "b"]) {
      saveSourceRecord(db, F, { namespace: "n", externalId, title: externalId, body: "본문" });
      canonicalTransaction(db, (tx) =>
        applyTombstone(tx, {
          identity: fid(externalId),
          reason: "user-deleted",
          lastRevision: null,
          at: AT,
        }),
      );
    }
    dropKind(1);
    restart(old);

    expect(withKind()(old)).toMatchObject({ applied: 2, unrecoverable: 0, canonicalSeq: 2 });
    expect(listOf(old)).toBe("[]");
    expect(tombstoneCount(old)).toBe(2);
  });

  it("C9 without a list, the lines below the position whose instance is unknown are found again; a known instance's lines are not applied twice", () => {
    for (const row of [undefined, "not json"]) {
      const old = forkDeletion(`doc${n}`);
      del(db); // line 2: chat, known
      restart(old);
      without()(old);
      expect(listOf(old)).toBe("[1]");
      // what a build before this one left behind: the position past the line, no list (or one that cannot be read)
      const breakList = () =>
        row === undefined
          ? old.run("DELETE FROM settings WHERE key = ?", [DEFERRED])
          : writeSetting(old, DEFERRED, row);
      breakList();
      const records = listInvalidations(old).length;

      expect(without()(old)).toMatchObject({ applied: 0, unrecoverable: 1, newlyDeferred: 0 });
      expect(listOf(old)).toBe("[1]");

      breakList();
      expect(withKind()(old)).toMatchObject({ applied: 1, unrecoverable: 0, newlyDeferred: 0 });
      expect(listOf(old)).toBe("[]");
      expect(listInvalidations(old).length).toBeGreaterThan(records);
      // line 2 (known instance, at or below the position) is not carried again
      expect(withKind()(old)).toMatchObject({ applied: 0 });
      // the next case starts from a new ledger
      io = memoryLedgerIo();
      db = fresh();
      migrate(db);
      registerConnectorInstance(db, "c1", "test-fixtures");
      prepareCanonicalDb(db);
      attach(db);
      chat = seed(db);
    }
  });

  it("a deferred line whose number is not in the file any more is dropped and counted as skipped", () => {
    const old = forkDeletion();
    restart(old);
    without()(old);
    io.files.set(P, `${io.files.get(P)}${JSON.stringify({ t: "cancel", seqs: [1] })}\n`);
    expect(without()(old)).toMatchObject({ applied: 0, unrecoverable: 0, skipped: 1 });
    expect(listOf(old)).toBe("[]");
  });

  it("C10 a deferred line that fails when applied stops the start on it, stays in the list, and is applied by the next start", () => {
    const old = forkDeletion();
    restart(old);
    without()(old);
    const failing = createLedgerReapply(
      {
        ...derivativeRegistry,
        propagate: () => {
          throw new Error("kind failed");
        },
      },
      { knownKind: () => true },
    );

    let error: unknown;
    try {
      failing(old);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(LedgerReapplyError);
    expect((error as LedgerReapplyError).seq).toBe(1);
    expect(listOf(old)).toBe("[1]");
    expect(tombstoneCount(old)).toBe(0);
    expect(old.all("SELECT id FROM connector_instances WHERE id = ?", [F])).toEqual([]);
    expect(withKind()(old)).toMatchObject({ applied: 1 });
    expect(listOf(old)).toBe("[]");
    expect(tombstoneCount(old)).toBe(1);
  });
});
