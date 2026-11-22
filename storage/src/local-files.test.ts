// I02B-T02 (R33, D11; I02B-C23, C22 at storage level): the local file index, its tombstone trigger,
// the one-row counter and the compare-and-set writes. The in-memory implementation answers the same
// way as the canonical one (parity), including for a write that no longer applies.
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
const SECRET_PATH = "project-zq/secret-plan.md";
const SECRET_HASH = "ab".repeat(32);

let db: SqlDriver;
let loc: string;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "local-files", "local-files");
  registerConnectorInstance(db, "jsonl-file-x", "jsonl-import");
  loc = newLocation();
});
afterEach(() => db.close());

function newLocation(type: "folder" | "file" = "folder"): string {
  const id = newLocalId();
  insertLocation(db, {
    id,
    type,
    displayPath: "/Users/x/docs",
    realPath: "/Users/x/docs",
    rootDev: "16777230",
    rootIno: "1234",
    createdAt: AT,
  });
  return id;
}

const fields = (over: Partial<EntryFields> = {}): EntryFields => ({
  relativePath: SECRET_PATH,
  size: 10,
  mtimeNs: "1700000000000000000",
  contentHash: SECRET_HASH,
  fileNo: "16777230:99",
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

/** The source row a sync would store for the entry, so a tombstone can name it. */
function storeSource(externalId: string, locationId = loc, instance = "local-files"): number {
  const saved = saveSourceRecord(db, instance, {
    namespace: locationId,
    externalId,
    title: "t",
    body: "b",
  });
  if (saved.status !== "created") throw new Error(saved.status);
  return saved.sourceId;
}
const tombstone = (
  sourceId: number,
  reason: "user-deleted" | "source-deleted" | "access-revoked",
) => recordTombstone(db, sourceId, { reason, lastRevision: null, at: AT });
const rawEntry = (externalId: string) =>
  db.all("SELECT * FROM local_file_entries WHERE external_id = ?", [externalId])[0];
const counter = () => db.all("SELECT value FROM local_index_seq")[0]?.value as number;

describe("schema", () => {
  it("has the three tables and the counter starts at 0 in one row", () => {
    const names = db
      .all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local\\_%' ESCAPE '\\'",
      )
      .map((r) => r.name);
    expect(names.sort()).toEqual(["local_file_entries", "local_index_seq", "local_locations"]);
    expect(db.all("SELECT id, value FROM local_index_seq")).toEqual([{ id: 1, value: 0 }]);
  });

  it("refuses an id that is not 22 base64url characters", () => {
    expect(() =>
      insertLocation(db, {
        id: "short",
        type: "folder",
        displayPath: "/a",
        realPath: "/a",
        rootDev: "1",
        rootIno: "2",
        createdAt: AT,
      }),
    ).toThrow();
    expect(newLocalId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("refuses plaintext columns on a deleted or forgotten row (a CHECK, not only the trigger)", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    expect(() =>
      db.run("UPDATE local_file_entries SET state = 'deleted' WHERE external_id = ?", [
        e.externalId,
      ]),
    ).toThrow();
    expect(() =>
      db.run("UPDATE local_file_entries SET state = 'forgotten' WHERE external_id = ?", [
        e.externalId,
      ]),
    ).toThrow();
  });
});

describe("counter (I02B-R33: one source of sequence numbers)", () => {
  it("every write takes the next number from the counter, and a row's deletion never lowers it", () => {
    const index = createLocalFileIndex(db);
    const a = newEntry({ relativePath: "a.md" });
    const b = newEntry({ relativePath: "b.md" });
    index.insertEntry(a, ["a.md"]);
    index.insertEntry(b, ["b.md"]);
    expect(index.lastSeq()).toBe(2);
    expect(index.entryOf(b.externalId)?.seq).toBe(2);
    // the revoke deletes the row with the greatest number
    db.run("DELETE FROM local_file_entries WHERE external_id = ?", [b.externalId]);
    expect(index.lastSeq()).toBe(2);
    const c = newEntry({ relativePath: "c.md" });
    index.insertEntry(c, ["c.md"]);
    // MAX(seq)+1 would hand out 2 again, at or below a cursor already given out
    expect(index.entryOf(c.externalId)?.seq).toBe(3);
    expect(index.lastSeq()).toBe(3);
  });

  it("cannot be lowered or deleted, whoever writes", () => {
    const index = createLocalFileIndex(db);
    index.insertEntry(newEntry(), []);
    expect(() => db.run("UPDATE local_index_seq SET value = 0")).toThrow();
    expect(() => db.run("DELETE FROM local_index_seq")).toThrow();
    expect(counter()).toBe(1);
  });

  it("a write that does not apply leaves the counter alone", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const before = counter();
    expect(index.updateEntry(e.externalId, 999, fields({ revision: 2 })).applied).toBe(false);
    expect(counter()).toBe(before);
  });
});

describe("compare-and-set writes (I02B-R33)", () => {
  it("updates only when the sequence is the one that was read", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const seq = index.entryOf(e.externalId)?.seq as number;
    const ok = index.updateEntry(e.externalId, seq, fields({ revision: 2, size: 20 }));
    expect(ok.applied).toBe(true);
    const after = index.entryOf(e.externalId);
    expect(after).toMatchObject({ revision: 2, size: 20 });
    expect(after?.seq).toBeGreaterThan(seq);
    // the old number no longer applies
    expect(index.updateEntry(e.externalId, seq, fields({ revision: 3 })).applied).toBe(false);
    expect(index.entryOf(e.externalId)?.revision).toBe(2);
  });

  it("refuses an update of an entry that is not there", () => {
    const index = createLocalFileIndex(db);
    expect(index.updateEntry(newLocalId(), 1, fields()).applied).toBe(false);
  });

  it("a stale update after a user deletion scrubbed the entry applies nothing and no plaintext returns", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const stale = index.entryOf(e.externalId)?.seq as number;
    tombstone(storeSource(e.externalId), "user-deleted");
    const result = index.updateEntry(e.externalId, stale, fields({ revision: 2 }));
    expect(result.applied).toBe(false);
    const row = rawEntry(e.externalId);
    expect(row).toMatchObject({ state: "forgotten", relative_path: null, content_hash: null });
  });

  it("does not revive a deleted or forgotten entry even with its current sequence", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    tombstone(storeSource(e.externalId), "user-deleted");
    const now = index.entryOf(e.externalId)?.seq as number;
    expect(index.updateEntry(e.externalId, now, fields({ revision: 2 }))).toMatchObject({
      applied: false,
    });
    expect(rawEntry(e.externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("a collector's own deletion clears the plaintext and takes revision and sequence", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const seq = index.entryOf(e.externalId)?.seq as number;
    const r = index.updateEntry(e.externalId, seq, fields({ state: "deleted", revision: 2 }));
    expect(r.applied).toBe(true);
    expect(rawEntry(e.externalId)).toMatchObject({
      state: "deleted",
      relative_path: null,
      path_hash: null,
      content_hash: null,
      content_keyed_hash: null,
      size: null,
      revision: 2,
    });
  });

  it("does not write to an entry of a location that is not read", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const seq = index.entryOf(e.externalId)?.seq as number;
    for (const state of ["paused", "unavailable", "revoking"] as const) {
      setLocationState(db, loc, state, null);
      expect(index.updateEntry(e.externalId, seq, fields({ revision: 2 })).applied).toBe(false);
      expect(index.insertEntry(newEntry({ relativePath: `${state}.md` }), []).applied).toBe(false);
    }
    for (const state of ["active", "needs-confirmation"] as const) {
      setLocationState(db, loc, state, null);
      const cur = index.entryOf(e.externalId)?.seq as number;
      expect(index.updateEntry(e.externalId, cur, fields({ revision: 2 })).applied).toBe(true);
    }
  });

  it("refuses a move onto a path another entry holds", () => {
    const index = createLocalFileIndex(db);
    const a = newEntry({ relativePath: "a.md" });
    const b = newEntry({ relativePath: "b.md" });
    index.insertEntry(a, []);
    index.insertEntry(b, []);
    const seq = index.entryOf(a.externalId)?.seq as number;
    expect(index.updateEntry(a.externalId, seq, fields({ relativePath: "b.md" })).applied).toBe(
      false,
    );
  });
});

describe("a forgotten entry refuses what the user deleted (I02B-R33)", () => {
  function forget(path: string, hash: string): string {
    const index = createLocalFileIndex(db);
    const e = newEntry({ relativePath: path, contentHash: hash });
    index.insertEntry(e, [path]);
    tombstone(storeSource(e.externalId), "user-deleted");
    expect(index.entryOf(e.externalId)?.state).toBe("forgotten");
    return e.externalId;
  }

  it("by the path: a new entry at the same path is refused", () => {
    forget("docs/a.md", "11".repeat(32));
    const index = createLocalFileIndex(db);
    const again = newEntry({ relativePath: "docs/a.md", contentHash: "22".repeat(32) });
    expect(index.insertEntry(again, ["docs/a.md"])).toMatchObject({
      applied: false,
      reason: "forgotten",
    });
    expect(index.entryOf(again.externalId)).toBeUndefined();
  });

  it("by the content when the forgotten file's path holds no such file now (it was moved)", () => {
    forget("docs/a.md", "11".repeat(32));
    const index = createLocalFileIndex(db);
    const moved = newEntry({ relativePath: "other/b.md", contentHash: "11".repeat(32) });
    expect(index.insertEntry(moved, ["other/b.md"])).toMatchObject({
      applied: false,
      reason: "forgotten",
    });
  });

  it("not by the content when the forgotten file is still in place with that content", () => {
    forget("docs/a.md", "11".repeat(32));
    const index = createLocalFileIndex(db);
    const copy = newEntry({ relativePath: "copy.md", contentHash: "11".repeat(32) });
    expect(index.insertEntry(copy, ["docs/a.md", "copy.md"]).applied).toBe(true);
  });

  it("several new files of the same bytes are all refused while the forgotten one is gone", () => {
    forget("docs/a.md", "11".repeat(32));
    const index = createLocalFileIndex(db);
    const seen = ["x/1.md", "x/2.md"];
    for (const p of seen) {
      const e = newEntry({ relativePath: p, contentHash: "11".repeat(32) });
      expect(index.insertEntry(e, seen).applied).toBe(false);
    }
  });

  it("only within the same location", () => {
    forget("docs/a.md", "11".repeat(32));
    const other = newLocation();
    const index = createLocalFileIndex(db);
    const e = newEntry({
      locationId: other,
      relativePath: "docs/a.md",
      contentHash: "11".repeat(32),
    });
    expect(index.insertEntry(e, ["docs/a.md"]).applied).toBe(true);
  });

  it("finds a forgotten entry by the plaintext path and by the content", () => {
    const id = forget("docs/a.md", "11".repeat(32));
    const index = createLocalFileIndex(db);
    expect(index.findByPath(loc, "docs/a.md")?.externalId).toBe(id);
    expect(index.findForgottenByContent(loc, "11".repeat(32)).map((e) => e.externalId)).toEqual([
      id,
    ]);
    expect(index.findByPath(loc, "docs/zzz.md")).toBeUndefined();
  });
});

describe("tombstone trigger (I02B-R33, I02B-C23)", () => {
  it("a user deletion forgets the entry: plaintext columns gone, the keyed hashes stay, a new sequence", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, [e.relativePath]);
    const before = rawEntry(e.externalId);
    tombstone(storeSource(e.externalId), "user-deleted");
    const row = rawEntry(e.externalId);
    expect(row).toMatchObject({
      state: "forgotten",
      relative_path: null,
      size: null,
      mtime_ns: null,
      content_hash: null,
      file_no: null,
      pending_delete: 0,
      revision: before?.revision,
    });
    expect(row?.path_hash).toBe(before?.path_hash);
    expect(row?.content_keyed_hash).toBe(before?.content_keyed_hash);
    expect(row?.seq).toBeGreaterThan(before?.seq as number);
    expect(row?.seq).toBe(counter());
  });

  it("an access-revoked tombstone forgets it the same way", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    tombstone(storeSource(e.externalId), "access-revoked");
    expect(rawEntry(e.externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("a source deletion leaves a deleted entry with only the ids, the revision one higher and no hashes", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    tombstone(storeSource(e.externalId), "source-deleted");
    expect(rawEntry(e.externalId)).toMatchObject({
      state: "deleted",
      relative_path: null,
      path_hash: null,
      content_keyed_hash: null,
      content_hash: null,
      revision: 2,
      external_id: e.externalId,
      location_id: loc,
    });
  });

  it("scrubs a skipped entry too, and clears the pending mark", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry({ state: "skipped", skipReason: "encrypted", pendingDelete: 1 });
    index.insertEntry(e, []);
    tombstone(storeSource(e.externalId), "user-deleted");
    expect(rawEntry(e.externalId)).toMatchObject({
      state: "forgotten",
      skip_reason: null,
      skip_limits: null,
      pending_delete: 0,
    });
  });

  it("fires for a row written by SQL directly, through no entry point at all", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const sourceId = storeSource(e.externalId);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, 1, ?, 'user-deleted')",
      [sourceId, AT],
    );
    expect(rawEntry(e.externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("fires on an update of the tombstone row (a lift and a new deletion)", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const sourceId = storeSource(e.externalId);
    // a tombstone that is lifted at birth does not scrub; un-lifting it by update does
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason, lifted_at) VALUES (?, 1, ?, 'user-deleted', ?)",
      [sourceId, AT, AT],
    );
    expect(rawEntry(e.externalId)).toMatchObject({ state: "present" });
    db.run("UPDATE tombstones SET lifted_at = NULL WHERE source_id = ?", [sourceId]);
    expect(rawEntry(e.externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("a lift of the tombstone scrubs nothing and does not move the sequence", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const sourceId = storeSource(e.externalId);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason, lifted_at) VALUES (?, 1, ?, 'user-deleted', ?)",
      [sourceId, AT, AT],
    );
    expect(counter()).toBe(1);
  });

  it("finds the entry by the hash when the source row already holds the hash instead of the plain identity", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const hash = rawEntry(e.externalId)?.identity_hash as string;
    const hashed = db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id, identity_hashed) VALUES ('local-files', ?, ?, 1)",
      [hash, hash],
    ).lastInsertRowid;
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (?, 0, ?, 'user-deleted')",
      [hashed, AT],
    );
    expect(rawEntry(e.externalId)).toMatchObject({ state: "forgotten", relative_path: null });
  });

  it("only for the instance local-files: a JSONL source with the same namespace and external id changes nothing", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const before = rawEntry(e.externalId);
    const decoy = storeSource(e.externalId, loc, "jsonl-file-x");
    tombstone(decoy, "user-deleted");
    tombstone(decoy, "source-deleted");
    expect(rawEntry(e.externalId)).toEqual(before);
    expect(counter()).toBe(1);
  });

  it("skips an entry that is already scrubbed: its sequence does not move again", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const seq0 = index.entryOf(e.externalId)?.seq as number;
    // the collector wrote the deletion itself, then the sync stored its `delete`
    expect(
      index.updateEntry(e.externalId, seq0, fields({ state: "deleted", revision: 2 })).applied,
    ).toBe(true);
    const written = rawEntry(e.externalId);
    const sourceId = storeSource(e.externalId);
    tombstone(sourceId, "source-deleted");
    expect(rawEntry(e.externalId)).toEqual(written);
    expect(counter()).toBe(written?.seq);
    // and the user deleting it afterwards changes nothing either
    tombstone(sourceId, "user-deleted");
    expect(rawEntry(e.externalId)).toEqual(written);
  });

  it("an entry whose source was never stored is left alone", () => {
    const index = createLocalFileIndex(db);
    const e = newEntry();
    index.insertEntry(e, []);
    const other = storeSource(newLocalId());
    tombstone(other, "user-deleted");
    expect(rawEntry(e.externalId)).toMatchObject({ state: "present" });
  });
});

describe("memory and canonical implementations answer the same (I02B-C23 parity)", () => {
  type Pair = {
    name: string;
    make: () => {
      index: LocalFileIndex;
      scrub: (id: string, reason: "user-deleted" | "source-deleted") => void;
    };
  };
  const pairs = (): Pair[] => [
    {
      name: "canonical",
      make: () => ({
        index: createLocalFileIndex(db),
        scrub: (id, reason) => void tombstone(storeSource(id), reason),
      }),
    },
    {
      name: "memory",
      make: () => {
        const mem = createMemoryLocalFileIndex([{ id: loc, state: "active" }]);
        return { index: mem, scrub: (id, reason) => mem.scrub(id, reason) };
      },
    },
  ];
  const shape = (i: LocalFileIndex, id: string) => {
    const e = i.entryOf(id);
    return e && { ...e, seq: undefined };
  };

  it("a stale updateEntry after a scrub is not applied, and the rows agree", () => {
    const outcomes = pairs().map(({ make }) => {
      const { index, scrub } = make();
      const e = { ...newEntry(), externalId: "A".repeat(22) };
      expect(index.insertEntry(e, [e.relativePath]).applied).toBe(true);
      const stale = index.entryOf(e.externalId)?.seq as number;
      scrub(e.externalId, "user-deleted");
      const r = index.updateEntry(e.externalId, stale, fields({ revision: 2 }));
      return { applied: r.applied, entry: shape(index, e.externalId), last: index.lastSeq() };
    });
    expect(outcomes[0]?.applied).toBe(false);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]?.entry).toMatchObject({ state: "forgotten", relativePath: null });
  });

  it("the forgotten refusals and the counter agree", () => {
    const outcomes = pairs().map(({ make }) => {
      const { index, scrub } = make();
      const e = {
        ...newEntry({ relativePath: "d/a.md", contentHash: "11".repeat(32) }),
        externalId: "B".repeat(22),
      };
      index.insertEntry(e, ["d/a.md"]);
      scrub(e.externalId, "user-deleted");
      const byPath = index.insertEntry(
        {
          ...newEntry({ relativePath: "d/a.md", contentHash: "22".repeat(32) }),
          externalId: "C".repeat(22),
        },
        ["d/a.md"],
      );
      const byContent = index.insertEntry(
        {
          ...newEntry({ relativePath: "m/b.md", contentHash: "11".repeat(32) }),
          externalId: "D".repeat(22),
        },
        ["m/b.md"],
      );
      const copy = index.insertEntry(
        {
          ...newEntry({ relativePath: "c.md", contentHash: "11".repeat(32) }),
          externalId: "E".repeat(22),
        },
        ["d/a.md", "c.md"],
      );
      return { byPath, byContent, copy: copy.applied, last: index.lastSeq() };
    });
    expect(outcomes[0]).toMatchObject({
      byPath: { applied: false, reason: "forgotten" },
      byContent: { applied: false, reason: "forgotten" },
      copy: true,
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("a deleted entry stays as it is when a source deletion arrives, in both", () => {
    const outcomes = pairs().map(({ make }) => {
      const { index, scrub } = make();
      const e = { ...newEntry(), externalId: "F".repeat(22) };
      index.insertEntry(e, []);
      const seq = index.entryOf(e.externalId)?.seq as number;
      index.updateEntry(e.externalId, seq, fields({ state: "deleted", revision: 2 }));
      const before = index.lastSeq();
      scrub(e.externalId, "source-deleted");
      return { before, after: index.lastSeq(), entry: shape(index, e.externalId) };
    });
    expect(outcomes[0]?.after).toBe(outcomes[0]?.before);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});
