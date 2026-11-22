// I04-R17 "바쁨": a COMMIT that meets SQLITE_BUSY (a reader of another connection still
// holds a shared lock; rollback-journal mode) is tried again with the transaction open,
// at the configured delays, and fails for good after the last one. A real second
// connection makes the file busy; the waits are replaced by a test double that also
// releases the reader, so no test sleeps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";

let dir: string;
let path: string;
let reader: InstanceType<typeof Database>;
let iterator: Iterator<unknown> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pki-commit-retry-"));
  path = join(dir, "t.sqlite");
  const setup = openBetterSqlite3(path);
  setup.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v)");
  setup.run("INSERT INTO t (v) VALUES ('seed')");
  setup.close();
  reader = new Database(path);
  // an unfinished read holds the shared lock for as long as the iterator is open
  iterator = reader.prepare("SELECT * FROM t").iterate();
  iterator.next();
});
afterEach(() => {
  iterator?.return?.();
  reader.close();
  rmSync(dir, { recursive: true, force: true });
});

const release = () => void iterator?.return?.();

describe("commit retry on SQLITE_BUSY", () => {
  it("commits after the reader lets go during the waits, retrying with the transaction open", () => {
    const waits: number[] = [];
    const db = openBetterSqlite3(path, {
      busyTimeoutMs: 0,
      commitRetryDelaysMs: [100, 400, 1600],
      sleep: (ms) => {
        waits.push(ms);
        if (waits.length === 2) release();
      },
    });
    db.transaction(() => void db.run("INSERT INTO t (v) VALUES ('mine')"), {
      beforeCommit: () => undefined,
    });
    expect(waits).toEqual([100, 400]);
    expect(db.all("SELECT v FROM t ORDER BY id")).toEqual([{ v: "seed" }, { v: "mine" }]);
    db.close();
  });

  it("gives up after the last delay: rolls back and throws the busy error", () => {
    const waits: number[] = [];
    const db = openBetterSqlite3(path, {
      busyTimeoutMs: 0,
      commitRetryDelaysMs: [1, 2, 3],
      sleep: (ms) => void waits.push(ms),
    });
    expect(() =>
      db.transaction(() => void db.run("INSERT INTO t (v) VALUES ('mine')"), {
        beforeCommit: () => undefined,
      }),
    ).toThrow(/locked|busy/i);
    expect(waits).toEqual([1, 2, 3]);
    release();
    expect(db.all("SELECT v FROM t")).toEqual([{ v: "seed" }]);
    // the connection is usable again: no transaction was left open
    db.transaction(() => void db.run("INSERT INTO t (v) VALUES ('next')"));
    expect(db.all("SELECT count(*) AS n FROM t")).toEqual([{ n: 2 }]);
    db.close();
  });

  it("does not retry an error that is not SQLITE_BUSY", () => {
    release();
    const waits: number[] = [];
    const db = openBetterSqlite3(path, { sleep: (ms) => void waits.push(ms) });
    db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE c (p_id INTEGER REFERENCES p(id) DEFERRABLE INITIALLY DEFERRED)");
    expect(() =>
      db.transaction(() => void db.run("INSERT INTO c (p_id) VALUES (99)"), {
        beforeCommit: () => undefined,
      }),
    ).toThrow(/FOREIGN KEY/i);
    expect(waits).toEqual([]);
    db.close();
  });
});
