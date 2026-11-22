// V02-R3/R12 tombstones and the change sequence (ADR 0013 decisions 4 and 6): a
// tombstone holds no content, and every source change raises the sequence exactly once.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { isFenceCurrent } from "./commit-derived.ts";
import { migrate } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
import { nextSourceVersion, registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";
import {
  readTombstone,
  readTombstoneState,
  recordTombstone,
  recordTombstoneLift,
  writeTombstone,
} from "./tombstones.ts";

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
  reason: "user-deleted",
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

// tombstone.rules (I04-R9, I04-C2): the judgement recordTombstone makes from the
// stored row and the source's latest version. Source 1 starts with version 1.
describe("tombstone.rules: recordTombstone", () => {
  const AT = "2026-11-22T00:00:00.000Z";
  const LATER = "2026-11-23T00:00:00.000Z";
  const save = (body: string) => saveSourceRecord(db, "c1", { externalId: "e1", title: "t", body });
  const purge = () => db.run("DELETE FROM source_versions WHERE source_id = 1");
  const record = (
    reason: "user-deleted" | "source-deleted" | "access-revoked",
    lastRevision: number | null = null,
    at = AT,
  ) => recordTombstone(db, 1, { reason, lastRevision, at });
  const rowCount = () => db.all("SELECT count(*) AS n FROM tombstones")[0]?.n;

  it("creates a tombstone covering the source's latest version", () => {
    save("b2");
    const seq = readChangeSeq(db);
    const state = {
      sourceId: 1,
      coversVersion: 2,
      lastRevision: 7,
      reason: "source-deleted",
      at: AT,
      liftedAt: null,
    };
    expect(record("source-deleted", 7)).toEqual({ outcome: "created", tombstone: state });
    expect(readTombstoneState(db, 1)).toEqual(state);
    expect(readTombstoneState(db, 404)).toBeUndefined();
    expect(readChangeSeq(db)).toBe(seq + 1);
  });

  it("lets user-deleted overwrite a source reason at the same cover, and never the reverse", () => {
    record("source-deleted", 7);
    const seq = readChangeSeq(db);
    expect(record("user-deleted", null, LATER)).toMatchObject({
      outcome: "reason-changed",
      tombstone: { coversVersion: 1, reason: "user-deleted", lastRevision: null, at: LATER },
    });
    const stored = readTombstoneState(db, 1);
    // a source event keeps the user's reason and time; a greater revision alone
    // raises last_revision (I01-R11), an equal, lower or missing one changes nothing
    const AGAIN = "2026-11-24T00:00:00.000Z";
    expect(record("source-deleted", 99, AGAIN)).toEqual({
      outcome: "revision-raised",
      tombstone: { ...stored, lastRevision: 99 },
    });
    expect(record("access-revoked", 99, AGAIN).outcome).toBe("unchanged");
    expect(record("access-revoked", 98, AGAIN).outcome).toBe("unchanged");
    expect(record("source-deleted", null, AGAIN).outcome).toBe("unchanged");
    expect(record("user-deleted", 100, AGAIN).outcome).toBe("unchanged");
    expect(readTombstoneState(db, 1)).toEqual({ ...stored, lastRevision: 99 });
    // a reason change is no content change
    expect(readChangeSeq(db)).toBe(seq);
    expect(rowCount()).toBe(1);
  });

  it("changes nothing for an equal or lower tombstone: the row, the row count and the sequence stay", () => {
    record("access-revoked", 5);
    const stored = readTombstoneState(db, 1);
    const seq = readChangeSeq(db);
    expect(record("access-revoked", 5, LATER).outcome).toBe("unchanged"); // the same event again
    expect(record("source-deleted", 5, LATER).outcome).toBe("unchanged"); // same revision
    expect(record("source-deleted", 4, LATER).outcome).toBe("unchanged"); // a lower one
    expect(record("source-deleted", null, LATER).outcome).toBe("unchanged"); // none at all
    expect(readTombstoneState(db, 1)).toEqual(stored);
    expect(readChangeSeq(db)).toBe(seq);
    expect(rowCount()).toBe(1);

    record("user-deleted", null, LATER);
    const user = readTombstoneState(db, 1);
    expect(record("user-deleted", null, "2026-11-24T00:00:00.000Z").outcome).toBe("unchanged");
    expect(readTombstoneState(db, 1)).toEqual(user);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("raises only last_revision when a source tombstone of the same cover comes with a greater revision", () => {
    record("source-deleted", 5);
    const seq = readChangeSeq(db);
    expect(record("access-revoked", 6, LATER)).toEqual({
      outcome: "revision-raised",
      // the reason and the time stay: only the revision moves
      tombstone: {
        sourceId: 1,
        coversVersion: 1,
        lastRevision: 6,
        reason: "source-deleted",
        at: AT,
        liftedAt: null,
      },
    });
    expect(readTombstoneState(db, 1)).toMatchObject({ lastRevision: 6, reason: "source-deleted" });
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("takes an empty last_revision as below any revision (provisional)", () => {
    record("source-deleted", null);
    expect(record("source-deleted", 1, LATER).outcome).toBe("revision-raised");
    expect(readTombstoneState(db, 1)).toMatchObject({ lastRevision: 1, at: AT });
  });

  it("moves to a greater cover with the new deletion's reason, revision and time, clearing the lift", () => {
    record("user-deleted");
    purge();
    recordTombstoneLift(db, 1, LATER);
    expect(save("again")).toMatchObject({ status: "created", version: 2 });
    const seq = readChangeSeq(db);
    const at = "2026-11-24T00:00:00.000Z";
    expect(record("source-deleted", 3, at)).toEqual({
      outcome: "cover-extended",
      tombstone: {
        sourceId: 1,
        coversVersion: 2,
        lastRevision: 3,
        reason: "source-deleted",
        at,
        liftedAt: null,
      },
    });
    expect(readChangeSeq(db)).toBe(seq + 1);
    expect(rowCount()).toBe(1);
  });

  it("lifts by writing lifted_at once, without raising the sequence", () => {
    expect(recordTombstoneLift(db, 1, AT)).toBe("unchanged"); // no tombstone
    expect(rowCount()).toBe(0);
    record("source-deleted", 2);
    const seq = readChangeSeq(db);
    expect(recordTombstoneLift(db, 1, LATER)).toBe("lifted");
    expect(readTombstoneState(db, 1)).toMatchObject({
      coversVersion: 1,
      reason: "source-deleted",
      lastRevision: 2,
      at: AT,
      liftedAt: LATER,
    });
    // already lifted: the first lift's time stays
    expect(recordTombstoneLift(db, 1, "2026-11-24T00:00:00.000Z")).toBe("unchanged");
    expect(readTombstoneState(db, 1)?.liftedAt).toBe(LATER);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it.each(["user-deleted", "source-deleted"] as const)(
    "writes a lifted tombstone again on a %s deletion before any new version, keeping the cover",
    (reason) => {
      save("b2");
      record("source-deleted", 4);
      purge(); // no version row is left: the cover must come from the stored tombstone
      recordTombstoneLift(db, 1, LATER);
      const seq = readChangeSeq(db);
      const at = "2026-11-24T00:00:00.000Z";
      const revision = reason === "user-deleted" ? null : 4;
      expect(record(reason, revision, at)).toEqual({
        outcome: "reason-changed",
        tombstone: {
          sourceId: 1,
          coversVersion: 2,
          lastRevision: revision,
          reason,
          at,
          liftedAt: null,
        },
      });
      expect(readTombstoneState(db, 1)).toMatchObject({ coversVersion: 2, liftedAt: null });
      expect(readChangeSeq(db)).toBe(seq);
    },
  );

  it("numbers the next version covers_version + 1 once every version is gone", () => {
    save("b2");
    save("b3");
    expect(nextSourceVersion(db, 1)).toBe(4);
    record("source-deleted", 4);
    purge();
    expect(nextSourceVersion(db, 1)).toBe(4);
    // not lifted: the arrival is refused and nothing is written (V02's rule until I01-T02)
    expect(save("back")).toEqual({ status: "refused", reason: "tombstoned" });
    recordTombstoneLift(db, 1, LATER);
    expect(save("back")).toEqual({ status: "created", sourceId: 1, version: 4 });
    expect(nextSourceVersion(db, 1)).toBe(5);
  });

  it("covers version 0 for a source that never had a version, and still blocks its arrival", () => {
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c1', '', 'new')",
    );
    expect(
      recordTombstone(db, 2, { reason: "source-deleted", lastRevision: 3, at: AT }),
    ).toMatchObject({
      outcome: "created",
      tombstone: { sourceId: 2, coversVersion: 0, lastRevision: 3 },
    });
    const record2 = { externalId: "new", title: "t", body: "b" };
    expect(saveSourceRecord(db, "c1", record2)).toEqual({
      status: "refused",
      reason: "tombstoned",
    });
    recordTombstoneLift(db, 2, LATER);
    expect(saveSourceRecord(db, "c1", record2)).toEqual({
      status: "created",
      sourceId: 2,
      version: 1,
    });
  });

  it("keeps a covered version outside the fence after a lift: a lift uncovers nothing", () => {
    // the version row is left (covered, not yet purged): only the cover decides
    record("source-deleted", 2);
    const job = { sourceId: 1, fenceVersion: 1 };
    expect(isFenceCurrent(db, job)).toBe(false);
    recordTombstoneLift(db, 1, LATER);
    expect(isFenceCurrent(db, job)).toBe(false);
    // a version above the cover is current again
    expect(save("b2")).toMatchObject({ status: "created", version: 2 });
    expect(isFenceCurrent(db, { sourceId: 1, fenceVersion: 2 })).toBe(true);
  });

  it("refuses an unknown reason or source", () => {
    expect(() => record("expired" as never)).toThrow(/CHECK/);
    expect(() =>
      recordTombstone(db, 404, { reason: "user-deleted", lastRevision: null, at: AT }),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps V02's writeTombstone on the same row: a moved cover drops the revision and the lift", () => {
    record("source-deleted", 4);
    recordTombstoneLift(db, 1, LATER);
    expect(writeTombstone(db, { ...tombstone, version: 1 })).toBe("unchanged");
    expect(readTombstoneState(db, 1)).toMatchObject({ lastRevision: 4, liftedAt: LATER });
    expect(writeTombstone(db, { ...tombstone, version: 2 })).toBe("written");
    expect(readTombstoneState(db, 1)).toEqual({
      sourceId: 1,
      coversVersion: 2,
      lastRevision: null,
      reason: "user-deleted",
      at: tombstone.at,
      liftedAt: null,
    });
  });
});
