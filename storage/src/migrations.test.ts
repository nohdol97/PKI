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
    expect(schemaVersion(db)).toBe(5);
    expect(migrations).toHaveLength(5);
  });

  it("is idempotent when re-run", () => {
    migrate(db);
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')");
    migrate(db);
    expect(schemaVersion(db)).toBe(5);
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
    expect(schemaVersion(db)).toBe(5);
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
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (404, 1, 'h', 't', 'b')",
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

describe("schema v4 (V01-T08)", () => {
  const insertV3Call = (attempt: number, outcome: string) =>
    db.run(
      `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
         classification, policy_version, outcome, duration_ms, created_at)
       VALUES ('r1', ?, 'codex', 'vendor:codex', 'extract', 'synthetic', 'pv', ?, 3, 't')`,
      [attempt, outcome],
    );
  const insertCall = (
    attempt: number,
    outcome: string,
    destination: string | null,
    policyVersion: string | null,
    reason: string | null,
  ) =>
    db.run(
      `INSERT INTO provider_calls (request_id, attempt, provider, destination, task_kind,
         classification, policy_version, outcome, reason, created_at)
       VALUES ('r2', ?, 'codex', ?, 'extract', 'synthetic', ?, ?, ?, 't')`,
      [attempt, destination, policyVersion, outcome, reason],
    );

  it("adds the blocked attempt's reason code to history, keeping v3 rows", () => {
    migrate(db, migrations.slice(0, 3));
    insertV3Call(1, "ok");
    insertV3Call(2, "blocked");
    migrate(db);
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
      "reason",
      "duration_ms",
      "created_at",
    ]);
    expect(db.all("SELECT attempt, outcome, reason, destination FROM provider_calls")).toEqual([
      { attempt: 1, outcome: "ok", reason: null, destination: "vendor:codex" },
      // a v3 row never had one: it says so instead of guessing
      { attempt: 2, outcome: "blocked", reason: "unrecorded", destination: "vendor:codex" },
    ]);
  });

  it("lets only an attempt that never ran lack destination and policy version", () => {
    migrate(db);
    insertCall(1, "blocked", null, null, "no-consent");
    insertCall(2, "budget-exhausted", "d", "pv", "budget-exhausted");
    insertCall(3, "ok", "d", "pv", null);
    expect(() => insertCall(4, "ok", null, "pv", null)).toThrow(/CHECK/);
    expect(() => insertCall(5, "timeout", "d", null, null)).toThrow(/CHECK/);
    expect(() => insertCall(6, "budget-exhausted", null, null, "budget-exhausted")).toThrow(
      /CHECK/,
    );
    expect(() => insertCall(7, "blocked", null, null, null)).toThrow(/CHECK/);
    expect(() => insertCall(8, "ok", "d", "pv", "no-consent")).toThrow(/CHECK/);
    expect(() => insertCall(3, "ok", "d", "pv", null)).toThrow(/UNIQUE/);
    for (const col of ["classification", "attempt", "outcome", "provider"]) {
      expect(notNull("provider_calls", col)).toBe(true);
    }
  });

  it("keeps one consent per Provider, the latest of a v3 database", () => {
    migrate(db, migrations.slice(0, 3));
    const grant = (provider: string, version: string) =>
      db.run(
        `INSERT INTO consents (provider, destination, policy_version, allowed_classes, granted_at)
         VALUES (?, 'd', ?, '[]', 't')`,
        [provider, version],
      );
    grant("codex", "old");
    grant("codex", "new");
    grant("claude-code", "only");
    migrate(db);
    expect(db.all("SELECT provider, policy_version FROM consents ORDER BY provider")).toEqual([
      { provider: "claude-code", policy_version: "only" },
      { provider: "codex", policy_version: "new" },
    ]);
    expect(() => grant("codex", "again")).toThrow(/UNIQUE/);
  });
});

describe("schema v5 (V02-T02, the V02 spec's knowledge schema)", () => {
  // A v4 database with two versions of one source, one of another, and a V01 job.
  function seedV4(): void {
    migrate(db, migrations.slice(0, 4));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run(
      "INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a'), ('c', 'b')",
    );
    db.run(
      `INSERT INTO source_versions (source_id, content_hash, title, body)
       VALUES (1, 'h1', 'a1', 'alpha one'), (2, 'h2', 'b1', 'beta'), (1, 'h3', 'a2', 'alpha two')`,
    );
    db.run("INSERT INTO jobs (kind, source_version_id, status) VALUES ('extract', 3, 'queued')");
  }

  it("upgrades a v4 database in place: versions numbered per source, jobs fenced", () => {
    seedV4();
    migrate(db);
    expect(schemaVersion(db)).toBe(5);
    expect(db.all("SELECT id, source_id, version, title, body FROM source_versions")).toEqual([
      { id: 1, source_id: 1, version: 1, title: "a1", body: "alpha one" },
      { id: 2, source_id: 2, version: 1, title: "b1", body: "beta" },
      { id: 3, source_id: 1, version: 2, title: "a2", body: "alpha two" },
    ]);
    expect(
      db.all("SELECT id, kind, source_id, fence_version, status, lease_until FROM jobs"),
    ).toEqual([
      {
        id: 1,
        kind: "extract",
        source_id: 1,
        fence_version: 2,
        status: "queued",
        lease_until: null,
      },
    ]);
    // every stored version so far was one source change
    expect(db.all("SELECT change_seq, knowledge_revision FROM revisions")).toEqual([
      { change_seq: 3, knowledge_revision: 0 },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("keeps the keyword index and immutability wiring of the rebuilt source versions", () => {
    seedV4();
    migrate(db);
    expect(
      db.all("SELECT rowid FROM keyword_index WHERE keyword_index MATCH 'alpha' ORDER BY rowid"),
    ).toEqual([{ rowid: 1 }, { rowid: 3 }]);
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (2, 2, 'h4', 'b2', 'gamma')",
    );
    expect(db.all("SELECT rowid FROM keyword_index WHERE keyword_index MATCH 'gamma'")).toEqual([
      { rowid: 4 },
    ]);
    db.run("DELETE FROM source_versions WHERE id = 4");
    expect(db.all("SELECT rowid FROM keyword_index WHERE keyword_index MATCH 'gamma'")).toEqual([]);
    expect(() => db.run("UPDATE source_versions SET body = 'x' WHERE id = 1")).toThrow(/immutable/);
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (404, 1, 'h', 't', 'b')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("only lets a source gain a version greater than its latest", () => {
    seedV4();
    migrate(db);
    const add = (version: number) =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, ?, 'h', 't', 'b')",
        [version],
      );
    expect(() => add(2)).toThrow();
    expect(() => add(1)).toThrow(/greater/);
    add(5);
    expect(notNull("source_versions", "version")).toBe(true);
  });

  it("never reuses a version number at or below the source's tombstone (V02-R12)", () => {
    seedV4();
    migrate(db);
    db.run("DELETE FROM jobs");
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    db.run("INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 2, 't', 'deleted')");
    const add = (version: number) =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, ?, 'h', 't', 'b')",
        [version],
      );
    expect(() => add(1)).toThrow(/tombstone/);
    expect(() => add(2)).toThrow(/tombstone/);
    add(3);
    expect(db.all("SELECT version FROM source_versions WHERE source_id = 1")).toEqual([
      { version: 3 },
    ]);
  });

  it("applies a tombstone only to its own source", () => {
    seedV4();
    migrate(db);
    db.run("INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 2, 't', 'deleted')");
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (2, 2, 'h', 't', 'b')",
    );
    expect(db.all("SELECT version FROM source_versions WHERE source_id = 2 ORDER BY id")).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
  });

  it("never reuses a source version id, even after the highest is deleted", () => {
    seedV4();
    migrate(db);
    db.run("DELETE FROM jobs");
    db.run("DELETE FROM source_versions WHERE id = 3");
    const { lastInsertRowid } = db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (2, 2, 'h', 't', 'b')",
    );
    expect(lastInsertRowid).toBe(4);
  });

  it("adds the knowledge, Insight and tombstone tables", () => {
    migrate(db);
    expect(tables().filter((t) => !t.startsWith("keyword_index_"))).toEqual([
      "connector_instances",
      "consents",
      "evidence",
      "facts",
      "insight_evidence",
      "insights",
      "items",
      "jobs",
      "keyword_index",
      "provider_calls",
      "relations",
      "revisions",
      "settings",
      "source_versions",
      "sources",
      "tombstones",
    ]);
    const attributes = ["epistemic", "status", "valid_at", "observed_at"];
    expect(columns("items")).toEqual(["id", "type", "name", ...attributes]);
    expect(columns("facts")).toEqual(["id", "item_id", "kind", "value", ...attributes]);
    expect(columns("relations")).toEqual(["id", "subject_id", "type", "object_id", ...attributes]);
    expect(columns("evidence")).toEqual([
      "id",
      "source_version_id",
      "fact_id",
      "relation_id",
      "start_offset",
      "end_offset",
      "quote",
    ]);
    // R12: a tombstone holds no content
    expect(columns("tombstones")).toEqual(["source_id", "version", "at", "reason"]);
    expect(columns("insights")).toEqual([
      "id",
      "rule",
      "x_item_id",
      "y_item_id",
      "epistemic",
      "state",
      "summary",
    ]);
  });

  it("registers a job once per kind, source and fence version", () => {
    seedV4();
    migrate(db);
    expect(() =>
      db.run(
        "INSERT INTO jobs (kind, source_id, fence_version, status) VALUES ('extract', 1, 2, 'queued')",
      ),
    ).toThrow(/UNIQUE/);
    db.run(
      "INSERT INTO jobs (kind, source_id, fence_version, status) VALUES ('extract', 2, 1, 'queued')",
    );
  });

  it("keeps a job after its source's versions are deleted, so the fence can close it", () => {
    seedV4();
    migrate(db);
    db.run("DELETE FROM source_versions WHERE source_id = 1");
    expect(db.all("SELECT source_id, fence_version FROM jobs")).toEqual([
      { source_id: 1, fence_version: 2 },
    ]);
  });
});
