// I02B-T04 (R10, R7; F1 of #19): the state changes of a location. A location that is read again is
// reconciled against the sources in the same transaction, so what the cursor passed over is announced.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import {
  createLocalFileIndex,
  insertLocation,
  newLocalId,
  readLocation,
  type EntryFields,
  type NewEntry,
} from "./local-files.ts";
import { closeLocation, relinkLocation, reopenLocation } from "./local-lifecycle.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const AT = "2026-11-23T00:00:00.000Z";
let db: SqlDriver;
let loc: string;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "local-files", "local-files");
  loc = newLocalId();
  insertLocation(db, {
    id: loc,
    type: "folder",
    displayPath: "/x",
    realPath: "/x",
    rootDev: "1",
    rootIno: "2",
    createdAt: AT,
  });
});
afterEach(() => db.close());

const present = (path: string): NewEntry => ({
  externalId: newLocalId(),
  locationId: loc,
  relativePath: path,
  size: 1,
  mtimeNs: "1700000000000000000",
  contentHash: "ab".repeat(32),
  fileNo: "1:9",
  revision: 1,
  normalizerVersion: 1,
  pendingDelete: 0,
  state: "present",
  skipReason: null,
  skippedAt: null,
  skipLimits: null,
});
const stored = (externalId: string, revision: number) =>
  saveSourceRecord(db, "local-files", {
    namespace: loc,
    externalId,
    title: "t",
    body: "b",
    revision,
  });

describe("reopenLocation", () => {
  it("gives a new sequence to an entry whose source is behind or missing, and keeps the announced one's", () => {
    const index = createLocalFileIndex(db);
    const announced = present("a.md");
    const behind = present("b.md");
    const never = present("c.md");
    const gone = present("d.md");
    for (const e of [announced, behind, never, gone]) index.insertEntry(e, []);
    stored(announced.externalId, 1);
    stored(behind.externalId, 1);
    stored(gone.externalId, 1);
    // b was changed to revision 2 and d was deleted after their sources were stored
    const b = index.entryOf(behind.externalId)!;
    index.updateEntry(b.externalId, b.seq, { ...(b as unknown as EntryFields), revision: 2 });
    const d = index.entryOf(gone.externalId)!;
    index.updateEntry(d.externalId, d.seq, {
      ...(d as unknown as EntryFields),
      relativePath: "d.md",
      revision: 2,
      state: "deleted",
    });
    expect(closeLocation(db, loc, "paused", null)).toBe(true);
    const before = Object.fromEntries(
      index.entriesOfLocation(loc).map((e) => [e.externalId, e.seq]),
    );
    const mark = index.lastSeq();

    reopenLocation(db, loc);

    expect(readLocation(db, loc)).toMatchObject({ state: "active", stateReason: null });
    const after = Object.fromEntries(
      index.entriesOfLocation(loc).map((e) => [e.externalId, e.seq]),
    );
    expect(after[announced.externalId]).toBe(before[announced.externalId]);
    for (const e of [behind, never, gone]) expect(after[e.externalId]).toBeGreaterThan(mark);
    expect(index.lastSeq()).toBe(mark + 3);
  });
});

describe("relinkLocation", () => {
  it("writes the new path and identity under the same id, lets go of held deletions and reads the location again", () => {
    const index = createLocalFileIndex(db);
    const held = present("a.md");
    index.insertEntry(held, []);
    const e = index.entryOf(held.externalId)!;
    index.updateEntry(e.externalId, e.seq, { ...(e as unknown as EntryFields), pendingDelete: 1 });
    closeLocation(db, loc, "unavailable", "root-changed");

    expect(
      relinkLocation(db, loc, { displayPath: "/y", realPath: "/y", rootDev: "3", rootIno: "4" }),
    ).toBe(true);

    expect(readLocation(db, loc)).toMatchObject({
      id: loc,
      displayPath: "/y",
      realPath: "/y",
      rootDev: "3",
      rootIno: "4",
      state: "active",
      stateReason: null,
    });
    expect(index.entryOf(held.externalId)).toMatchObject({ pendingDelete: 0 });
    expect(
      relinkLocation(db, newLocalId(), {
        displayPath: "/z",
        realPath: "/z",
        rootDev: "1",
        rootIno: "1",
      }),
    ).toBe(false);
  });
});
