// I02B-T02b review round 1 (storage half): the scrub trigger and the port must not cost a scan or a
// per-path hash; the counter cannot be reset by REPLACE; plans, CHECKs, parity breadth.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  createLocalFileIndex,
  insertLocation,
  newLocalId,
  setLocationState,
  type EntryFields,
  type LocalFileIndex,
  type NewEntry,
} from "./local-files.ts";
import { createMemoryLocalFileIndex } from "./local-files.test-support.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { recordTombstone } from "./tombstones.ts";

const AT = "2026-11-22T00:00:00.000Z";
let db: SqlDriver;
let loc: string;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "local-files", "local-files");
  registerConnectorInstance(db, "mail-1", "mail");
  loc = newLocation();
});
afterEach(() => db.close());

function newLocation(): string {
  const id = newLocalId();
  insertLocation(db, {
    id,
    type: "folder",
    displayPath: "/a",
    realPath: "/a",
    rootDev: "1",
    rootIno: "2",
    createdAt: AT,
  });
  return id;
}
const fields = (over: Partial<EntryFields> = {}): EntryFields => ({
  relativePath: "a.md",
  size: 1,
  mtimeNs: "1700000000000000000",
  contentHash: "ab".repeat(32),
  fileNo: "99",
  revision: 1,
  normalizerVersion: 1,
  state: "present",
  pendingDelete: 0,
  skipReason: null,
  skippedAt: null,
  skipLimits: null,
  ...over,
});
const newEntry = (over: Partial<NewEntry> = {}): NewEntry => ({
  externalId: newLocalId(),
  locationId: loc,
  ...fields(),
  state: "present",
  ...over,
});

/** The statements of a trigger body (UPDATE ...), with the NEW references bound to constants. */
function triggerStatements(name: string): string[] {
  const sql = String(
    db.all("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", [name])[0]?.sql,
  );
  const body = sql.slice(sql.indexOf("BEGIN") + 5, sql.lastIndexOf("END"));
  return body
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("UPDATE"))
    .map((s) => s.replaceAll("new.source_id", "1").replaceAll("new.reason", "'user-deleted'"));
}
const plan = (sql: string, params: (string | number)[] = []) =>
  db.all(`EXPLAIN QUERY PLAN ${sql}`, params).map((r) => String(r.detail));

describe("the scrub trigger costs no scan of the index (S-F1)", () => {
  for (const name of ["tombstones_local_index_insert", "tombstones_local_index_update"]) {
    it(`${name}: no statement scans local_file_entries, and a source of another connector is left before any lookup`, () => {
      const statements = triggerStatements(name);
      expect(statements).toHaveLength(2);
      for (const statement of statements) {
        const details = plan(statement);
        expect(
          details.filter((d) => /SCAN (e|local_file_entries)\b/.test(d)),
          statement,
        ).toEqual([]);
      }
      const sql = String(db.all("SELECT sql FROM sqlite_master WHERE name = ?", [name])[0]?.sql);
      // the instance is decided once, in the WHEN clause, so other connectors' tombstones cost ~nothing
      const when = sql.slice(sql.indexOf("WHEN"), sql.indexOf("BEGIN"));
      expect(when).toContain("connector_instance_id = 'local-files'");
    });
  }

  it("a tombstone of another connector does not touch the index or the counter", () => {
    const e = newEntry();
    createLocalFileIndex(db).insertEntry(e, []);
    const saved = saveSourceRecord(db, "mail-1", {
      namespace: loc,
      externalId: e.externalId,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    recordTombstone(db, saved.sourceId, { reason: "user-deleted", lastRevision: null, at: AT });
    expect(db.all("SELECT state FROM local_file_entries")).toEqual([{ state: "present" }]);
    expect(db.all("SELECT value FROM local_index_seq")).toEqual([{ value: 1 }]);
  });

  it("a local-files source with the same file id in ANOTHER location does not scrub the entry (the plain lookup is by location and file id)", () => {
    const e = newEntry();
    createLocalFileIndex(db).insertEntry(e, []);
    const other = newLocation();
    const saved = saveSourceRecord(db, "local-files", {
      namespace: other,
      externalId: e.externalId,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    recordTombstone(db, saved.sourceId, { reason: "user-deleted", lastRevision: null, at: AT });
    expect(db.all("SELECT state FROM local_file_entries")).toEqual([{ state: "present" }]);
  });

  it("a tombstone written before its entry existed still scrubs it when the tombstone row is updated without a lift (UPDATE trigger)", () => {
    const externalId = newLocalId();
    const saved = saveSourceRecord(db, "local-files", {
      namespace: loc,
      externalId,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, 1, ?, 'user-deleted')",
      [saved.sourceId, AT],
    );
    createLocalFileIndex(db).insertEntry(newEntry({ externalId }), []);
    expect(db.all("SELECT state FROM local_file_entries")).toEqual([{ state: "present" }]);
    db.run("UPDATE tombstones SET last_revision = 3 WHERE source_id = ?", [saved.sourceId]);
    expect(db.all("SELECT state FROM local_file_entries")).toEqual([{ state: "forgotten" }]);
  });
});

describe("plans of the port's queries (S-F5)", () => {
  it("per-location access is served by an index", () => {
    const details = plan("SELECT * FROM local_file_entries WHERE location_id = ? ORDER BY seq", [
      loc,
    ]);
    expect(details.filter((d) => /SCAN local_file_entries/.test(d))).toEqual([]);
    expect(details.join(" ")).toContain("local_file_entries_location");
  });
});

/** A driver that counts reads of the identity key: one per keyed hash computed. */
function countingDb(inner: SqlDriver): { db: SqlDriver; keyReads: () => number } {
  let reads = 0;
  const wrapped: SqlDriver = {
    ...inner,
    exec: (s) => inner.exec(s),
    run: (s, p) => inner.run(s, p),
    all: (s, p) => {
      if (s.includes("FROM identity_key")) reads++;
      return inner.all(s, p);
    },
    transaction: (fn, o) => inner.transaction(fn, o),
    close: () => inner.close(),
  };
  return { db: wrapped, keyReads: () => reads };
}

describe("insertEntry does not hash the seen paths unless a forgotten entry could match (S-F2)", () => {
  it("with no forgotten entry in the location the number of keyed hashes does not grow with the seen list", () => {
    const small = countingDb(db);
    const a = createLocalFileIndex(small.db);
    a.insertEntry(newEntry({ relativePath: "x1.md" }), ["x1.md"]);
    const baseline = small.keyReads();
    const seen = Array.from({ length: 500 }, (_, i) => `same/${i}.md`);
    const before = small.keyReads();
    a.insertEntry(newEntry({ relativePath: "x2.md" }), seen);
    // the insert's own three (identity, path, content), whatever the seen list holds
    expect(small.keyReads() - before).toBeLessThanOrEqual(3);
    expect(baseline).toBeLessThanOrEqual(3);
  });

  it("more seen paths than SQLite has variables do not throw, with a forgotten entry that matches the content", () => {
    const index = createLocalFileIndex(db);
    const gone = newEntry({ relativePath: "gone.md", contentHash: "cd".repeat(32) });
    index.insertEntry(gone, []);
    const saved = saveSourceRecord(db, "local-files", {
      namespace: loc,
      externalId: gone.externalId,
      title: "t",
      body: "b",
    });
    if (saved.status !== "created") throw new Error(saved.status);
    recordTombstone(db, saved.sourceId, { reason: "user-deleted", lastRevision: null, at: AT });
    const seen = Array.from({ length: 40_000 }, (_, i) => `many/${i}.md`);
    const moved = newEntry({ relativePath: "moved.md", contentHash: "cd".repeat(32) });
    expect(index.insertEntry(moved, [...seen, "moved.md"])).toEqual({
      applied: false,
      reason: "forgotten",
    });
    // the forgotten file still in place (its path in the seen list): the copy is admitted
    const copy = newEntry({ relativePath: "copy.md", contentHash: "cd".repeat(32) });
    expect(index.insertEntry(copy, [...seen, "gone.md", "copy.md"]).applied).toBe(true);
  });
});

describe("the counter cannot be reset (S-F4)", () => {
  it("INSERT OR REPLACE, ON CONFLICT DO UPDATE, DELETE, a lower UPDATE and a second row all fail", () => {
    createLocalFileIndex(db).insertEntry(newEntry(), []);
    for (const sql of [
      "INSERT OR REPLACE INTO local_index_seq (id, value) VALUES (1, 0)",
      "REPLACE INTO local_index_seq (id, value) VALUES (1, 0)",
      "INSERT INTO local_index_seq (id, value) VALUES (1, 0) ON CONFLICT (id) DO UPDATE SET value = 0",
      "DELETE FROM local_index_seq",
      "UPDATE local_index_seq SET value = 0",
      "INSERT INTO local_index_seq (id, value) VALUES (2, 9)",
    ]) {
      expect(() => db.run(sql), sql).toThrow();
    }
    expect(db.all("SELECT id, value FROM local_index_seq")).toEqual([{ id: 1, value: 1 }]);
  });
});

describe("decimal text columns hold digits only (S-W4)", () => {
  it("refuses a non-numeric root identity, mtime and file number; accepts ino or dev:ino", () => {
    const index = createLocalFileIndex(db);
    for (const bad of ["abc", "", "1.5", "-1", "1:2:3", ":1", "1:"]) {
      expect(
        () => index.insertEntry(newEntry({ fileNo: bad, relativePath: "f.md" }), []),
        bad,
      ).toThrow();
    }
    expect(() =>
      index.insertEntry(newEntry({ mtimeNs: "12x", relativePath: "m.md" }), []),
    ).toThrow();
    for (const [dev, ino] of [
      ["x", "1"],
      ["1", ""],
      ["1", "1e3"],
    ] as const) {
      expect(() =>
        insertLocation(db, {
          id: newLocalId(),
          type: "folder",
          displayPath: "/b",
          realPath: "/b",
          rootDev: dev,
          rootIno: ino,
          createdAt: AT,
        }),
      ).toThrow();
    }
    expect(index.insertEntry(newEntry({ fileNo: "99", relativePath: "g1.md" }), []).applied).toBe(
      true,
    );
    expect(
      index.insertEntry(newEntry({ fileNo: "16777230:99", relativePath: "g2.md" }), []).applied,
    ).toBe(true);
  });
});

describe("parity over a scripted sequence, read methods included (S-F6)", () => {
  type Hooked = { index: LocalFileIndex; scrub: (id: string) => void; close: (l: string) => void };
  const canonical = (): Hooked => ({
    index: createLocalFileIndex(db),
    scrub: (id) => {
      const saved = saveSourceRecord(db, "local-files", {
        namespace: loc,
        externalId: id,
        title: "t",
        body: "b",
      });
      if (saved.status !== "created") throw new Error(saved.status);
      recordTombstone(db, saved.sourceId, { reason: "user-deleted", lastRevision: null, at: AT });
    },
    close: (l) => void setLocationState(db, l, "paused", null),
  });
  const memory = (): Hooked => {
    const m = createMemoryLocalFileIndex([{ id: loc, state: "active" }]);
    return {
      index: m,
      scrub: (id) => m.scrub(id, "user-deleted"),
      close: (l) => m.setLocationState(l, "paused"),
    };
  };

  function script({ index, scrub, close }: Hooked) {
    const out: unknown[] = [];
    const ids = ["A", "B", "C", "D"].map((c) => c.repeat(22));
    const e = (i: number, p: string, h: string) =>
      newEntry({ externalId: ids[i] as string, relativePath: p, contentHash: h });
    out.push(index.insertEntry(e(0, "one.md", "11".repeat(32)), ["one.md"]));
    out.push(index.insertEntry(e(1, "two.md", "22".repeat(32)), ["two.md"]));
    // a move (rename): the same entry, a new path, a new sequence number
    const a = index.entryOf(ids[0] as string);
    out.push(
      index.updateEntry(
        ids[0] as string,
        a?.seq as number,
        fields({ relativePath: "moved/one.md", contentHash: "11".repeat(32), revision: 2 }),
      ),
    );
    // path-taken
    const b = index.entryOf(ids[1] as string);
    out.push(
      index.updateEntry(
        ids[1] as string,
        b?.seq as number,
        fields({ relativePath: "moved/one.md", contentHash: "22".repeat(32), revision: 2 }),
      ),
    );
    out.push(index.insertEntry(e(2, "moved/one.md", "33".repeat(32)), []));
    // forgotten, then the reads
    scrub(ids[1] as string);
    out.push(
      index.findByPath(loc, "two.md"),
      index.findByPath(loc, "moved/one.md"),
      index.findByPath(loc, "none"),
    );
    out.push(index.findForgottenByContent(loc, "22".repeat(32)));
    out.push(
      index.entriesOfLocation(loc),
      index.entriesAfter(0, 10),
      index.entriesAfter(2, 10),
      index.lastSeq(),
    );
    // location-closed
    close(loc);
    const c = index.entryOf(ids[0] as string);
    out.push(index.updateEntry(ids[0] as string, c?.seq as number, fields({ revision: 3 })));
    out.push(index.insertEntry(e(3, "late.md", "44".repeat(32)), []));
    return out;
  }

  it("the memory implementation and the canonical one give the same answers at every step", () => {
    const real = script(canonical());
    const mem = script(memory());
    expect(mem).toEqual(real);
    expect(JSON.stringify(real)).toContain("path-taken");
    expect(JSON.stringify(real)).toContain("location-closed");
  });
});
