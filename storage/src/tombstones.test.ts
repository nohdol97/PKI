// V02-R3/R12 tombstones and the change sequence (ADR 0013 decisions 4 and 6): a
// tombstone holds no content, and every source change raises the sequence exactly once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import { readTombstone, writeTombstone } from "./tombstones.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "b" });
});

afterEach(() => {
  db.close();
});

const tombstone = {
  sourceId: 1,
  version: 1,
  at: "2026-11-21T00:00:00Z",
  reason: "deleted",
} as const;

describe("tombstones", () => {
  it("records the source, its version, the time and the reason", () => {
    expect(writeTombstone(db, tombstone)).toBe("written");
    expect(readTombstone(db, 1)).toEqual(tombstone);
    expect(readTombstone(db, 404)).toBeUndefined();
  });

  it("keeps one per source and only moves it to a higher version", () => {
    writeTombstone(db, { ...tombstone, version: 3 });
    expect(writeTombstone(db, { ...tombstone, version: 3, reason: "access-revoked" })).toBe(
      "unchanged",
    );
    expect(writeTombstone(db, { ...tombstone, version: 2 })).toBe("unchanged");
    expect(readTombstone(db, 1)?.version).toBe(3);
    expect(writeTombstone(db, { ...tombstone, version: 4, reason: "access-revoked" })).toBe(
      "written",
    );
    expect(readTombstone(db, 1)).toMatchObject({ version: 4, reason: "access-revoked" });
  });

  it("refuses an unknown reason or source", () => {
    expect(() => writeTombstone(db, { ...tombstone, reason: "expired" as never })).toThrow(/CHECK/);
    expect(() => writeTombstone(db, { ...tombstone, sourceId: 404 })).toThrow(/FOREIGN KEY/);
  });
});

describe("change sequence", () => {
  it("rises once per new version and per tombstone written, never for unchanged input", () => {
    expect(readChangeSeq(db)).toBe(1);
    saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "b" });
    expect(readChangeSeq(db)).toBe(1);
    saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body: "b2" });
    expect(readChangeSeq(db)).toBe(2);
    writeTombstone(db, { ...tombstone, version: 2 });
    expect(readChangeSeq(db)).toBe(3);
    writeTombstone(db, { ...tombstone, version: 2 });
    expect(readChangeSeq(db)).toBe(3);
    writeTombstone(db, { ...tombstone, version: 5, reason: "access-revoked" });
    expect(readChangeSeq(db)).toBe(4);
  });

  it("is rolled back with the transaction that raised it", () => {
    expect(() =>
      db.transaction(() => {
        saveSourceRecord(db, "c1", { externalId: "e2", title: "t", body: "b" });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(readChangeSeq(db)).toBe(1);
  });
});
