// canonicalTransaction with a ledger attached (I04-R17, I04-T10): the queued lines are
// numbered and written right before the real COMMIT; a transaction that does not commit
// leaves no line (or a cancel record); nothing but the ledger's own failure stops writes.
import { createHash } from "node:crypto";
import { memoryLedgerIo, type MemoryLedgerIo } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { canonicalTransaction, readLedgerSeq, writeLedgerSeq } from "./canonical-transaction.ts";
import type { LedgerLineDraft } from "./derivatives.ts";
import { migrate } from "./migrations.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";
import {
  attachLedger,
  LedgerDegradedError,
  LedgerLineUnwritableError as LedgerUnwritableLine,
  openLedger,
  parseLedger,
  type TombstoneLedger,
} from "./tombstone-ledger.ts";

const hh = (s: string) => createHash("sha256").update(s).digest("hex");

const P = "/data/tombstone-ledger.jsonl";
const KEY = new Uint8Array(32).fill(7);
const draft = (hash: string): LedgerLineDraft => ({
  connectorInstanceId: "c1",
  connectorKind: "k1",
  identityHash: hh(hash),
  coversVersion: 1,
  lastRevision: null,
  reason: "user-deleted",
  at: "2026-11-22T00:00:00.000Z",
  liftedAt: null,
});

let dir: string;
let io: MemoryLedgerIo;
let ledger: TombstoneLedger;
let db: SqlDriver;

const file = () => parseLedger(io.files.get(P) as string);
const seqs = () => file().lines.map((l) => l.seq);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-ledger-tx-"));
  io = memoryLedgerIo();
  db = openBetterSqlite3(join(dir, "c.sqlite"));
  migrate(db);
  ledger = openLedger({ path: P, key: KEY, canonicalSeq: 0, hasData: false, io });
  attachLedger(db, ledger);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the ledger write", () => {
  it("numbers the queued lines in order and records the last number in the same transaction", () => {
    canonicalTransaction(db, (tx) => {
      tx.queueLedgerLine(draft("a"));
      tx.queueLedgerLine(draft("b"));
    });
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("c")));
    expect(file().lines.map((l) => [l.seq, l.identityHash])).toEqual([
      [1, hh("a")],
      [2, hh("b")],
      [3, hh("c")],
    ]);
    expect(readLedgerSeq(db)).toBe(3);
  });

  it("writes the file before the database commits: the lines are on disk while no other connection sees the write", () => {
    const other = openBetterSqlite3(join(dir, "c.sqlite"), { busyTimeoutMs: 0 });
    let seenInFile = -1;
    let seenByOther: number | undefined;
    io.fail = (op, _path, text) => {
      if (op === "append" && text?.includes('"line"')) {
        seenInFile = text.split("\n").filter(Boolean).length;
        // the writer holds its lock: a reader of the committed state sees no new setting
        seenByOther = other.all("SELECT count(*) AS n FROM settings WHERE key = 'w'")[0]
          ?.n as number;
      }
      return undefined;
    };
    canonicalTransaction(db, (tx) => {
      writeSetting(tx, "w", "1");
      tx.queueLedgerLine(draft("a"));
    });
    other.close();
    expect(seenInFile).toBe(1);
    expect(seenByOther).toBe(0);
    expect(readSetting(db, "w")).toBe("1");
  });

  it("writes and records nothing when no line was queued", () => {
    canonicalTransaction(db, (tx) => writeSetting(tx, "x", "1"));
    expect(io.log.filter((l) => l.startsWith("create")).length).toBe(1); // the header, at open
    expect(io.log.filter((l) => l.startsWith("append")).length).toBe(0); // nothing after it
    expect(readSetting(db, "tombstone-ledger.seq")).toBeUndefined();
  });

  it("numbers above the database's recorded number when the file is behind it (a ledger restored older)", () => {
    canonicalTransaction(db, (tx) => writeLedgerSeq(tx, 10));
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("a")));
    expect(seqs()).toEqual([11]);
    expect(readLedgerSeq(db)).toBe(11);
  });

  it("numbers above the file's last number when the database is behind it (a database restored older)", () => {
    ledger.append(
      ledger.reserve(5, 0),
      [1, 2, 3, 4, 5].map((n) => draft(`old${n}`)),
    );
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("a")));
    expect(seqs()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("a transaction that does not commit", () => {
  it("leaves no line, no number and no gap when fn throws", () => {
    expect(() =>
      canonicalTransaction(db, (tx) => {
        tx.queueLedgerLine(draft("lost"));
        throw new Error("refused record");
      }),
    ).toThrow("refused record");
    expect(file().lines).toEqual([]);
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("a")));
    expect(seqs()).toEqual([1]);
  });

  it("a nested call that throws and is caught takes its line with it; the outer's lines stay", () => {
    canonicalTransaction(db, (tx) => {
      tx.queueLedgerLine(draft("outer"));
      try {
        canonicalTransaction(tx, (inner) => {
          inner.queueLedgerLine(draft("inner"));
          throw new Error("inner failed");
        });
      } catch {
        // the outer carries on
      }
    });
    expect(file().lines.map((l) => l.identityHash)).toEqual([hh("outer")]);
  });

  it("a nested call that succeeds adds its line to the outer's, and an outer that fails drops both", () => {
    expect(() =>
      canonicalTransaction(db, (tx) => {
        tx.queueLedgerLine(draft("outer"));
        canonicalTransaction(db, (inner) => inner.queueLedgerLine(draft("inner")));
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");
    expect(file().lines).toEqual([]);
    canonicalTransaction(db, (tx) => {
      tx.queueLedgerLine(draft("a"));
      canonicalTransaction(db, (inner) => inner.queueLedgerLine(draft("b")));
    });
    expect(file().lines.map((l) => l.identityHash)).toEqual([hh("a"), hh("b")]);
  });

  it("COMMIT fails: the transaction is undone, a cancel record names the exact numbers, and the next line gets the number after them", () => {
    const failing: SqlDriver = {
      ...db,
      transaction: (fn, options) =>
        db.transaction(fn, {
          ...options,
          beforeCommit: () => {
            options?.beforeCommit?.();
            throw new Error("COMMIT failed");
          },
        }),
    };
    attachLedger(failing, ledger);
    expect(() =>
      canonicalTransaction(failing, (tx) => {
        writeSetting(tx, "w", "1");
        tx.queueLedgerLine(draft("a"));
        tx.queueLedgerLine(draft("b"));
      }),
    ).toThrow("COMMIT failed");
    expect(readSetting(db, "w")).toBeUndefined();
    expect(readLedgerSeq(db)).toBe(0);
    const text = io.files.get(P) as string;
    expect(text).toContain('{"t":"cancel","seqs":[1,2]}');
    expect(file().lines).toEqual([]);
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("c")));
    expect(seqs()).toEqual([3]);
    expect(file().maxSeq).toBe(3);
  });

  it("the ledger write itself fails: undone, a cancel record for the numbers taken, none reused", () => {
    let once = true;
    io.fail = (op, _p, text) => {
      if (op === "append" && text?.includes('"line"') && once) {
        once = false;
        return new Error("disk full");
      }
      return undefined;
    };
    expect(() =>
      canonicalTransaction(db, (tx) => {
        writeSetting(tx, "w", "1");
        tx.queueLedgerLine(draft("a"));
      }),
    ).toThrow("disk full");
    expect(readSetting(db, "w")).toBeUndefined();
    expect(io.files.get(P)).toContain('{"t":"cancel","seqs":[1]}');
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("b")));
    expect(seqs()).toEqual([2]);
  });

  it("refuses to open inside a raw driver transaction: the outer's rollback would leave a line the database never had", () => {
    expect(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('raw', '1')");
        canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("a")));
      }),
    ).toThrow(/outermost/);
    expect(file().lines).toEqual([]);
    expect(readSetting(db, "raw")).toBeUndefined();
  });
});

describe("the cancel record cannot be written", () => {
  beforeEach(() => {
    io.fail = (op, _p, text) =>
      op === "append" && text?.includes('"cancel"') ? new Error("disk gone") : undefined;
  });

  it("locks the ledger: every later canonical write is refused with ledger-degraded until the reconcile ends", () => {
    const failing: SqlDriver = {
      ...db,
      transaction: (fn, options) =>
        db.transaction(fn, {
          ...options,
          beforeCommit: () => {
            options?.beforeCommit?.();
            throw new Error("COMMIT failed");
          },
        }),
    };
    attachLedger(failing, ledger);
    expect(() => canonicalTransaction(failing, (tx) => tx.queueLedgerLine(draft("a")))).toThrow(
      "COMMIT failed",
    );
    // the line is in the file and was not cancelled: the next start applies it
    expect(file().lines.map((l) => l.identityHash)).toEqual([hh("a")]);
    expect(ledger.isLocked()).toBe(true);
    let ran = false;
    let error: unknown;
    try {
      canonicalTransaction(db, () => void (ran = true));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LedgerDegradedError);
    expect((error as LedgerDegradedError).code).toBe("ledger-degraded");
    expect(ran).toBe(false);
    ledger.reconciling(() => canonicalTransaction(db, (tx) => writeSetting(tx, "k", "v")));
    canonicalTransaction(db, (tx) => writeSetting(tx, "k", "w"));
    expect(readSetting(db, "k")).toBe("w");
  });
});

describe("COMMIT meets a busy file", () => {
  it("is tried again with the transaction open: it commits, and no cancel record is written", () => {
    const busy = join(dir, "busy.sqlite");
    const setup = openBetterSqlite3(busy);
    migrate(setup);
    setup.close();
    // an unfinished read of another connection holds the shared lock until its iterator ends
    const raw = new Database(busy);
    const iterator = raw.prepare("SELECT * FROM sqlite_master").iterate();
    iterator.next();
    const waits: number[] = [];
    const writer = openBetterSqlite3(busy, {
      busyTimeoutMs: 0,
      sleep: (ms) => {
        waits.push(ms);
        if (waits.length === 2) iterator.return?.();
      },
    });
    attachLedger(writer, ledger);
    canonicalTransaction(writer, (tx) => {
      writeSetting(tx, "w", "1");
      tx.queueLedgerLine(draft("a"));
    });
    expect(waits).toEqual([100, 400]);
    expect(readSetting(writer, "w")).toBe("1");
    expect(seqs()).toEqual([1]);
    expect(io.files.get(P)).not.toContain("cancel");
    raw.close();
    writer.close();
  });

  it("fails for good: the transaction is undone and a cancel record is written", () => {
    const busy = join(dir, "busy2.sqlite");
    const setup = openBetterSqlite3(busy);
    migrate(setup);
    setup.close();
    const raw = new Database(busy);
    const iterator = raw.prepare("SELECT * FROM sqlite_master").iterate();
    iterator.next();
    const waits: number[] = [];
    const writer = openBetterSqlite3(busy, {
      busyTimeoutMs: 0,
      commitRetryDelaysMs: [1, 2, 3],
      sleep: (ms) => void waits.push(ms),
    });
    attachLedger(writer, ledger);
    expect(() =>
      canonicalTransaction(writer, (tx) => {
        writeSetting(tx, "w", "1");
        tx.queueLedgerLine(draft("a"));
      }),
    ).toThrow(/locked|busy/i);
    expect(waits).toEqual([1, 2, 3]);
    expect(io.files.get(P)).toContain('{"t":"cancel","seqs":[1]}');
    expect(file().lines).toEqual([]);
    iterator.return?.();
    expect(readSetting(writer, "w")).toBeUndefined();
    raw.close();
    writer.close();
  });
});

describe("a line the reader would reject refuses the deletion (fail closed)", () => {
  it.each([
    ["a kind outside the rules", { connectorKind: "corp_mail" }],
    ["an empty instance id", { connectorInstanceId: "" }],
    ["an uppercase hash", { identityHash: hh("a").toUpperCase() }],
  ])("%s: the transaction is undone, nothing is written, no number is taken", (_name, over) => {
    expect(() =>
      canonicalTransaction(db, (tx) => {
        writeSetting(tx, "w", "1");
        tx.queueLedgerLine({ ...draft("a"), ...over });
      }),
    ).toThrow(LedgerUnwritableLine);
    expect(readSetting(db, "w")).toBeUndefined();
    expect(file().lines).toEqual([]);
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(draft("b")));
    expect(seqs()).toEqual([1]);
  });
});
