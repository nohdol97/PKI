// V01-R6 job records: the Broker reads a job to decide that a call is background.
// V02-R3: a job carries its source and the version it was registered for (the fence).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { readJob } from "./jobs.ts";
import { migrate } from "./migrations.ts";
import { registerConnectorInstance, saveSourceRecord } from "./sources.ts";
import type { SqlDriver } from "./sql-driver.ts";

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

describe("readJob", () => {
  it("returns a stored job's kind, source, fence version, status and lease", () => {
    const { lastInsertRowid } = db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, lease_until)
       VALUES ('extract', 1, 1, 'queued', '2026-11-21T00:05:00Z')`,
    );
    expect(readJob(db, lastInsertRowid)).toEqual({
      id: lastInsertRowid,
      kind: "extract",
      sourceId: 1,
      fenceVersion: 1,
      status: "queued",
      leaseUntil: "2026-11-21T00:05:00Z",
    });
  });

  it("returns undefined for a missing job", () => {
    expect(readJob(db, 404)).toBeUndefined();
  });
});
