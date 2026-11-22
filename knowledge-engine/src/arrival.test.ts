// I01-R8 ~ R14 (I01-T02; I01-C2, I01-C3): what a Connector's change comes to in the
// canonical store. Tests: arrival.decision (the judgment figure branch by branch,
// before and after a lift), source.provenance, source.tombstone, scope.change.
// The two numbers stay apart: `revision` is the origin system's and only orders
// arrivals, `version` is the product's and numbers new versions (I01-R9).
import type { Change, SourceRecord } from "@pki/contracts";
import {
  canonicalTransaction,
  findSourceId,
  identityKey,
  listInvalidations,
  migrate,
  prepareCanonicalDb,
  readChangeSeq,
  readTombstoneState,
  registerConnectorInstance,
  type SqlDriver,
} from "@pki/storage";
import { openBetterSqlite3 } from "@pki/storage/adapters";
import { canariesLeft, seedLegacyTombstone } from "@pki/testkit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acceptChange } from "./arrival.ts";
import { applyTombstone, liftTombstone } from "./tombstone-entry.ts";

const AT = "2026-11-22T00:00:00.000Z";
const EVENT_AT = "2026-11-21T00:00:00Z";

let db: SqlDriver;
beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
  registerConnectorInstance(db, "c1", "test-fixtures");
  registerConnectorInstance(db, "c2", "test-fixtures");
});
afterEach(() => db.close());

const record = (revision: number, over: Partial<SourceRecord> = {}): SourceRecord => ({
  namespace: "n",
  externalId: "e1",
  revision,
  schemaVersion: 2,
  title: "t",
  body: "b",
  ...over,
});
const accept = (change: Change, instance = "c1", options?: { scopeClaimed?: boolean }) =>
  canonicalTransaction(db, (tx) => acceptChange(tx, instance, change, AT, options));
const upsert = (revision: number, over: Partial<SourceRecord> = {}, instance = "c1") =>
  accept({ kind: "upsert", record: record(revision, over) }, instance);
const ref = (revision: number, externalId = "e1") => ({
  namespace: "n",
  externalId,
  revision,
  at: EVENT_AT,
});
const del = (revision: number, externalId = "e1") =>
  accept({ kind: "delete", ...ref(revision, externalId) });
const revoke = (revision: number, externalId = "e1") =>
  accept({ kind: "access-revoked", ...ref(revision, externalId) });
const scope = (revision: number, accessScope: string[], externalId = "e1") =>
  accept({ kind: "scope-change", ...ref(revision, externalId), accessScope });

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n as number;
const sourceRow = (id = 1) =>
  db.all(
    "SELECT namespace, external_id, identity_hashed, last_revision, access_scope, scope_claimed FROM sources WHERE id = ?",
    [id],
  )[0];
const versions = () =>
  db.all("SELECT version, revision, body FROM source_versions ORDER BY id") as {
    version: number;
    revision: number | null;
    body: string;
  }[];
const sid = () => findSourceId(db, "c1", "n", "e1") as number;
const identity = { connectorInstanceId: "c1", namespace: "n", externalId: "e1" };
const userDelete = () =>
  canonicalTransaction(db, (tx) =>
    applyTombstone(tx, { identity, reason: "user-deleted", lastRevision: null, at: AT }),
  );
const lift = () => canonicalTransaction(db, (tx) => liftTombstone(tx, sid(), AT));
const scopeChanged = () => listInvalidations(db).filter((r) => r.changeKind === "scope-changed");

describe("arrival.decision: an upsert", () => {
  it("creates the first version, remembering its revision (step 3 with no last)", () => {
    expect(upsert(4)).toMatchObject({ outcome: "created", version: 1 });
    expect(versions()).toEqual([{ version: 1, revision: 4, body: "b" }]);
    expect(sourceRow()).toMatchObject({ last_revision: 4, namespace: "n", identity_hashed: 0 });
  });

  it("is stale below the last revision and stores nothing (step 1)", () => {
    upsert(5);
    const seq = readChangeSeq(db);
    expect(upsert(3, { body: "older" })).toEqual({ outcome: "stale" });
    expect(versions()).toHaveLength(1);
    expect(readChangeSeq(db)).toBe(seq);
    expect(sourceRow()?.last_revision).toBe(5);
  });

  it("is unchanged for the same revision, content and scope, and rejects other content at that revision (step 2)", () => {
    upsert(5);
    expect(upsert(5)).toMatchObject({ outcome: "unchanged" });
    // ⑦ the origin system broke its promise: which one is right is not ours to say
    expect(upsert(5, { body: "other" })).toEqual({
      outcome: "rejected",
      code: "revision-conflict",
    });
    expect(versions()).toHaveLength(1);
  });

  it("⑥ takes a scope change at the same revision and content as scope-updated", () => {
    upsert(5, { accessScope: ["a"] });
    expect(upsert(5, { accessScope: ["a", "b"] })).toMatchObject({ outcome: "scope-updated" });
    expect(sourceRow()?.access_scope).toBe('["a","b"]');
    expect(versions()).toHaveLength(1);
    expect(scopeChanged()).toHaveLength(1);
  });

  it("makes no new version for a greater revision with the same content and keeps the last up to date", () => {
    upsert(5);
    expect(upsert(8)).toMatchObject({ outcome: "unchanged" });
    expect(sourceRow()?.last_revision).toBe(8);
    expect(versions()).toHaveLength(1);
    // and the greater revision with a scope change is scope-updated
    expect(upsert(9, { accessScope: ["x"] })).toMatchObject({ outcome: "scope-updated" });
    expect(sourceRow()).toMatchObject({ last_revision: 9, access_scope: '["x"]' });
  });

  it("creates a version for a greater revision with other content, numbering it itself", () => {
    upsert(5);
    expect(upsert(6, { body: "second" })).toMatchObject({ outcome: "created", version: 2 });
    expect(versions()).toEqual([
      { version: 1, revision: 5, body: "b" },
      { version: 2, revision: 6, body: "second" },
    ]);
  });

  it("treats a record without a revision as unordered: it never touches the last revision", () => {
    upsert(5);
    const noRevision = { kind: "upsert", record: { ...record(1, { body: "seed" }) } } as const;
    delete (noRevision.record as Partial<SourceRecord>).revision;
    expect(accept(noRevision)).toMatchObject({ outcome: "created", version: 2 });
    expect(sourceRow()?.last_revision).toBe(5);
  });

  it("keeps one external id in two namespaces, two instances and two same-content records as separate sources (I01-R8)", () => {
    upsert(1, { namespace: "a" });
    upsert(1, { namespace: "b" });
    upsert(1, {}, "c2");
    upsert(1, { externalId: "e2" });
    expect(count("sources")).toBe(4);
    expect(count("source_versions")).toBe(4);
  });

  it("takes the content hash over title, body and blocks: other blocks are a new version, other provenance is not", () => {
    const block = (end: number) => [
      { start: 0, end, locator: { format: "txt", line: 1 } as const },
    ];
    upsert(1, { body: "abc", blocks: block(2) });
    expect(upsert(2, { body: "abc", blocks: block(2), author: "someone" })).toMatchObject({
      outcome: "unchanged",
    });
    expect(upsert(3, { body: "abc", blocks: block(3) })).toMatchObject({
      outcome: "created",
      version: 2,
    });
    // the same title and body without blocks is yet another content
    expect(upsert(4, { body: "abc" })).toMatchObject({ outcome: "created", version: 3 });
  });
});

describe("arrival.decision: the tombstone door and what follows", () => {
  it("① blocks the resend of a deleted source's last revision and the older ones", () => {
    upsert(1);
    expect(del(1)).toMatchObject({ outcome: "tombstoned" });
    expect(upsert(1)).toEqual({ outcome: "blocked" });
    expect(upsert(0 + 1, { body: "other" })).toEqual({ outcome: "blocked" });
    expect(versions()).toEqual([]);
  });

  it("② creates a source again past the delete's revision, numbered past the cover", () => {
    upsert(1);
    del(2);
    // the trigger of V02-T02 would refuse a number at or below the cover
    expect(upsert(3, { body: "again" })).toMatchObject({ outcome: "created", version: 2 });
    expect(versions()).toEqual([{ version: 2, revision: 3, body: "again" }]);
  });

  it("③ blocks everything while the user's deletion stands, whatever the revision", () => {
    upsert(1);
    userDelete();
    expect(upsert(9)).toEqual({ outcome: "blocked" });
    expect(upsert(1000, { body: "x" })).toEqual({ outcome: "blocked" });
    expect(scope(9, ["a"])).toEqual({ outcome: "blocked" });
  });

  it("④ blocks everything after a tombstone from before v13 has no revision", () => {
    upsert(1);
    // V02's write names no revision
    seedLegacyTombstone(db, { sourceId: sid(), version: 1, at: AT, reason: "source-deleted" });
    db.run("DELETE FROM source_versions");
    expect(upsert(50, { body: "x" })).toEqual({ outcome: "blocked" });
    expect(count("source_versions")).toBe(0);
  });

  it("⑤ finds a purged source by its keyed hash and makes no new row", () => {
    upsert(1);
    del(2);
    expect(sourceRow()?.identity_hashed).toBe(1);
    expect(upsert(2)).toEqual({ outcome: "blocked" });
    expect(count("sources")).toBe(1);
    expect(sourceRow()?.external_id).toBe(identityKey(db, "c1", "n", "e1"));
  });

  it("⑧ after a lift judges by the last revision: the deleted revision is stale, a greater one is created", () => {
    upsert(1);
    del(3);
    lift();
    expect(upsert(3)).toEqual({ outcome: "stale" });
    expect(upsert(2, { body: "older" })).toEqual({ outcome: "stale" });
    expect(count("source_versions")).toBe(0);
    expect(upsert(4, { body: "back" })).toMatchObject({ outcome: "created", version: 2 });
  });

  it("⑧ after a lift with no last revision the next record is created", () => {
    upsert(1);
    userDelete();
    // a source from before the revision rule has no last revision to judge by
    db.run("UPDATE sources SET last_revision = NULL");
    lift();
    expect(upsert(1, { body: "back" })).toMatchObject({ outcome: "created" });
  });

  it("⑨ blocks a late upsert below a delete that came first, and raises the tombstone's revision", () => {
    upsert(2);
    del(4);
    expect(readTombstoneState(db, sid())?.lastRevision).toBe(4);
    expect(upsert(3, { body: "late" })).toEqual({ outcome: "blocked" });
    expect(upsert(4, { body: "same" })).toEqual({ outcome: "blocked" });
    expect(versions()).toEqual([]);
  });

  it("⑩ raises both last revisions for a later delete, moving neither cover nor the change sequence", () => {
    upsert(1);
    del(2);
    const seq = readChangeSeq(db);
    const cover = readTombstoneState(db, sid())?.coversVersion;
    expect(del(4)).toMatchObject({ outcome: "tombstoned" });
    expect(readTombstoneState(db, sid())).toMatchObject({ lastRevision: 4, coversVersion: cover });
    expect(sourceRow()?.last_revision).toBe(4);
    expect(readChangeSeq(db)).toBe(seq);
    expect(upsert(3)).toEqual({ outcome: "blocked" });
  });

  it("⑪ writes the plain identity back into a hashed row it accepts, before and after a lift", () => {
    upsert(1);
    del(2);
    expect(upsert(3, { body: "again" })).toMatchObject({ outcome: "created" });
    expect(sourceRow()).toMatchObject({ namespace: "n", external_id: "e1", identity_hashed: 0 });
    // the next arrival finds it by the plain identity: one row, no new source
    expect(upsert(4, { body: "again 2" })).toMatchObject({ outcome: "created", version: 3 });
    expect(count("sources")).toBe(1);
    expect(sourceRow()).toMatchObject({ external_id: "e1", last_revision: 4 });

    // and the same after a lift
    upsert(1, { externalId: "e2" });
    accept({ kind: "delete", ...ref(2, "e2") });
    lift2("e2");
    expect(upsert(5, { externalId: "e2", body: "back" })).toMatchObject({ outcome: "created" });
    const row = db.all(
      "SELECT namespace, external_id, identity_hashed FROM sources WHERE external_id = 'e2'",
    );
    expect(row).toEqual([{ namespace: "n", external_id: "e2", identity_hashed: 0 }]);
  });

  it("leaves the other sources of an instance alone when one is deleted", () => {
    upsert(1);
    upsert(1, { externalId: "other" });
    del(2);
    expect(upsert(2, { externalId: "other", body: "b2" })).toMatchObject({ outcome: "created" });
  });
});

function lift2(externalId: string) {
  const id = findSourceId(db, "c1", "n", externalId) as number;
  canonicalTransaction(db, (tx) => liftTombstone(tx, id, AT));
}

describe("source.tombstone", () => {
  it("① purges a deleted or access-revoked source and records both last revisions", () => {
    upsert(3, { accessScope: ["a"] });
    expect(del(5)).toMatchObject({ outcome: "tombstoned" });
    expect(readTombstoneState(db, sid())).toMatchObject({
      reason: "source-deleted",
      lastRevision: 5,
      coversVersion: 1,
    });
    expect(count("source_versions")).toBe(0);
    expect(listInvalidations(db)[0]).toMatchObject({ changeKind: "source-deleted" });

    upsert(1, { externalId: "e2" });
    expect(revoke(1, "e2")).toMatchObject({ outcome: "tombstoned" });
    const id = findSourceId(db, "c1", "n", "e2") as number;
    expect(readTombstoneState(db, id)).toMatchObject({ reason: "access-revoked" });
  });

  it("answers the same event again as unchanged (idempotent)", () => {
    upsert(1);
    del(2);
    const seq = readChangeSeq(db);
    const invalidations = count("invalidations");
    expect(del(2)).toEqual({ outcome: "unchanged" });
    expect(revoke(2)).toEqual({ outcome: "unchanged" });
    expect(count("invalidations")).toBe(invalidations);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("③ does not apply a delete below the last revision and counts it apart", () => {
    upsert(5);
    expect(del(3)).toEqual({ outcome: "stale-tombstone" });
    expect(readTombstoneState(db, sid())).toBeUndefined();
    expect(versions()).toHaveLength(1);
    expect(sourceRow()?.last_revision).toBe(5);
  });

  it("④ applies an access-revoked event at any revision", () => {
    upsert(5);
    expect(revoke(3)).toMatchObject({ outcome: "tombstoned" });
    expect(readTombstoneState(db, sid())).toMatchObject({
      reason: "access-revoked",
      lastRevision: 5,
    });
    expect(sourceRow()?.last_revision).toBe(5);
    expect(versions()).toEqual([]);
  });

  it("keeps the user's reason and raises only the revision when a source event comes after it", () => {
    upsert(1);
    userDelete();
    expect(del(7)).toMatchObject({ outcome: "tombstoned" });
    expect(readTombstoneState(db, sid())).toMatchObject({
      reason: "user-deleted",
      lastRevision: 7,
    });
    expect(sourceRow()?.last_revision).toBe(7);
  });

  it("takes the tombstone's own revision into the maximum when the source row holds none", () => {
    upsert(1);
    del(5);
    db.run("UPDATE sources SET last_revision = NULL");
    expect(del(4)).toEqual({ outcome: "unchanged" });
    expect(readTombstoneState(db, sid())?.lastRevision).toBe(5);
    expect(sourceRow()?.last_revision).toBe(5);
  });

  it("② records a source never seen, by its keyed hash alone, and blocks an older upsert after it", () => {
    expect(del(4, "ghost")).toMatchObject({ outcome: "tombstoned" });
    expect(
      db.all("SELECT namespace, external_id, identity_hashed, last_revision FROM sources"),
    ).toEqual([
      {
        namespace: identityKey(db, "c1", "n", "ghost"),
        external_id: identityKey(db, "c1", "n", "ghost"),
        identity_hashed: 1,
        last_revision: 4,
      },
    ]);
    expect(readTombstoneState(db, findSourceId(db, "c1", "n", "ghost") as number)).toMatchObject({
      coversVersion: 0,
      lastRevision: 4,
    });
    expect(upsert(3, { externalId: "ghost" })).toEqual({ outcome: "blocked" });
    expect(upsert(5, { externalId: "ghost" })).toMatchObject({ outcome: "created", version: 1 });
    expect(count("sources")).toBe(1);
  });

  it("registers the projections' removal jobs for what a deletion purged, and none when nothing was stored", () => {
    upsert(1);
    const jobs = () =>
      db.all("SELECT target FROM jobs WHERE kind = 'projection-remove' ORDER BY target");
    expect(del(2)).toMatchObject({ outcome: "tombstoned" });
    expect(jobs()).toEqual([{ target: "engine" }, { target: "vectorIndex" }]);
    expect(del(3, "never")).toMatchObject({ outcome: "tombstoned" });
    expect(del(3, "never")).toEqual({ outcome: "unchanged" });
    expect(jobs()).toHaveLength(2);
  });

  describe("on a file", () => {
    let dir: string;
    let file: SqlDriver;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pki-arrival-"));
      file = openBetterSqlite3(join(dir, "pki.sqlite"));
      prepareCanonicalDb(file);
      registerConnectorInstance(file, "c1", "test-fixtures");
    });
    afterEach(() => {
      file.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("② keeps the external id of a source never seen out of every file, stored by hash only", () => {
      canonicalTransaction(file, (tx) =>
        acceptChange(tx, "c1", { kind: "delete", ...ref(4, "zqxcanaryid") }, AT),
      );
      canonicalTransaction(file, (tx) =>
        acceptChange(
          tx,
          "c1",
          { kind: "upsert", record: record(3, { externalId: "zqxcanaryid" }) },
          AT,
        ),
      );
      expect(canariesLeft(dir, ["zqxcanaryid"])).toEqual([]);
      expect(file.all("SELECT identity_hashed FROM sources")).toEqual([{ identity_hashed: 1 }]);
    });

    it("① removes the body and provenance canaries of a deleted source from the file", () => {
      const canaries = ["jvbbodyc", "wqpauthorc", "hnxlocatorc", "ytmmetac"];
      canonicalTransaction(file, (tx) =>
        acceptChange(
          tx,
          "c1",
          {
            kind: "upsert",
            record: record(1, {
              body: `본문 ${canaries[0]}`,
              author: canaries[1] as string,
              blocks: [
                { start: 0, end: 2, locator: { format: "xlsx", sheet: canaries[2] as string } },
              ],
              metadata: { note: canaries[3] },
            }),
          },
          AT,
        ),
      );
      expect(canariesLeft(dir, canaries)).toEqual(canaries);
      canonicalTransaction(file, (tx) =>
        acceptChange(tx, "c1", { kind: "access-revoked", ...ref(2) }, AT),
      );
      expect(canariesLeft(dir, canaries)).toEqual([]);
    });
  });
});

describe("scope.change", () => {
  it("① changes only the source row's scope and propagates scope-changed once, widening or narrowing", () => {
    upsert(1, { accessScope: ["a", "b"] });
    const seq = readChangeSeq(db);

    expect(scope(2, ["a"])).toMatchObject({ outcome: "scope-updated" });
    expect(sourceRow()).toMatchObject({ access_scope: '["a"]', last_revision: 2 });
    expect(scopeChanged()).toHaveLength(1);
    expect(versions()).toHaveLength(1);
    expect(readChangeSeq(db)).toBe(seq);

    expect(scope(3, ["b", "a", "c"])).toMatchObject({ outcome: "scope-updated" });
    expect(sourceRow()?.access_scope).toBe('["a","b","c"]');
    expect(scopeChanged()).toHaveLength(2);
    expect(versions()).toHaveLength(1);
  });

  it("is unchanged when the scope is the same once normalized", () => {
    upsert(1, { accessScope: ["a", "b"] });
    expect(scope(2, ["b", "a", "a"])).toEqual({ outcome: "unchanged" });
    expect(scopeChanged()).toHaveLength(0);
    expect(sourceRow()?.last_revision).toBe(2);
  });

  it("② accepts the same revision, is stale below it and blocked by a tombstone", () => {
    upsert(5, { accessScope: ["a"] });
    expect(scope(5, ["b"])).toMatchObject({ outcome: "scope-updated" });
    expect(scope(4, ["z"])).toEqual({ outcome: "stale" });
    expect(sourceRow()?.access_scope).toBe('["b"]');
    del(6);
    // the tombstone's door: past its revision it opens, and no version is left to change
    expect(scope(6, ["z"])).toEqual({ outcome: "blocked" });
    expect(scope(9, ["z"])).toEqual({ outcome: "stale" });
  });

  it("③ is stale for a source with no version, unseen or purged and lifted", () => {
    expect(scope(1, ["a"], "ghost")).toEqual({ outcome: "stale" });
    expect(count("sources")).toBe(0);
    upsert(1, { accessScope: ["a"] });
    del(2);
    lift();
    expect(scope(3, ["b"])).toEqual({ outcome: "stale" });
  });

  it("marks a claimed scope on every acceptance that writes a scope", () => {
    accept({ kind: "upsert", record: record(1, { accessScope: ["a"] }) }, "c1", {
      scopeClaimed: true,
    });
    expect(sourceRow()?.scope_claimed).toBe(1);
    expect(upsert(2, { externalId: "e2", accessScope: ["a"] })).toMatchObject({
      outcome: "created",
    });
    expect(sourceRow(2)?.scope_claimed).toBe(0);
  });

  it("stores no scope for a record without one: unknown stays null, the strictest", () => {
    upsert(1);
    expect(sourceRow()?.access_scope).toBeNull();
    expect(upsert(2, { accessScope: ["a"] })).toMatchObject({ outcome: "scope-updated" });
    expect(upsert(3)).toMatchObject({ outcome: "scope-updated" });
    expect(sourceRow()?.access_scope).toBeNull();
  });
});

describe("source.provenance", () => {
  it("keeps instance, namespace, external id, revision and provenance on the version, and the old versions' as they were", () => {
    upsert(1, {
      body: "first",
      author: "작성자 A",
      participants: ["p1", "p2"],
      sourceType: "mail",
      createdAt: "2026-11-01T00:00:00Z",
      metadata: { folder: "inbox" },
      blocks: [{ start: 0, end: 3, locator: { format: "pdf", page: 2 } }],
    });
    upsert(2, { body: "second", author: "작성자 B" });
    const rows = db.all(
      "SELECT version, revision, record_schema_version, meta, blocks FROM source_versions ORDER BY version",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ version: 1, revision: 1, record_schema_version: 2 });
    expect(JSON.parse(rows[0]?.meta as string)).toEqual({
      author: "작성자 A",
      participants: ["p1", "p2"],
      sourceType: "mail",
      createdAt: "2026-11-01T00:00:00Z",
      metadata: { folder: "inbox" },
    });
    expect(JSON.parse(rows[0]?.blocks as string)).toEqual([
      { start: 0, end: 3, locator: { format: "pdf", page: 2 } },
    ]);
    expect(JSON.parse(rows[1]?.meta as string)).toEqual({ author: "작성자 B" });
    expect(rows[1]?.blocks).toBeNull();
    expect(db.all("SELECT connector_instance_id, namespace, external_id FROM sources")).toEqual([
      { connector_instance_id: "c1", namespace: "n", external_id: "e1" },
    ]);
  });

  it("stores no provenance and no blocks for a record that has none", () => {
    upsert(1);
    expect(db.all("SELECT meta, blocks, record_schema_version FROM source_versions")).toEqual([
      { meta: null, blocks: null, record_schema_version: 2 },
    ]);
  });

  it("drops the provenance with the version when the source is deleted (I01-R13)", () => {
    upsert(1, { author: "someone" });
    del(2);
    expect(count("source_versions")).toBe(0);
  });
});
