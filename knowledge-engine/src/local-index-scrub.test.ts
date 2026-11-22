// I02B-T02 (R33, I02B-C23, I02B-C22 at storage level): the local file index is scrubbed by BOTH
// tombstone writers, the deletion entry (`applyTombstone`) and the start-up ledger reapply
// (`reapplyLedger`), with no call from either: the trigger on `tombstones` does it. After the
// tombstone the canonical database's bytes (journal included) hold no canary path.
import {
  attachLedger,
  canonicalTransaction,
  createLocalFileIndex,
  insertLocation,
  newLocalId,
  openLedger,
  parseLedger,
  prepareCanonicalDb,
  readKey,
  readLedgerSeq,
  registerConnectorInstance,
  saveSourceRecord,
  type EntryFields,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft, memoryLedgerIo, type MemoryLedgerIo } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reapplyLedger } from "./ledger-reapply.ts";
import { applyTombstone } from "./tombstone-entry.ts";

const AT = "2026-11-22T00:00:00.000Z";
const PATH_CANARY = "qzvpathcanary/wkhfilecanary.md";
const P = "/data/tombstone-ledger.jsonl";

let dir: string;
let io: MemoryLedgerIo;
let db: SqlDriver;
let loc: string;
let n = 0;
const opened: SqlDriver[] = [];

function openDb(file = `db${n++}.sqlite`): SqlDriver {
  const d = openBetterSqlite3(join(dir, file));
  opened.push(d);
  return d;
}
function attach(d: SqlDriver) {
  attachLedger(
    d,
    openLedger({
      path: P,
      key: readKey(d) as Uint8Array,
      canonicalSeq: readLedgerSeq(d),
      hasData: d.all("SELECT 1 FROM sources LIMIT 1").length > 0,
      io,
    }),
  );
}

/** The restored database starts: prepared with the ledger's key, the ledger attached. */
function restart(d: SqlDriver) {
  const key = parseLedger(io.files.get(P) as string).key;
  prepareCanonicalDb(d, key ? { ledgerKey: Uint8Array.from(Buffer.from(key, "hex")) } : {});
  attach(d);
}

const fields = (over: Partial<EntryFields> = {}): EntryFields => ({
  relativePath: PATH_CANARY,
  size: 3,
  mtimeNs: "1700000000000000000",
  contentHash: "cd".repeat(32),
  fileNo: "1:2",
  revision: 1,
  normalizerVersion: 1,
  state: "present",
  pendingDelete: 0,
  skipReason: null,
  skippedAt: null,
  skipLimits: null,
  ...over,
});

/** One location, one entry holding the canary path, and the source a sync stored for it. */
function seed(d: SqlDriver, withSource = true) {
  loc = newLocalId();
  insertLocation(d, {
    id: loc,
    type: "folder",
    displayPath: "/Users/x/docs",
    realPath: "/Users/x/docs",
    rootDev: "1",
    rootIno: "2",
    createdAt: AT,
  });
  const externalId = newLocalId();
  const index = createLocalFileIndex(d);
  expect(
    index.insertEntry({ externalId, locationId: loc, ...fields(), state: "present" }, [PATH_CANARY])
      .applied,
  ).toBe(true);
  if (withSource) {
    const saved = saveSourceRecord(d, "local-files", {
      namespace: loc,
      externalId,
      title: "t",
      body: "plain body",
    });
    if (saved.status !== "created") throw new Error(saved.status);
  }
  return {
    externalId,
    identity: { connectorInstanceId: "local-files", namespace: loc, externalId },
  };
}
const entryRow = (d: SqlDriver, externalId: string) =>
  d.all("SELECT * FROM local_file_entries WHERE external_id = ?", [externalId])[0];
/** What the files hold once every connection is closed (an open reader must not mask residue). */
function residue(): string[] {
  for (const d of opened.splice(0)) d.close();
  const left = canariesLeft(dir, [
    PATH_CANARY.split("/")[0] as string,
    PATH_CANARY.split("/")[1] as string,
  ]);
  db = openDb("pki.sqlite");
  return left;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-local-scrub-"));
  io = memoryLedgerIo();
  db = openDb("pki.sqlite");
  prepareCanonicalDb(db);
  registerConnectorInstance(db, "local-files", "local-files");
  attach(db);
});
afterEach(() => {
  for (const d of opened) d.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the deletion entry scrubs the index (writer 1)", () => {
  it("control: before any deletion the canary path is in the file", () => {
    seed(db);
    expect(residue()).toEqual(["qzvpathcanary", "wkhfilecanary.md"]);
  });

  it.each([["user-deleted"], ["source-deleted"], ["access-revoked"]] as const)(
    "after a %s tombstone the entry holds no plaintext and the bytes hold no canary",
    (reason) => {
      const { externalId, identity } = seed(db);
      canonicalTransaction(db, (tx) =>
        applyTombstone(tx, {
          identity,
          reason,
          lastRevision: reason === "source-deleted" ? 1 : null,
          at: AT,
        }),
      );
      const row = entryRow(db, externalId);
      expect(row).toMatchObject({
        relative_path: null,
        content_hash: null,
        size: null,
        mtime_ns: null,
        file_no: null,
      });
      expect(row?.state).toBe(reason === "source-deleted" ? "deleted" : "forgotten");
      expect(residue()).toEqual([]);
    },
  );

  it("a source never stored: the tombstone names it by hash and the entry is still scrubbed", () => {
    const { externalId, identity } = seed(db, false);
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, { identity, reason: "user-deleted", lastRevision: null, at: AT }),
    );
    expect(entryRow(db, externalId)).toMatchObject({ state: "forgotten", relative_path: null });
    expect(residue()).toEqual([]);
  });
});

describe("the ledger reapply scrubs the index (writer 2)", () => {
  it("a backup older than the deletion is scrubbed at the start, through the plain source row", () => {
    const { externalId, identity } = seed(db);
    const backupPath = join(dir, "backup.sqlite");
    db.exec(`VACUUM INTO '${backupPath}'`);
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, { identity, reason: "user-deleted", lastRevision: null, at: AT }),
    );
    const old = openDb("backup.sqlite");
    restart(old);
    expect(entryRow(old, externalId)).toMatchObject({ state: "present" });
    expect(entryRow(old, externalId)?.relative_path).toBe(PATH_CANARY);

    reapplyLedger(old);

    expect(entryRow(old, externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("a backup whose source row is gone is scrubbed through the hashed source row the ledger line makes", () => {
    const { externalId, identity } = seed(db, false);
    const backupPath = join(dir, "backup.sqlite");
    db.exec(`VACUUM INTO '${backupPath}'`);
    // the deletion happens after the backup: the source was never stored here, the entry was
    canonicalTransaction(db, (tx) =>
      applyTombstone(tx, { identity, reason: "user-deleted", lastRevision: null, at: AT }),
    );
    const old = openDb("backup.sqlite");
    restart(old);
    expect(entryRow(old, externalId)?.relative_path).toBe(PATH_CANARY);
    expect(old.all("SELECT 1 FROM sources")).toEqual([]);

    reapplyLedger(old);

    expect(old.all("SELECT identity_hashed FROM sources")).toEqual([{ identity_hashed: 1 }]);
    expect(entryRow(old, externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });
});
