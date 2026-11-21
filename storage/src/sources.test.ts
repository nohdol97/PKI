// V01-R7 source storage: identity is connector instance + external id, the same
// content makes no new version, and each instance keeps its kind and cursor.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
import { migrate } from "./migrations.ts";
import {
  contentHash,
  readCursor,
  registerConnectorInstance,
  saveSourceRecord,
  writeCursor,
} from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
  migrate(db);
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
  it("creates a source and its first version", () => {
    expect(saveSourceRecord(db, "c1", record("e1"))).toBe("created");
    expect(db.all("SELECT title, body, content_hash FROM source_versions")).toEqual([
      { title: "t", body: "b", content_hash: contentHash("t", "b") },
    ]);
  });

  it("makes no new version when the content hash is unchanged", () => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c1", record("e1"))).toBe("unchanged");
    expect([count("sources"), count("source_versions")]).toEqual([1, 1]);
  });

  it.each([
    ["title", record("e1", "t2", "b")],
    ["body", record("e1", "t", "b2")],
  ])("adds a version when the %s changes, keeping the old one", (_part, changed) => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c1", changed)).toBe("created");
    expect([count("sources"), count("source_versions")]).toEqual([1, 2]);
  });

  it("compares with the latest version, so reverting content is a new version", () => {
    saveSourceRecord(db, "c1", record("e1", "t", "v1"));
    saveSourceRecord(db, "c1", record("e1", "t", "v2"));
    expect(saveSourceRecord(db, "c1", record("e1", "t", "v1"))).toBe("created");
    expect(count("source_versions")).toBe(3);
  });

  it("keeps the same content from different instances or external ids apart", () => {
    saveSourceRecord(db, "c1", record("e1"));
    expect(saveSourceRecord(db, "c2", record("e1"))).toBe("created");
    expect(saveSourceRecord(db, "c1", record("e2"))).toBe("created");
    expect([count("sources"), count("source_versions")]).toEqual([3, 3]);
  });
});

describe("connector instances and cursors", () => {
  it("starts without a cursor and stores the one written", () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    expect(readCursor(db, "c1")).toBeNull();
    writeCursor(db, "c1", "5");
    expect(readCursor(db, "c1")).toBe("5");
  });

  it("refuses to write a cursor for an unregistered instance", () => {
    expect(() => writeCursor(db, "ghost", "1")).toThrow(/ghost/);
  });

  it("records the kind once and refuses to rebind an instance to another kind", () => {
    registerConnectorInstance(db, "c1", "test-fixtures");
    registerConnectorInstance(db, "c1", "test-fixtures");
    expect(() => registerConnectorInstance(db, "c1", "site-mail")).toThrow(/site-mail/);
    expect(db.all("SELECT id, kind FROM connector_instances")).toEqual([
      { id: "c1", kind: "test-fixtures" },
    ]);
  });
});
