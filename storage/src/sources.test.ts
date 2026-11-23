// V01-R7 source storage: identity is connector instance + namespace + external id
// (I01-R8), the same content makes no new version, and each instance keeps its
// kind and cursor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLegacyTombstone, memoryDbTemplate } from "@pki/testkit";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import { readChangeSeq } from "./revisions.ts";
import {
  LATEST_VERSION_SQL,
  beginRescan,
  contentHash,
  finishRescan,
  findSourceId,
  readCursor,
  readRescanState,
  registerConnectorInstance,
  readSourceVersion,
  listConnectorInstanceIds,
  setConfiguredScope,
  saveSourceRecord,
  writeCursor,
} from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

const freshDb = memoryDbTemplate(openBetterSqlite3, migrate);

let db: SqlDriver;

beforeEach(() => {
  db = freshDb();
  for (const id of ["c1", "c2"]) registerConnectorInstance(db, id, "test-fixtures");
});

afterEach(() => {
  db.close();
});

const count = (table: string) => db.all(`SELECT count(*) AS n FROM ${table}`)[0]?.n;
const record = (externalId: string, title = "t", body = "b") => ({ externalId, title, body });

describe("contentHash", () => {
  it("binds title and body so moving text between them changes the hash", () => {
    expect(contentHash("ab", "c")).not.toBe(contentHash("a", "bc"));
    expect(contentHash("t", "b")).toBe(contentHash("t", "b"));
    expect(contentHash("t", "b")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("saveSourceRecord", () => {
  it("keeps one external id in two namespaces as two sources, even with the same content", () => {
    expect(saveSourceRecord(db, "c1", { ...record("e1"), namespace: "space-a" }).status).toBe(
      "created",
    );
    expect(saveSourceRecord(db, "c1", { ...record("e1"), namespace: "space-b" }).status).toBe(
      "created",
    );
    expect(saveSourceRecord(db, "c1", record("e1")).status).toBe("created");
    expect(db.all("SELECT namespace, external_id FROM sources ORDER BY id")).toEqual([
      { namespace: "space-a", external_id: "e1" },
      { namespace: "space-b", external_id: "e1" },
      { namespace: "", external_id: "e1" },
    ]);
    expect(findSourceId(db, "c1", "space-b", "e1")).toBe(2);
    expect(findSourceId(db, "c1", "", "e1")).toBe(3);
    expect(findSourceId(db, "c1", "space-c", "e1")).toBeUndefined();
  });

  it("creates a source and its first version", () => {
    expect(saveSourceRecord(db, "c1", record("e1")).status).toBe("created");
    expect(db.all("SELECT title, body, content_hash FROM source_versions")).toEqual([
      { title: "t", body: "b", content_hash: contentHash("t", "b") },
    ]);
  });

  it("makes no new version when the content hash is unchanged", () => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c1", record("e1")).status).toBe("unchanged");
    expect([count("sources"), count("source_versions")]).toEqual([1, 1]);
  });

  it.each([
    ["title", record("e1", "t2", "b")],
    ["body", record("e1", "t", "b2")],
  ])("adds a version when the %s changes, keeping the old one", (_part, changed) => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c1", changed).status).toBe("created");
    expect([count("sources"), count("source_versions")]).toEqual([1, 2]);
  });

  it("compares with the latest version, so reverting content is a new version", () => {
    saveSourceRecord(db, "c1", record("e1", "t", "v1"));
    saveSourceRecord(db, "c1", record("e1", "t", "v2"));
    expect(saveSourceRecord(db, "c1", record("e1", "t", "v1")).status).toBe("created");
    expect(count("source_versions")).toBe(3);
  });

  it("numbers each source's versions from 1 (V02-R3)", () => {
    saveSourceRecord(db, "c1", record("e1", "t", "v1"));
    saveSourceRecord(db, "c1", record("e2", "t", "other"));
    saveSourceRecord(db, "c1", record("e1", "t", "v2"));
    expect(db.all("SELECT body, version FROM source_versions ORDER BY id")).toEqual([
      { body: "v1", version: 1 },
      { body: "other", version: 1 },
      { body: "v2", version: 2 },
    ]);
  });

  it("refuses a source whose Connector instance is not registered", () => {
    expect(() => saveSourceRecord(db, "ghost", record("e1"))).toThrow(/FOREIGN KEY/);
    expect(count("sources")).toBe(0);
  });

  it("keeps the same content from different instances or external ids apart", () => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c2", record("e1")).status).toBe("created");
    expect(saveSourceRecord(db, "c1", record("e2")).status).toBe("created");
    expect([count("sources"), count("source_versions")]).toEqual([3, 3]);
  });
});

describe("saveSourceRecord with the Connector's revision (V02-R2, cross-spec D1)", () => {
  const rev = (revision: number, body = "b") => ({ ...record("e1", "t", body), revision });
  const rows = () =>
    db.all("SELECT version, revision, body FROM source_versions ORDER BY id") as {
      version: number;
      revision: number | null;
      body: string;
    }[];

  it("numbers the version itself and keeps the record's revision beside it", () => {
    expect(saveSourceRecord(db, "c1", rev(7))).toEqual({
      status: "created",
      sourceId: 1,
      version: 1,
    });
    expect(rows()).toEqual([{ version: 1, revision: 7, body: "b" }]);
  });

  it("makes no new version for the same revision and content", () => {
    saveSourceRecord(db, "c1", rev(1));
    expect(saveSourceRecord(db, "c1", rev(1))).toEqual({ status: "unchanged", sourceId: 1 });
    expect(rows()).toHaveLength(1);
  });

  it("adds the next product version for a greater revision with other content, keeping the old", () => {
    saveSourceRecord(db, "c1", rev(1, "v1"));
    expect(saveSourceRecord(db, "c1", rev(5, "v5"))).toEqual({
      status: "created",
      sourceId: 1,
      version: 2,
    });
    expect(rows()).toEqual([
      { version: 1, revision: 1, body: "v1" },
      { version: 2, revision: 5, body: "v5" },
    ]);
  });

  it("makes no new version for a greater revision with the same content", () => {
    saveSourceRecord(db, "c1", rev(1));
    expect(saveSourceRecord(db, "c1", rev(2))).toEqual({ status: "unchanged", sourceId: 1 });
    expect(rows()).toHaveLength(1);
  });

  it("rejects the same revision with other content and writes nothing (I01-R10 step 2)", () => {
    saveSourceRecord(db, "c1", rev(3, "v3"));
    const seq = readChangeSeq(db);
    expect(saveSourceRecord(db, "c1", rev(3, "other"))).toEqual({
      status: "rejected",
      code: "revision-conflict",
    });
    expect(rows()).toHaveLength(1);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("is stale for a lower revision, whatever its content, and writes nothing (I01-R10 step 1)", () => {
    saveSourceRecord(db, "c1", rev(3, "v3"));
    const seq = readChangeSeq(db);
    expect(saveSourceRecord(db, "c1", rev(2, "other"))).toEqual({ status: "stale" });
    expect(saveSourceRecord(db, "c1", rev(2, "v3"))).toEqual({ status: "stale" });
    expect(rows()).toHaveLength(1);
    expect(readChangeSeq(db)).toBe(seq);
  });

  it("is stale for an older line already stored (C3 re-import) and rejects the same revision with other content", () => {
    saveSourceRecord(db, "c1", rev(1, "v1"));
    saveSourceRecord(db, "c1", rev(2, "v2"));
    expect(saveSourceRecord(db, "c1", rev(1, "v1"))).toEqual({ status: "stale" });
    expect(saveSourceRecord(db, "c1", rev(2, "other"))).toEqual({
      status: "rejected",
      code: "revision-conflict",
    });
    expect(rows()).toHaveLength(2);
  });

  it("stores a newer revision whose content goes back to an older version's (review A11)", () => {
    saveSourceRecord(db, "c1", rev(1, "x"));
    saveSourceRecord(db, "c1", rev(2, "y"));
    expect(saveSourceRecord(db, "c1", rev(3, "x"))).toEqual({
      status: "created",
      sourceId: 1,
      version: 3,
    });
    expect(rows()).toEqual([
      { version: 1, revision: 1, body: "x" },
      { version: 2, revision: 2, body: "y" },
      { version: 3, revision: 3, body: "x" },
    ]);
  });

  it("finds the latest version through the (source, version) index, not a sort (B-R2-S3)", () => {
    saveSourceRecord(db, "c1", rev(1, "v1"));
    saveSourceRecord(db, "c1", rev(2, "v2"));
    const plan = db
      .all(`EXPLAIN QUERY PLAN ${LATEST_VERSION_SQL}`, [1])
      .map((r) => String(r.detail))
      .join("\n");
    expect(plan).not.toMatch(/TEMP B-TREE/);
    expect(db.all(LATEST_VERSION_SQL, [1])).toMatchObject([{ version: 2, revision: 2 }]);
  });

  it("blocks a record the tombstone would block, before the trigger aborts the page", () => {
    saveSourceRecord(db, "c1", rev(1, "v1"));
    seedLegacyTombstone(db, {
      sourceId: 1,
      version: 1,
      at: "2026-11-21T00:00:00Z",
      reason: "source-deleted",
    });
    db.run("DELETE FROM source_versions");
    const seq = readChangeSeq(db);
    expect(saveSourceRecord(db, "c1", rev(2, "v2"))).toEqual({ status: "blocked" });
    expect(rows()).toEqual([]);
    expect(readChangeSeq(db)).toBe(seq);
  });
});

describe("connector instances and cursors", () => {
  it("starts without a cursor and stores the one written", () => {
    expect(readCursor(db, "c1")).toBeNull();
    writeCursor(db, "c1", "5");
    expect(readCursor(db, "c1")).toBe("5");
  });

  it("refuses to write a cursor for an unregistered instance", () => {
    expect(() => writeCursor(db, "ghost", "1")).toThrow(/ghost/);
  });

  it("records the kind once and refuses to rebind an instance to another kind", () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    expect(() => registerConnectorInstance(db, "c1", "site-mail")).toThrow(/site-mail/);
    expect(db.all("SELECT id, kind FROM connector_instances WHERE id = 'c1'")).toEqual([
      { id: "c1", kind: "test-fixtures" },
    ]);
  });
});

describe("readSourceVersion", () => {
  const versionId = () => db.all("SELECT max(id) AS id FROM source_versions")[0]?.id as number;

  it("returns title, body, access scope and the Connector kind it came from", () => {
    saveSourceRecord(db, "c1", record("e1", "제목", "본문"));
    db.run("UPDATE sources SET access_scope = 'team' WHERE external_id = 'e1'");
    expect(readSourceVersion(db, versionId())).toEqual({
      id: versionId(),
      title: "제목",
      body: "본문",
      accessScope: "team",
      connectorKind: "test-fixtures",
      scopeClaimed: false,
      configuredScope: null,
    });
  });

  it("returns whether the scope is a claim and the scope configured for the instance (I01-R15)", () => {
    saveSourceRecord(db, "c1", record("e1", "제목", "본문"));
    db.run("UPDATE sources SET scope_claimed = 1 WHERE external_id = 'e1'");
    setConfiguredScope(db, "c1", ["team", "all", "team"]);
    expect(readSourceVersion(db, versionId())).toMatchObject({
      scopeClaimed: true,
      configuredScope: ["all", "team"],
    });
  });

  it("reads a configured scope that is not a JSON array of strings as unknown", () => {
    saveSourceRecord(db, "c1", record("e1", "제목", "본문"));
    db.run("UPDATE connector_instances SET configured_scope = '[1]' WHERE id = 'c1'");
    expect(readSourceVersion(db, versionId())?.configuredScope).toBeNull();
  });

  it("returns undefined for a missing version", () => {
    expect(readSourceVersion(db, 404)).toBeUndefined();
  });
});

describe("configured scope (I01-R15)", () => {
  it("is set and cleared per instance, normalized, and setting a missing instance does nothing", () => {
    setConfiguredScope(db, "c1", ["b", "a", "b"]);
    const stored = () => db.all("SELECT id, configured_scope FROM connector_instances ORDER BY id");
    expect(stored()).toEqual([
      { id: "c1", configured_scope: '["a","b"]' },
      { id: "c2", configured_scope: null },
    ]);
    setConfiguredScope(db, "c1", null);
    setConfiguredScope(db, "missing", ["x"]);
    expect(stored()).toEqual([
      { id: "c1", configured_scope: null },
      { id: "c2", configured_scope: null },
    ]);
    expect(listConnectorInstanceIds(db)).toEqual(["c1", "c2"]);
  });
});

describe("rescan state (I01-R17)", () => {
  it("is false before a rescan, and for an instance never registered", () => {
    expect(readRescanState(db, "c1")).toEqual({ pending: false, deletionsMayBeMissed: false });
    expect(readRescanState(db, "never")).toEqual({ pending: false, deletionsMayBeMissed: false });
  });

  it("beginRescan drops the cursor and marks the rescan pending, finishRescan ends it and sets the mark as told", () => {
    writeCursor(db, "c1", "old");
    beginRescan(db, "c1", true);
    expect(readCursor(db, "c1")).toBeNull();
    expect(readRescanState(db, "c1")).toEqual({ pending: true, deletionsMayBeMissed: true });
    // the other instance is untouched
    expect(readRescanState(db, "c2")).toEqual({ pending: false, deletionsMayBeMissed: false });
    finishRescan(db, "c1", true);
    expect(readRescanState(db, "c1")).toEqual({ pending: false, deletionsMayBeMissed: true });
    beginRescan(db, "c1", false);
    finishRescan(db, "c1", false);
    expect(readRescanState(db, "c1")).toEqual({ pending: false, deletionsMayBeMissed: false });
  });

  it("beginRescan only raises the deletions mark: it stays until a rescan ends (R17)", () => {
    beginRescan(db, "c1", true);
    finishRescan(db, "c1", true);
    beginRescan(db, "c1", false);
    expect(readRescanState(db, "c1")).toEqual({ pending: true, deletionsMayBeMissed: true });
    finishRescan(db, "c1", false);
    expect(readRescanState(db, "c1")).toEqual({ pending: false, deletionsMayBeMissed: false });
  });

  it("refuses to mark an instance that is not registered", () => {
    expect(() => beginRescan(db, "never", true)).toThrow(/not registered/);
    expect(() => finishRescan(db, "never", true)).toThrow(/not registered/);
  });
});
