// V01-R6: the migration runner owns the schema version; schema v1 holds the
// canonical tables and nothing that could carry a body or secret in history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
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

function notNull(table: string, column: string): boolean {
  return (
    db.all(`SELECT "notnull" AS n FROM pragma_table_info('${table}') WHERE name = ?`, [column])[0]
      ?.n === 1
  );
}

function tables(): string[] {
  return db
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => r.name as string);
}

describe("migrate", () => {
  it("brings a fresh database to the latest version and records it", () => {
    expect(schemaVersion(db)).toBe(0);
    migrate(db);
    expect(schemaVersion(db)).toBe(3);
    expect(migrations).toHaveLength(3);
  });

  it("is idempotent when re-run", () => {
    migrate(db);
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')");
    migrate(db);
    expect(schemaVersion(db)).toBe(3);
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
  beforeEach(() => migrate(db, migrations.slice(0, 1)));

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
      "attempt",
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

  it("records each attempt of a request once, with its audit fields required", () => {
    const insert = (attempt: number, destination: string | null) =>
      db.run(
        `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
           classification, policy_version, outcome, created_at)
         VALUES ('r1', ?, 'p', ?, 'extract', 'synthetic', 'pv', 'ok', 't')`,
        [attempt, destination],
      );
    insert(1, "host");
    insert(2, "host");
    expect(() => insert(2, "host")).toThrow(/UNIQUE/);
    expect(() => insert(3, null)).toThrow(/NOT NULL/);
    for (const col of ["destination", "classification", "policy_version", "attempt"]) {
      expect(notNull("provider_calls", col)).toBe(true);
    }
    expect(notNull("provider_calls", "duration_ms")).toBe(false);
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

describe("schema v2 (V01-T04)", () => {
  it("upgrades a v1 database in place, keeping its rows", () => {
    migrate(db, migrations.slice(0, 1));
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    db.run(
      "INSERT INTO source_versions (source_id, content_hash, title, body) VALUES (1, 'h', 't', 'b')",
    );
    migrate(db);
    expect(schemaVersion(db)).toBe(3);
    expect(db.all("SELECT id, external_id FROM sources")).toEqual([{ id: 1, external_id: "e" }]);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: 1 }]);
    // A v1 source has no recorded kind; "unknown" is no upstream kind, so it never grades synthetic.
    expect(db.all("SELECT id, kind FROM connector_instances")).toEqual([
      { id: "c", kind: "unknown" },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("ties every source to a registered Connector instance", () => {
    migrate(db);
    expect(() =>
      db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('ghost', 'e')"),
    ).toThrow(/FOREIGN KEY/);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    expect(() =>
      db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')"),
    ).toThrow(/UNIQUE/);
  });

  it("keeps the source version and keyword index wiring after rebuilding sources", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, content_hash, title, body) VALUES (404, 'h', 't', 'b')",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(db.all("SELECT sql FROM sqlite_schema WHERE name = 'source_versions'")[0]?.sql).toMatch(
      /REFERENCES "?sources"?/,
    );
  });

  it("adds connector instances holding kind and cursor", () => {
    migrate(db);
    expect(columns("connector_instances")).toEqual(["id", "kind", "cursor"]);
    expect(notNull("connector_instances", "kind")).toBe(true);
    expect(notNull("connector_instances", "cursor")).toBe(false);
  });
});

describe("schema v3 (V01-T07)", () => {
  it("adds an optional access scope to sources, keeping v2 rows", () => {
    migrate(db, migrations.slice(0, 2));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    migrate(db);
    expect(columns("sources")).toEqual([
      "id",
      "connector_instance_id",
      "external_id",
      "access_scope",
    ]);
    expect(notNull("sources", "access_scope")).toBe(false);
    expect(db.all("SELECT external_id, access_scope FROM sources")).toEqual([
      { external_id: "e", access_scope: null },
    ]);
  });
});
