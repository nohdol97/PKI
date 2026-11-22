// canonicalTransaction (I04-R17, I04-T05): the one transaction every write that may
// reach a tombstone entry opens. It commits when fn returns and rolls back when it
// throws; a call inside one joins it. The ledger it will write arrives with I04-T10.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { canonicalTransaction, queuedLedgerLines } from "./canonical-transaction.ts";
import type { CanonicalTx, LedgerLineDraft } from "./derivatives.ts";
import { migrate } from "./migrations.ts";
import { readSetting, writeSetting } from "./settings.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const line: LedgerLineDraft = {
  identityHash: "h",
  coversVersion: 1,
  lastRevision: null,
  reason: "user-deleted",
  lifted: false,
  at: "2026-11-22T00:00:00.000Z",
};

describe("canonicalTransaction", () => {
  it("commits what fn wrote through the transaction's driver and returns fn's value", () => {
    const result = canonicalTransaction(db, (tx) => {
      tx.exec("INSERT INTO settings (key, value) VALUES ('e', 'exec')");
      tx.run("INSERT INTO settings (key, value) VALUES (?, ?)", ["r", "run"]);
      return tx.all("SELECT count(*) AS n FROM settings")[0]?.n;
    });
    expect(result).toBe(2);
    expect(readSetting(db, "e")).toBe("exec");
    expect(readSetting(db, "r")).toBe("run");
  });

  it("rolls back everything fn wrote when fn throws, and rethrows", () => {
    expect(() =>
      canonicalTransaction(db, (tx) => {
        writeSetting(tx, "k", "v");
        tx.queueLedgerLine(line);
        throw new Error("refused record");
      }),
    ).toThrow("refused record");
    expect(readSetting(db, "k")).toBeUndefined();
    // the next one starts clean and commits
    canonicalTransaction(db, (tx) => writeSetting(tx, "k", "second"));
    expect(readSetting(db, "k")).toBe("second");
  });

  it("joins the open transaction when called inside one, by the driver or by the tx", () => {
    const seen: CanonicalTx[] = [];
    expect(() =>
      canonicalTransaction(db, (outer) => {
        seen.push(outer);
        canonicalTransaction(db, (inner) => {
          seen.push(inner);
          writeSetting(inner, "by-driver", "v");
        });
        canonicalTransaction(outer, (inner) => {
          seen.push(inner);
          writeSetting(inner, "by-tx", "v");
        });
        // the inner calls returned without committing: the outer rollback takes them
        throw new Error("outer fails");
      }),
    ).toThrow("outer fails");
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
    expect(readSetting(db, "by-driver")).toBeUndefined();
    expect(readSetting(db, "by-tx")).toBeUndefined();
  });

  it("undoes a joined call that throws, rows and queued lines, when the outer one catches it", () => {
    canonicalTransaction(db, (outer) => {
      writeSetting(outer, "before", "v");
      outer.queueLedgerLine({ ...line, identityHash: "outer" });
      expect(() =>
        canonicalTransaction(outer, (inner) => {
          // a tombstone written, then its propagation failing (a refused record of a page)
          writeSetting(inner, "half", "v");
          inner.queueLedgerLine({ ...line, identityHash: "inner" });
          throw new Error("inner fails");
        }),
      ).toThrow("inner fails");
      // a joined call that returns keeps its rows and lines
      canonicalTransaction(db, (inner) => {
        writeSetting(inner, "after", "v");
        inner.queueLedgerLine({ ...line, identityHash: "kept" });
      });
      expect(queuedLedgerLines(outer).map((l) => l.identityHash)).toEqual(["outer", "kept"]);
    });
    expect(readSetting(db, "before")).toBe("v");
    expect(readSetting(db, "half")).toBeUndefined();
    expect(readSetting(db, "after")).toBe("v");
  });

  it("takes the write lock as it begins: another connection cannot write before its first statement", () => {
    const dir = mkdtempSync(join(tmpdir(), "pki-canonical-"));
    const first = openBetterSqlite3(join(dir, "canonical.sqlite"));
    const second = openBetterSqlite3(join(dir, "canonical.sqlite"));
    try {
      migrate(first);
      second.exec("PRAGMA busy_timeout = 0");
      canonicalTransaction(first, (tx) => {
        // before its first statement: the lock is the transaction's from BEGIN, so the
        // entries' read, judgement and write (recordTombstone) see one state
        expect(() => writeSetting(second, "k", "other")).toThrow(/locked/);
        expect(readSetting(tx, "k")).toBeUndefined();
        writeSetting(tx, "k", "mine");
      });
      expect(readSetting(second, "k")).toBe("mine");
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gives each top-level transaction its own tx, also after one that failed inside a join", () => {
    let first: CanonicalTx | undefined;
    expect(() =>
      canonicalTransaction(db, (tx) => {
        first = tx;
        canonicalTransaction(tx, () => {
          throw new Error("inner fails");
        });
      }),
    ).toThrow("inner fails");
    const second = canonicalTransaction(db, (tx) => {
      writeSetting(tx, "k", "v");
      return tx;
    });
    expect(second).not.toBe(first);
    expect(readSetting(db, "k")).toBe("v");
    // a tx kept past its transaction joins nothing: it opens a real one, which rolls back
    expect(() =>
      canonicalTransaction(second, (tx) => {
        writeSetting(tx, "stale", "v");
        throw new Error("fails");
      }),
    ).toThrow("fails");
    expect(readSetting(db, "stale")).toBeUndefined();
  });

  it("queues a ledger line without writing anything (the ledger arrives with I04-T10)", () => {
    const rows = () =>
      db.all("SELECT (SELECT count(*) FROM settings) AS s, (SELECT count(*) FROM tombstones) AS t");
    const before = rows();
    canonicalTransaction(db, (tx) => tx.queueLedgerLine(line));
    expect(rows()).toEqual(before);
  });
});
