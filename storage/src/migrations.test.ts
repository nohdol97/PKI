// V01-R6: the migration runner owns the schema version; schema v1 holds the
// canonical tables and nothing that could carry a body or secret in history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./better-sqlite3-driver.ts";
import { migrate, migrations, schemaVersion } from "./migrations.ts";
import type { SqlDriver } from "./sql-driver.ts";

let db: SqlDriver;

beforeEach(() => {
  db = openBetterSqlite3(":memory:");
});

afterEach(() => {
  db.close();
});

function columns(table: string): string[] {
  return db
    .all(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)
    .map((r) => r.name as string);
}

function tables(): string[] {
  return db
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r.name as string);
}

describe("migrate", () => {
  it("brings a fresh database to v1 and records the version", () => {
    expect(schemaVersion(db)).toBe(0);
    migrate(db);
    expect(schemaVersion(db)).toBe(1);
    expect(migrations).toHaveLength(1);
  });

  it("is idempotent when re-run", () => {
    migrate(db);
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')");
    migrate(db);
    expect(schemaVersion(db)).toBe(1);
    expect(db.all("SELECT value FROM settings")).toEqual([{ value: "v" }]);
  });

  it("applies only the pending migrations", () => {
    const applied: number[] = [];
    const steps = [
      (d: SqlDriver) => {
        applied.push(1);
        d.exec("CREATE TABLE a (x)");
      },
      (d: SqlDriver) => {
        applied.push(2);
        d.exec("CREATE TABLE b (x)");
      },
    ];
    migrate(db, steps.slice(0, 1));
    migrate(db, steps);
    expect(applied).toEqual([1, 2]);
    expect(schemaVersion(db)).toBe(2);
  });

  it("leaves no partial schema and keeps the version when a migration fails", () => {
    const failing = [
      (d: SqlDriver) => {
        d.exec("CREATE TABLE half (x)");
        throw new Error("broken migration");
      },
    ];
    expect(() => migrate(db, failing)).toThrow("broken migration");
    expect(schemaVersion(db)).toBe(0);
    expect(tables()).toEqual([]);
  });

  it("refuses a database written by a newer schema", () => {
    db.exec("PRAGMA user_version = 99");
    expect(() => migrate(db)).toThrow(/newer/);
    expect(schemaVersion(db)).toBe(99);
  });
});

describe("schema v1", () => {
  beforeEach(() => migrate(db));

  it("has exactly the canonical tables and the keyword index", () => {
    expect(tables().filter((t) => !t.startsWith("keyword_index_"))).toEqual([
      "consents",
      "jobs",
      "keyword_index",
      "provider_calls",
      "settings",
      "source_versions",
      "sources",
    ]);
  });

  it("identifies a source by connector instance and external id", () => {
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c1', 'e1')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c2', 'e1')");
    expect(() =>
      db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c1', 'e1')"),
    ).toThrow(/UNIQUE/);
  });

  it("keeps the minimal job columns V01 needs (V02 adds lease and fence)", () => {
    expect(columns("jobs")).toEqual(["id", "kind", "source_version_id", "status"]);
    expect(() =>
      db.run(
        "INSERT INTO jobs (kind, source_version_id, status) VALUES ('extract', 404, 'queued')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("stores provider call history without body or secret columns", () => {
    expect(columns("provider_calls")).toEqual([
      "id",
      "request_id",
      "provider",
      "destination",
      "task_kind",
      "classification",
      "policy_version",
      "outcome",
      "duration_ms",
      "created_at",
    ]);
  });

  it("binds a consent to provider, destination and policy version", () => {
    expect(columns("consents")).toEqual([
      "id",
      "provider",
      "destination",
      "policy_version",
      "allowed_classes",
      "granted_at",
    ]);
  });

  it("never rewrites a stored source version", () => {
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    db.run(
      "INSERT INTO source_versions (source_id, content_hash, title, body) VALUES (1, 'h', 't', 'b')",
    );
    expect(() => db.run("UPDATE source_versions SET body = 'changed'")).toThrow(/immutable/);
    expect(db.all("SELECT body FROM source_versions")).toEqual([{ body: "b" }]);
  });
});
