// V01-R6 job records: the Broker reads a job to decide that a call is background.
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
  it("returns a stored job's kind, target version and status", () => {
    const { lastInsertRowid } = db.run(
      "INSERT INTO jobs (kind, source_version_id, status) VALUES ('extract', 1, 'queued')",
    );
    expect(readJob(db, lastInsertRowid)).toEqual({
      id: lastInsertRowid,
      kind: "extract",
      sourceVersionId: 1,
      status: "queued",
    });
  });

  it("returns undefined for a missing job", () => {
    expect(readJob(db, 404)).toBeUndefined();
  });
});
