// V01-R6: the migration runner owns the schema version; schema v1 holds the
// canonical tables and nothing that could carry a body or secret in history.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBetterSqlite3 } from "./adapters/better-sqlite3-driver.ts";
import { leaseNextJob, readJob } from "./jobs.ts";
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
    expect(schemaVersion(db)).toBe(21);
    expect(migrations).toHaveLength(21);
  });

  it("is idempotent when re-run", () => {
    migrate(db);
    db.run("INSERT INTO settings (key, value) VALUES ('k', 'v')");
    migrate(db);
    expect(schemaVersion(db)).toBe(migrations.length);
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
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(db.all("SELECT id, external_id FROM sources")).toEqual([{ id: 1, external_id: "e" }]);
    expect(db.all("SELECT source_id FROM source_versions")).toEqual([{ source_id: 1 }]);
    // A v1 source has no recorded kind; "unknown" is no upstream kind, so it never grades synthetic.
    expect(db.all("SELECT id, kind FROM connector_instances")).toEqual([
      { id: "c", kind: "unknown" },
    ]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("ties every source to a registered Connector instance", () => {
    migrate(db, migrations.slice(0, 2));
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
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')",
    );
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
    expect(columns("connector_instances")).toEqual([
      "id",
      "kind",
      "cursor",
      "rescan_pending", // v17
      "deletions_may_be_missed", // v17
      "configured_scope", // v19
    ]);
    expect(notNull("connector_instances", "kind")).toBe(true);
    expect(notNull("connector_instances", "cursor")).toBe(false);
  });
});

describe("schema v3 (V01-T07)", () => {
  it("adds an optional access scope to sources, keeping v2 rows", () => {
    migrate(db, migrations.slice(0, 2));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'e')");
    migrate(db, migrations.slice(0, 3));
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
    expect(schemaVersion(db)).toBe(migrations.length);
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
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (1, 2, 't', 'user-deleted')",
    );
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
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (1, 2, 't', 'user-deleted')",
    );
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
      "fact_history",
      "facts",
      "identity_key",
      "insight_evidence",
      "insight_user_inputs",
      "insights",
      "invalidations",
      "item_history",
      "items",
      "jobs",
      "keyword_index",
      "ontology_basis",
      "ontology_elements",
      "ontology_history",
      "provider_calls",
      "relation_history",
      "relations",
      "revisions",
      "schedules",
      "scope_policy_drops",
      "settings",
      "source_versions",
      "sources",
      "tombstones",
    ]);
    const attributes = ["epistemic", "status", "valid_at", "observed_at"];
    // v20 (S01-T01) added confidence and user_authored to all three, and context to facts
    const registry = ["confidence", "user_authored"];
    expect(columns("items")).toEqual(["id", "type", "name", ...attributes, ...registry]);
    expect(columns("facts")).toEqual([
      "id",
      "item_id",
      "kind",
      "value",
      ...attributes,
      ...registry,
      "context",
    ]);
    expect(columns("relations")).toEqual([
      "id",
      "subject_id",
      "type",
      "object_id",
      ...attributes,
      ...registry,
    ]);
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
    expect(columns("tombstones")).toEqual([
      "source_id",
      "covers_version",
      "last_revision",
      "at",
      "reason",
      "lifted_at",
    ]);
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
    migrate(db, migrations.slice(0, 5));
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

describe("schema v6 (V02-T03)", () => {
  it("adds the reason a job was held or failed and its lease token to a v5 database, keeping its jobs", () => {
    migrate(db, migrations.slice(0, 5));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
    db.run(
      "INSERT INTO jobs (kind, source_id, fence_version, status, lease_until) VALUES ('extract', 1, 1, 'leased', 'L')",
    );
    migrate(db, migrations.slice(0, 6));
    expect(schemaVersion(db)).toBe(6);
    expect(columns("jobs")).toEqual([
      "id",
      "kind",
      "source_id",
      "fence_version",
      "status",
      "lease_until",
      "reason",
      "lease_token",
    ]);
    expect(db.all("SELECT status, lease_until, reason, lease_token FROM jobs")).toEqual([
      { status: "leased", lease_until: "L", reason: null, lease_token: 0 },
    ]);
  });
});

describe("schema v7 (V02-T04)", () => {
  it("adds the Connector's own revision to a v6 database's versions, null for the old rows", () => {
    migrate(db, migrations.slice(0, 6));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 1, 'h', 't', 'b')",
    );
    migrate(db, migrations.slice(0, 7));
    expect(schemaVersion(db)).toBe(7);
    expect(columns("source_versions")).toEqual([
      "id",
      "source_id",
      "version",
      "content_hash",
      "title",
      "body",
      "revision",
    ]);
    expect(db.all("SELECT version, revision FROM source_versions")).toEqual([
      { version: 1, revision: null },
    ]);
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body, revision) VALUES (1, 2, 'h2', 't', 'b', 0)",
      ),
    ).toThrow(/CHECK/);
  });
});

describe("schema v8 (V02-T05)", () => {
  it("adds the extraction's dropped counts to a v7 database's jobs, null for the old rows", () => {
    migrate(db, migrations.slice(0, 7));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
    db.run(
      "INSERT INTO jobs (kind, source_id, fence_version, status) VALUES ('extract', 1, 1, 'done')",
    );
    migrate(db, migrations.slice(0, 8));
    expect(schemaVersion(db)).toBe(8);
    expect(columns("jobs").slice(-2)).toEqual(["dropped_quotes", "dropped_other"]);
    expect(db.all("SELECT dropped_quotes, dropped_other FROM jobs")).toEqual([
      { dropped_quotes: null, dropped_other: null },
    ]);
    expect(() => db.run("UPDATE jobs SET dropped_quotes = -1")).toThrow(/CHECK/);
  });
});

describe("schema v9 (V02-T08)", () => {
  const seedV8 = () => {
    migrate(db, migrations.slice(0, 8));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'b')");
    db.run("INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 2, 't', 'deleted')");
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (2, 1, 't', 'access-revoked')",
    );
  };

  it("keeps a v8 database's tombstones, a `deleted` one as `user-deleted`", () => {
    seedV8();
    migrate(db, migrations.slice(0, 9));
    expect(schemaVersion(db)).toBe(9);
    expect(
      db.all("SELECT source_id, version, at, reason FROM tombstones ORDER BY source_id"),
    ).toEqual([
      { source_id: 1, version: 2, at: "t", reason: "user-deleted" },
      { source_id: 2, version: 1, at: "t", reason: "access-revoked" },
    ]);
    expect(columns("tombstones")).toEqual(["source_id", "version", "at", "reason"]);
  });

  it("takes the three agreed reasons and no other", () => {
    seedV8();
    migrate(db, migrations.slice(0, 9));
    db.run("DELETE FROM tombstones");
    for (const reason of ["user-deleted", "source-deleted", "access-revoked"]) {
      db.run("INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 1, 't', ?)", [
        reason,
      ]);
      db.run("DELETE FROM tombstones");
    }
    expect(() =>
      db.run(
        "INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 1, 't', 'deleted')",
      ),
    ).toThrow(/CHECK/);
  });

  it("keeps the tombstone's change sequence and version-blocking wiring", () => {
    seedV8();
    migrate(db, migrations.slice(0, 9));
    const seq = () => db.all("SELECT change_seq FROM revisions")[0]?.change_seq;
    const before = seq() as number;
    db.run("UPDATE tombstones SET version = 3 WHERE source_id = 1");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'n')");
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (3, 1, 't', 'source-deleted')",
    );
    expect(seq()).toBe(before + 2);
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 3, 'h', 't', 'b')",
      ),
    ).toThrow(/tombstone/);
  });

  it("turns on the keyword index's secure-delete", () => {
    migrate(db, migrations.slice(0, 9));
    expect(db.all("SELECT v FROM keyword_index_config WHERE k = 'secure-delete'")).toEqual([
      { v: 1 },
    ]);
  });
});

describe("schema v10 (I04-T01)", () => {
  it("adds the invalidation records, holding counts and no content column", () => {
    migrate(db, migrations.slice(0, 9));
    expect(tables()).not.toContain("invalidations");
    migrate(db, migrations.slice(0, 10));
    expect(columns("invalidations")).toEqual([
      "id",
      "change_seq",
      "source_id",
      "change_kind",
      "removed_by_kind",
      "recomputed_by_kind",
      "at",
    ]);
  });

  it("never reuses a record id", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'a')",
    );
    const insert = () =>
      db.run(
        "INSERT INTO invalidations (change_seq, source_id, change_kind, at) VALUES (1, 1, 'user-deleted', 't')",
      ).lastInsertRowid;
    const first = insert();
    db.run("DELETE FROM invalidations");
    expect(insert()).toBe(first + 1);
  });
});

describe("schema v11 (I03-T01, I03-R2)", () => {
  const T_LEASE_PAST = "2026-11-21T10:00:00.123Z";
  const T_LEASE_FUTURE = "2999-01-01T00:00:00.000Z";

  // A v10 database (V02-T03's jobs, I04-T01's invalidations) with one job of each status, two sources on two instances.
  function seedV10(): void {
    migrate(db, migrations.slice(0, 10));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('d', 'jsonl-import')");
    db.run(
      "INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a'), ('d', 'b')",
    );
    db.run(
      `INSERT INTO source_versions (source_id, version, content_hash, title, body)
       VALUES (1, 1, 'h1', 't', 'b'), (2, 1, 'h2', 't', 'b')`,
    );
    const job = (status: string, source: number, extra: Record<string, unknown> = {}) =>
      db.run(
        `INSERT INTO jobs (kind, source_id, fence_version, status, lease_until, reason, lease_token,
           dropped_quotes, dropped_other)
         VALUES ('extract', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          source,
          (extra.fence as number | undefined) ?? 1,
          status,
          (extra.leaseUntil as string | undefined) ?? null,
          (extra.reason as string | undefined) ?? null,
          (extra.token as number | undefined) ?? 0,
          (extra.quotes as number | undefined) ?? null,
          (extra.other as number | undefined) ?? null,
        ],
      );
    job("queued", 1, { fence: 1 });
    job("leased", 1, { fence: 2, leaseUntil: T_LEASE_PAST, token: 3 });
    job("leased", 1, { fence: 3, leaseUntil: T_LEASE_FUTURE, token: 1 });
    job("done", 1, { fence: 4, token: 2, quotes: 1, other: 0 });
    job("failed", 1, { fence: 5, reason: "invalid-output", token: 1 });
    job("held", 2, { fence: 1, reason: "no-consent", token: 1 });
    job("held", 2, { fence: 2, reason: "source-too-large", token: 1 });
    job("superseded", 2, { fence: 3, token: 1 });
    db.run("INSERT INTO settings (key, value) VALUES ('jobs.held-policy-version', 'p1')");
  }

  const rows = () =>
    db.all(
      `SELECT id, kind, target, source_id, fence_version, status, reason, attempts, lease_token,
              lease_until, lease_owner, priority, fairness_key, schedule_id, slot,
              policy_fingerprint, cancel_requested, finished_at IS NOT NULL AS finished,
              dropped_quotes, dropped_other
         FROM jobs ORDER BY id`,
    );

  it("jobs.migration: keeps queued, held and superseded jobs with their source and fence, target empty", () => {
    seedV10();
    migrate(db, migrations.slice(0, 11));
    expect(schemaVersion(db)).toBe(11);
    const kept = rows().filter((r) =>
      ["queued", "held", "superseded"].includes(r.status as string),
    );
    expect(kept.map((r) => [r.status, r.source_id, r.fence_version, r.target])).toEqual([
      ["queued", 1, 1, ""],
      ["held", 2, 1, ""],
      ["held", 2, 2, ""],
      ["superseded", 2, 3, ""],
    ]);
  });

  it("jobs.migration-v02-status: renames the statuses, keeps reasons and fills the new columns", () => {
    seedV10();
    const seq = db.all("SELECT change_seq FROM revisions")[0]?.change_seq;
    const before = Date.now();
    migrate(db);
    const after = Date.now();
    expect(rows()).toEqual(
      [
        ["queued", null, 0, null, "c", 0],
        ["running", null, 3, Date.parse(T_LEASE_PAST), "c", 0],
        ["running", null, 1, Date.parse(T_LEASE_FUTURE), "c", 0],
        ["succeeded", null, 2, null, "c", 1],
        ["dead_letter", "invalid-output", 1, null, "c", 1],
        ["held", "no-consent", 1, null, "d", 0],
        ["held", "source-too-large", 1, null, "d", 0],
        ["superseded", null, 1, null, "d", 1],
      ].map(([status, reason, token, leaseUntil, fairness, finished], i) => ({
        id: i + 1,
        kind: "extract",
        target: "",
        source_id: i < 5 ? 1 : 2,
        fence_version: [1, 2, 3, 4, 5, 1, 2, 3][i],
        status,
        reason,
        attempts: 0,
        lease_token: token,
        lease_until: leaseUntil,
        lease_owner: null,
        priority: "user",
        fairness_key: fairness,
        schedule_id: null,
        slot: null,
        policy_fingerprint: null,
        cancel_requested: 0,
        finished,
        dropped_quotes: i === 3 ? 1 : null,
        dropped_other: i === 3 ? 0 : null,
      })),
    );
    for (const r of db.all(
      "SELECT registered_change_seq, created_at, updated_at, run_after, finished_at FROM jobs",
    )) {
      expect(r.registered_change_seq).toBe(seq);
      for (const t of [r.created_at, r.updated_at, r.run_after]) {
        expect(t).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
        expect(t).toBeLessThanOrEqual(after);
      }
      if (r.finished_at !== null) expect(r.finished_at).toBe(r.updated_at);
    }
  });

  it("jobs.migration-v02-status: compares the converted lease as a number (an ISO string would never expire)", () => {
    seedV10();
    migrate(db);
    // the product's claim reclaims the lease that ran out (token 3 -> 4) and not
    // the one still running. It claims nothing: job 3 still runs, and one
    // knowledge job runs at a time (I03-R13, T05). The lease is long
    // enough to reach the running one's end: one further ahead than a lease is a
    // clock that went back, and reclaimed too (I03-R5, T03)
    const now = new Date("2027-01-01T00:00:00.000Z");
    const claimed = leaseNextJob(db, {
      kinds: ["extract"],
      now,
      leaseMs: Date.parse(T_LEASE_FUTURE) - now.getTime(),
    });
    expect(claimed).toBeUndefined();
    expect(readJob(db, 1)).toMatchObject({ status: "queued" });
    expect(readJob(db, 2)).toMatchObject({ status: "queued", leaseToken: 4, leaseUntil: null });
    expect(readJob(db, 3)).toMatchObject({
      status: "running",
      leaseToken: 1,
      leaseUntil: Date.parse(T_LEASE_FUTURE),
    });
  });

  it("v10 copies every job row: one whose source row is gone is kept, or the migration fails whole", () => {
    seedV10();
    db.exec("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, lease_token)
       VALUES ('extract', 404, 1, 'queued', 2)`,
    );
    const jobs = db.all("SELECT count(*) AS n FROM jobs")[0]?.n;
    db.exec("PRAGMA foreign_keys = ON");
    // enforced foreign keys refuse the orphan: nothing is copied, nothing lost
    expect(() => migrate(db)).toThrow(/FOREIGN KEY/);
    expect(schemaVersion(db)).toBe(10);
    expect(db.all("SELECT count(*) AS n FROM jobs")[0]?.n).toBe(jobs);
    // a driver without them keeps the row, its fairness key falling back to the kind
    db.exec("PRAGMA foreign_keys = OFF");
    migrate(db);
    expect(db.all("SELECT count(*) AS n FROM jobs")[0]?.n).toBe(jobs);
    expect(
      db.all("SELECT source_id, fairness_key, lease_token FROM jobs WHERE source_id = 404"),
    ).toEqual([{ source_id: 404, fairness_key: "extract", lease_token: 2 }]);
  });

  it("jobs.migration-v02-status: forgets the policy version held jobs were judged under, so the first start judges them once", () => {
    seedV10();
    migrate(db);
    expect(db.all("SELECT * FROM settings WHERE key = 'jobs.held-policy-version'")).toEqual([]);
  });

  it("guards the status list, the source a fenced kind needs and the three duplicate keys", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'a')",
    );
    const insert = (values: string) =>
      db.run(
        `INSERT INTO jobs (kind, target, source_id, fence_version, status, schedule_id, slot,
           run_after, fairness_key, registered_change_seq, created_at, updated_at)
         VALUES (${values}, 0, 'k', 0, 0, 0)`,
      );
    insert("'extract', '', 1, 1, 'queued', NULL, NULL");
    expect(() => insert("'extract', '', 1, 1, 'queued', NULL, NULL")).toThrow(/UNIQUE/);
    insert("'extract', 'other', 1, 1, 'queued', NULL, NULL");
    expect(() => insert("'extract', '', 1, 2, 'leased', NULL, NULL")).toThrow(/CHECK/);
    expect(() => insert("'extract', '', NULL, NULL, 'queued', NULL, NULL")).toThrow(/CHECK/);
    insert("'connector-sync', 'c', NULL, NULL, 'queued', 5, 1");
    expect(() => insert("'connector-sync', 'c', NULL, NULL, 'succeeded', 5, 1")).toThrow(/UNIQUE/);
    expect(() => insert("'maintenance', '', NULL, NULL, 'queued', 5, 2")).toThrow(/UNIQUE/);
    expect(() => insert("'connector-sync', 'c', NULL, NULL, 'held', NULL, NULL")).toThrow(/UNIQUE/);
    insert("'connector-sync', 'c', NULL, NULL, 'succeeded', NULL, NULL");
    expect(() => insert("'maintenance', '', NULL, NULL, 'queued', 6, NULL")).toThrow(/CHECK/);
  });
});

describe("schema v12 (I01-T01)", () => {
  const seedV11 = () => {
    migrate(db, migrations.slice(0, 11));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run(
      "INSERT INTO sources (connector_instance_id, external_id, access_scope) VALUES ('c', 'a', '[\"t\"]')",
    );
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'b')");
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body, revision) VALUES (1, 1, 'h', 't', 'b', 4)",
    );
    db.run(
      `INSERT INTO jobs (kind, source_id, fence_version, status, run_after, fairness_key,
         registered_change_seq, created_at, updated_at)
       VALUES ('extract', 1, 1, 'succeeded', 0, 'c', 0, 0, 0)`,
    );
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (2, 1, 't', 'source-deleted')",
    );
    db.run(
      "INSERT INTO invalidations (change_seq, source_id, change_kind, at) VALUES (1, 2, 'source-deleted', 't')",
    );
  };

  it("puts a v11 database's sources in the empty namespace, keeping ids and references", () => {
    seedV11();
    migrate(db, migrations.slice(0, 12));
    expect(schemaVersion(db)).toBe(12);
    expect(columns("sources")).toEqual([
      "id",
      "connector_instance_id",
      "namespace",
      "external_id",
      "access_scope",
    ]);
    expect(
      db.all("SELECT id, connector_instance_id, namespace, external_id, access_scope FROM sources"),
    ).toEqual([
      { id: 1, connector_instance_id: "c", namespace: "", external_id: "a", access_scope: '["t"]' },
      { id: 2, connector_instance_id: "c", namespace: "", external_id: "b", access_scope: null },
    ]);
    expect(db.all("SELECT source_id, revision FROM source_versions")).toEqual([
      { source_id: 1, revision: 4 },
    ]);
    expect(db.all("SELECT kind, source_id, fence_version, status, fairness_key FROM jobs")).toEqual(
      [{ kind: "extract", source_id: 1, fence_version: 1, status: "succeeded", fairness_key: "c" }],
    );
    expect(db.all("SELECT source_id FROM tombstones")).toEqual([{ source_id: 2 }]);
    expect(db.all("SELECT source_id FROM invalidations")).toEqual([{ source_id: 2 }]);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("identifies a source by instance, namespace and external id (I01-R8)", () => {
    seedV11();
    migrate(db);
    expect(notNull("sources", "namespace")).toBe(true);
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', 'n', 'a')",
    );
    expect(() =>
      db.run(
        "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', 'n', 'a')",
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'z')"),
    ).toThrow(/NOT NULL/);
    expect(() =>
      db.run(
        "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('ghost', '', 'a')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("keeps the tables that reference sources tied to it after the rebuild", () => {
    seedV11();
    migrate(db);
    for (const table of ["source_versions", "jobs", "tombstones", "invalidations"]) {
      expect(db.all("SELECT sql FROM sqlite_schema WHERE name = ?", [table])[0]?.sql).toMatch(
        /REFERENCES "?sources"? \(id\)/,
      );
    }
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (404, 1, 'h', 't', 'b')",
      ),
    ).toThrow(/FOREIGN KEY/);
    // The version-blocking trigger still reads the tombstone of the kept source id.
    expect(() =>
      db.run(
        "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (2, 1, 'h', 't', 'b')",
      ),
    ).toThrow(/tombstone/);
  });
});

describe("schema v13 (I04-T05, I04-R9)", () => {
  const seedV12 = () => {
    migrate(db, migrations.slice(0, 12));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    for (const externalId of ["a", "b", "c", "d"]) {
      db.run(
        "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', ?)",
        [externalId],
      );
    }
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 2, 't1', 'user-deleted')",
    );
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (2, 1, 't2', 'access-revoked')",
    );
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (3, 7, 't3', 'source-deleted')",
    );
  };
  const seq = () => db.all("SELECT change_seq FROM revisions")[0]?.change_seq as number;
  const addVersion = (sourceId: number, version: number) =>
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (?, ?, 'h', 't', 'b')",
      [sourceId, version],
    );

  it("keeps every v12 tombstone: the version as covers_version, no revision, not lifted", () => {
    seedV12();
    const before = seq();
    migrate(db);
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(columns("tombstones")).toEqual([
      "source_id",
      "covers_version",
      "last_revision",
      "at",
      "reason",
      "lifted_at",
    ]);
    expect(db.all("SELECT * FROM tombstones ORDER BY source_id")).toEqual([
      {
        source_id: 1,
        covers_version: 2,
        last_revision: null,
        at: "t1",
        reason: "user-deleted",
        lifted_at: null,
      },
      {
        source_id: 2,
        covers_version: 1,
        last_revision: null,
        at: "t2",
        reason: "access-revoked",
        lifted_at: null,
      },
      {
        source_id: 3,
        covers_version: 7,
        last_revision: null,
        at: "t3",
        reason: "source-deleted",
        lifted_at: null,
      },
    ]);
    // moving the rows is no source change
    expect(seq()).toBe(before);
    expect(db.all("PRAGMA foreign_key_check")).toEqual([]);
    expect(db.all("SELECT sql FROM sqlite_schema WHERE name = 'tombstones'")[0]?.sql).toMatch(
      /REFERENCES "?sources"? \(id\)/,
    );
  });

  it("brings a v8 database's `deleted` tombstone to v13 as `user-deleted` (through v9)", () => {
    migrate(db, migrations.slice(0, 8));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'test-fixtures')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'a')");
    db.run("INSERT INTO sources (connector_instance_id, external_id) VALUES ('c', 'b')");
    db.run("INSERT INTO tombstones (source_id, version, at, reason) VALUES (1, 2, 't', 'deleted')");
    db.run(
      "INSERT INTO tombstones (source_id, version, at, reason) VALUES (2, 1, 't', 'access-revoked')",
    );
    migrate(db);
    expect(
      db.all(
        "SELECT source_id, covers_version, reason, lifted_at FROM tombstones ORDER BY source_id",
      ),
    ).toEqual([
      { source_id: 1, covers_version: 2, reason: "user-deleted", lifted_at: null },
      { source_id: 2, covers_version: 1, reason: "access-revoked", lifted_at: null },
    ]);
  });

  it("is idempotent when re-run over migrated tombstones", () => {
    seedV12();
    migrate(db);
    db.run("UPDATE tombstones SET lifted_at = 'l', last_revision = 4 WHERE source_id = 3");
    const rows = db.all("SELECT * FROM tombstones ORDER BY source_id");
    const before = seq();
    migrate(db);
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(db.all("SELECT * FROM tombstones ORDER BY source_id")).toEqual(rows);
    expect(seq()).toBe(before);
  });

  it("takes the three reasons, a cover from 0 and a revision from 1, and nothing else", () => {
    seedV12();
    migrate(db);
    const insert = (cover: number, reason: string, revision: number | null = null) =>
      db.run(
        "INSERT INTO tombstones (source_id, covers_version, last_revision, at, reason) VALUES (4, ?, ?, 't', ?)",
        [cover, revision, reason],
      );
    for (const reason of ["user-deleted", "source-deleted", "access-revoked"]) {
      insert(0, reason, 1);
      db.run("DELETE FROM tombstones WHERE source_id = 4");
    }
    expect(() => insert(1, "deleted")).toThrow(/CHECK/);
    expect(() => insert(1, "lifted")).toThrow(/CHECK/);
    expect(() => insert(-1, "user-deleted")).toThrow(/CHECK/);
    expect(() => insert(1, "source-deleted", 0)).toThrow(/CHECK/);
    // whole numbers only: a fraction would be stored as it is (INTEGER affinity keeps 5.5)
    expect(() => insert(1.5, "source-deleted")).toThrow(/CHECK/);
    expect(() => insert(1, "source-deleted", 5.5)).toThrow(/CHECK/);
    expect(() =>
      db.run(
        "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (4, 'x', 't', 'user-deleted')",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run("INSERT INTO tombstones (source_id, at, reason) VALUES (4, 't', 'user-deleted')"),
    ).toThrow(/NOT NULL/);
    expect(() =>
      db.run(
        "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (404, 1, 't', 'user-deleted')",
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("raises the change sequence for a new tombstone and a moved cover only", () => {
    seedV12();
    migrate(db);
    const before = seq();
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (4, 0, 't', 'source-deleted')",
    );
    expect(seq()).toBe(before + 1);
    db.run("UPDATE tombstones SET covers_version = 3 WHERE source_id = 4");
    expect(seq()).toBe(before + 2);
    // a reason change, a revision, a lift and a rewrite of the same cover change no content
    db.run("UPDATE tombstones SET reason = 'user-deleted', at = 'u' WHERE source_id = 4");
    db.run("UPDATE tombstones SET last_revision = 9 WHERE source_id = 4");
    db.run("UPDATE tombstones SET lifted_at = 'l' WHERE source_id = 4");
    db.run("UPDATE tombstones SET covers_version = 3, lifted_at = NULL WHERE source_id = 4");
    expect(seq()).toBe(before + 2);
  });

  it("refuses a source version at or below covers_version, lifted or not", () => {
    seedV12();
    migrate(db);
    expect(() => addVersion(1, 2)).toThrow(/tombstone/);
    db.run("UPDATE tombstones SET lifted_at = 'l' WHERE source_id = 1");
    expect(() => addVersion(1, 1)).toThrow(/tombstone/);
    expect(() => addVersion(1, 2)).toThrow(/tombstone/);
    addVersion(1, 3);
    // another source's tombstone and a cover of 0 block nothing
    addVersion(4, 1);
    db.run(
      "INSERT INTO tombstones (source_id, covers_version, at, reason) VALUES (4, 0, 't', 'source-deleted')",
    );
    addVersion(4, 2);
    expect(db.all("SELECT source_id, version FROM source_versions ORDER BY id")).toEqual([
      { source_id: 1, version: 3 },
      { source_id: 4, version: 1 },
      { source_id: 4, version: 2 },
    ]);
  });
});

describe("schema v14 (I04-T07, I04-R7)", () => {
  it("makes the identity key, one row of 32 bytes, and marks existing sources plain", () => {
    migrate(db, migrations.slice(0, 13));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')",
    );
    migrate(db);
    expect(db.all("SELECT id, length(key) AS n, typeof(key) AS t FROM identity_key")).toEqual([
      { id: 1, n: 32, t: "blob" },
    ]);
    expect(db.all("SELECT external_id, identity_hashed FROM sources")).toEqual([
      { external_id: "e", identity_hashed: 0 },
    ]);
  });

  it("accepts no second key row, a short key or a text key", () => {
    migrate(db);
    expect(() => db.run("INSERT INTO identity_key (id, key) VALUES (2, randomblob(32))")).toThrow();
    expect(() => db.run("UPDATE identity_key SET key = randomblob(8)")).toThrow();
    expect(() => db.run("UPDATE identity_key SET key = 'x'")).toThrow();
  });

  it("accepts only 0 or 1 as the hashed mark", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    expect(() =>
      db.run(
        "INSERT INTO sources (connector_instance_id, external_id, identity_hashed) VALUES ('c', 'e', 2)",
      ),
    ).toThrow();
  });
});

describe("schema v15 (I03-T08)", () => {
  it("adds the schedules table, one period per kind and target, and leaves the jobs alone", () => {
    migrate(db, migrations.slice(0, 14));
    db.run(
      `INSERT INTO jobs (kind, status, run_after, fairness_key, registered_change_seq, created_at, updated_at)
       VALUES ('maintenance', 'queued', 1, 'maintenance', 0, 1, 1)`,
    );
    migrate(db, migrations.slice(0, 15));
    expect(schemaVersion(db)).toBe(15);
    expect(db.all("SELECT kind, status FROM jobs")).toEqual([
      { kind: "maintenance", status: "queued" },
    ]);
    expect(columns("schedules")).toEqual([
      "id",
      "kind",
      "target",
      "period",
      "zone",
      "enabled",
      "next_due",
      "last_run_slot",
      "paused_code",
      "failure_seen_job",
      "revived_job",
      "warning",
      "last_missed",
      "registered_count",
      "coalesced_count",
      "held_coalesced_count",
      "skipped_count",
      "already_ran_count",
      "created_at",
      "updated_at",
    ]);
    const insert = `INSERT INTO schedules (kind, target, period, zone, next_due, created_at, updated_at)
      VALUES ('connector-sync', 'c1', '{}', 'UTC', 1, 1, 1)`;
    db.run(insert);
    expect(() => db.run(insert)).toThrow(/UNIQUE/);
  });
});

describe("schema v16 (I01-T02, I01-R9, R13)", () => {
  const insertSource =
    "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')";
  const insertVersion = `INSERT INTO source_versions (source_id, version, content_hash, title, body, revision)
    VALUES (1, 1, 'h', 't', 'b', 7)`;

  it("adds the last accepted revision and the claimed-scope mark to sources, keeping every row", () => {
    migrate(db, migrations.slice(0, 15));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(insertSource);
    db.run("UPDATE sources SET access_scope = '[\"team\"]'");
    migrate(db, migrations.slice(0, 16));
    expect(schemaVersion(db)).toBe(16);
    expect(columns("sources")).toEqual(expect.arrayContaining(["last_revision", "scope_claimed"]));
    expect(db.all("SELECT id, access_scope, last_revision, scope_claimed FROM sources")).toEqual([
      { id: 1, access_scope: '["team"]', last_revision: null, scope_claimed: 0 },
    ]);
  });

  it("adds the record schema version, provenance and blocks to source_versions without changing a row", () => {
    migrate(db, migrations.slice(0, 15));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(insertSource);
    db.run(insertVersion);
    const before = db.all(
      "SELECT id, source_id, version, content_hash, title, body, revision FROM source_versions",
    );
    migrate(db);
    expect(columns("source_versions")).toEqual(
      expect.arrayContaining(["record_schema_version", "meta", "blocks"]),
    );
    expect(
      db.all(
        "SELECT id, source_id, version, content_hash, title, body, revision FROM source_versions",
      ),
    ).toEqual(before);
    expect(db.all("SELECT record_schema_version, meta, blocks FROM source_versions")).toEqual([
      { record_schema_version: 1, meta: null, blocks: null },
    ]);
  });

  it("keeps the immutability, the index and the version triggers on source_versions", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(insertSource);
    db.run(insertVersion);
    expect(() => db.run("UPDATE source_versions SET meta = '{}'")).toThrow(/immutable/);
    expect(db.all("SELECT rowid FROM keyword_index WHERE keyword_index MATCH 'b'")).toHaveLength(1);
    expect(() => db.run(insertVersion)).toThrow();
  });

  it("accepts a whole last revision of 1 or more and no other number", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(insertSource);
    db.run("UPDATE sources SET last_revision = 4");
    expect(() => db.run("UPDATE sources SET last_revision = 0")).toThrow();
    expect(() => db.run("UPDATE sources SET last_revision = 1.5")).toThrow();
    expect(() => db.run("UPDATE sources SET last_revision = 'x'")).toThrow();
    expect(() => db.run("UPDATE sources SET scope_claimed = 2")).toThrow();
  });

  it("accepts only JSON in meta and blocks and a record schema version of 1 or more", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(insertSource);
    const insert = (cols: string, values: string) =>
      db.run(
        `INSERT INTO source_versions (source_id, version, content_hash, title, body, ${cols}) VALUES (1, 1, 'h', 't', 'b', ${values})`,
      );
    expect(() => insert("meta", "'not json'")).toThrow();
    expect(() => insert("blocks", "'{'")).toThrow();
    expect(() => insert("record_schema_version", "0")).toThrow();
    insert("meta, blocks, record_schema_version", "'{\"author\":\"a\"}', '[]', 2");
    expect(db.all("SELECT record_schema_version FROM source_versions")).toEqual([
      { record_schema_version: 2 },
    ]);
  });
});

describe("schema v17 (I01-T03, I01-R17)", () => {
  it("adds the unfinished-rescan mark and the deletions-may-be-missed mark to connector_instances, 0 for every row so far", () => {
    migrate(db, migrations.slice(0, 16));
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('c', 'k', 'x')");
    migrate(db);
    expect(schemaVersion(db)).toBe(21);
    expect(columns("connector_instances")).toEqual(
      expect.arrayContaining(["rescan_pending", "deletions_may_be_missed"]),
    );
    expect(
      db.all(
        "SELECT id, kind, cursor, rescan_pending, deletions_may_be_missed FROM connector_instances",
      ),
    ).toEqual([{ id: "c", kind: "k", cursor: "x", rescan_pending: 0, deletions_may_be_missed: 0 }]);
  });

  it("takes only 0 and 1 in either mark, and registers a new instance with both at 0", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run("UPDATE connector_instances SET rescan_pending = 1, deletions_may_be_missed = 1");
    expect(() => db.run("UPDATE connector_instances SET rescan_pending = 2")).toThrow();
    expect(() => db.run("UPDATE connector_instances SET deletions_may_be_missed = -1")).toThrow();
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('d', 'k')");
    expect(
      db.all(
        "SELECT rescan_pending AS p, deletions_may_be_missed AS m FROM connector_instances WHERE id = 'd'",
      ),
    ).toEqual([{ p: 0, m: 0 }]);
  });
});

describe("schema v18 (I04-T09, I04-R4, R11)", () => {
  const source = () => {
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')",
    );
    return db.all("SELECT id FROM sources")[0]?.id as number;
  };
  const drop = (sourceId: number, over: Record<string, unknown> = {}) => {
    const row = {
      source_id: sourceId,
      version: 1,
      kind: "fact",
      hash: "h1",
      reason: "scope-policy",
      ...over,
    };
    db.run(
      "INSERT INTO scope_policy_drops (source_id, version, kind, item_key_hash, reason, at) VALUES (?, ?, ?, ?, ?, '2026-11-22T00:00:00Z')",
      [row.source_id, row.version, row.kind, row.hash, row.reason] as never,
    );
  };

  it("adds scope_policy_drops on top of a v17 database without touching its rows", () => {
    migrate(db, migrations.slice(0, 17));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    migrate(db);
    expect(schemaVersion(db)).toBe(21);
    expect(columns("scope_policy_drops")).toEqual([
      "id",
      "source_id",
      "version",
      "kind",
      "item_key_hash",
      "reason",
      "at",
    ]);
    expect(db.all("SELECT id FROM connector_instances")).toEqual([{ id: "c" }]);
  });

  it("holds one row per refused item, only for a stored source and only with the reason scope-policy", () => {
    migrate(db);
    const id = source();
    drop(id);
    expect(() => drop(id)).toThrow(); // the same refusal is recorded once
    drop(id, { hash: "h2" });
    drop(id, { version: 2 });
    drop(id, { kind: "relation" });
    expect(() => drop(id, { reason: "other", hash: "h3" })).toThrow();
    expect(() => drop(id, { version: 0, hash: "h4" })).toThrow();
    expect(() => drop(id + 1, { hash: "h5" })).toThrow(); // no such source
    expect(db.all("SELECT count(*) AS n FROM scope_policy_drops")).toEqual([{ n: 4 }]);
  });
});

describe("schema v19 (I01-T06, I01-R15)", () => {
  it("adds configured_scope to connector_instances, NULL (unknown) for every row so far", () => {
    migrate(db, migrations.slice(0, 18));
    db.run("INSERT INTO connector_instances (id, kind, cursor) VALUES ('c', 'k', 'x')");
    migrate(db);
    expect(schemaVersion(db)).toBe(21);
    expect(columns("connector_instances")).toContain("configured_scope");
    expect(db.all("SELECT id, kind, cursor, configured_scope FROM connector_instances")).toEqual([
      { id: "c", kind: "k", cursor: "x", configured_scope: null },
    ]);
  });

  it("takes NULL or a JSON array only", () => {
    migrate(db);
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run("UPDATE connector_instances SET configured_scope = '[\"team\"]'");
    db.run("UPDATE connector_instances SET configured_scope = '[]'");
    db.run("UPDATE connector_instances SET configured_scope = NULL");
    for (const bad of ["'team'", "'{\"a\":1}'", "'not json'", "''"]) {
      expect(() => db.run(`UPDATE connector_instances SET configured_scope = ${bad}`)).toThrow();
    }
  });
});

describe("schema v20 (S01-T01, S01-R5, R6, R10, R14, R15)", () => {
  const STAMP = "2026-11-22T00:00:00Z";
  /** A v19 database holding one item, fact, relation, evidence span and Insight at odd statuses. */
  function seedV19(): void {
    migrate(db, migrations.slice(0, 19));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')",
    );
    db.run(
      "INSERT INTO source_versions (source_id, version, content_hash, title, body) VALUES (1, 1, 'h', 't', 'abc')",
    );
    for (const name of ["A", "B"]) {
      db.run(
        `INSERT INTO items (type, name, epistemic, status, observed_at) VALUES ('p', ?, 'explicit', 'candidate', ?)`,
        [name, STAMP],
      );
    }
    db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at)
       VALUES (1, 'k', 'v', 'user-approved', 'verified', ?)`,
      [STAMP],
    );
    db.run(
      `INSERT INTO relations (subject_id, type, object_id, epistemic, status, observed_at)
       VALUES (1, 'T', 2, 'hypothesis', 'superseded', ?)`,
      [STAMP],
    );
    db.run(
      "INSERT INTO evidence (source_version_id, fact_id, start_offset, end_offset, quote) VALUES (1, 1, 0, 1, 'a')",
    );
    db.run(
      "INSERT INTO insights (rule, x_item_id, y_item_id, epistemic, state, summary) VALUES ('r', 1, 2, 'inferred', 'active', 's')",
    );
  }

  const HISTORY = ["item_history", "fact_history", "relation_history"] as const;
  /** A history line as the gate writes it: by default verified -> disputed, the user-approved type kept. */
  const history = (
    table: (typeof HISTORY)[number],
    fk: string,
    id: number,
    seq: number,
    o: { action?: string; from?: string; to?: string; fromE?: string; toE?: string } = {},
  ) =>
    db.run(
      `INSERT INTO ${table} (${fk}, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      [
        id,
        seq,
        STAMP,
        o.action ?? "approve",
        o.from ?? "verified",
        o.to ?? "disputed",
        o.fromE ?? "user-approved",
        o.toE ?? "user-approved",
      ],
    );

  // schema.semantic-migration
  it("adds the columns to a v19 database with rows and changes none of their status or epistemic type", () => {
    seedV19();
    migrate(db);
    expect(schemaVersion(db)).toBe(21);
    expect(db.all("SELECT name, status, epistemic, confidence, user_authored FROM items")).toEqual([
      { name: "A", status: "candidate", epistemic: "explicit", confidence: null, user_authored: 0 },
      { name: "B", status: "candidate", epistemic: "explicit", confidence: null, user_authored: 0 },
    ]);
    expect(
      db.all("SELECT status, epistemic, confidence, user_authored, context FROM facts"),
    ).toEqual([
      {
        status: "verified",
        epistemic: "user-approved",
        confidence: null,
        user_authored: 0,
        context: null,
      },
    ]);
    expect(db.all("SELECT status, epistemic, confidence, user_authored FROM relations")).toEqual([
      { status: "superseded", epistemic: "hypothesis", confidence: null, user_authored: 0 },
    ]);
    expect(db.all("SELECT count(*) AS n FROM evidence")).toEqual([{ n: 1 }]);
    expect(db.all("SELECT count(*) AS n FROM insights")).toEqual([{ n: 1 }]);
  });

  it("invents no history for rows that predate it", () => {
    seedV19();
    migrate(db);
    for (const table of [...HISTORY, "insight_user_inputs"]) {
      expect(db.all(`SELECT count(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
  });

  it("holds no text in a history line: numbers and codes only", () => {
    migrate(db);
    for (const table of HISTORY) {
      expect(columns(table), table).toEqual(
        expect.not.arrayContaining(["name", "value", "quote", "title", "body", "context"]),
      );
    }
    // the only free text of a line is the action and the reason code; a basis is two numbers
    expect(columns("fact_history")).toEqual([
      "fact_id",
      "seq",
      "at",
      "actor",
      "action",
      "from_status",
      "to_status",
      "from_epistemic",
      "to_epistemic",
      "reason",
      "basis_source_id",
      "basis_version",
      "batch",
      "reverts_seq",
    ]);
  });

  it("holds the basis as numbers, not a foreign key, so a deleted version leaves the line intact", () => {
    migrate(db);
    for (const table of HISTORY) {
      expect(
        db.all(`SELECT "table" FROM pragma_foreign_key_list('${table}')`).map((r) => r.table),
      ).toEqual([
        table === "item_history" ? "items" : table === "fact_history" ? "facts" : "relations",
      ]);
    }
  });

  // R10: confidence is 0..1 or empty; user_authored 0 or 1
  it("takes confidence in 0..1 or empty and user_authored 0 or 1 only", () => {
    seedV19();
    migrate(db);
    db.run("UPDATE items SET confidence = 0.4 WHERE id = 1");
    for (const bad of ["-0.1", "1.5", "'x'"]) {
      expect(() => db.run(`UPDATE facts SET confidence = ${bad}`)).toThrow(/CHECK/);
    }
    expect(() =>
      db.run(
        `INSERT INTO items (type, name, epistemic, status, observed_at, user_authored)
         VALUES ('p', 'C', 'explicit', 'candidate', ?, 2)`,
        [STAMP],
      ),
    ).toThrow(/CHECK/);
  });

  it("refuses a status, epistemic type or user_authored change with no history line behind it", () => {
    seedV19();
    migrate(db);
    expect(() => db.run("UPDATE facts SET status = 'rejected'")).toThrow(/lifecycle gate/);
    expect(() => db.run("UPDATE facts SET epistemic = 'inferred'")).toThrow(/lifecycle gate/);
    expect(() => db.run("UPDATE facts SET user_authored = 1")).toThrow(/lifecycle gate/);
    expect(() => db.run("UPDATE items SET status = 'verified' WHERE id = 1")).toThrow(
      /lifecycle gate/,
    );
    expect(() => db.run("UPDATE relations SET status = 'candidate'")).toThrow(/lifecycle gate/);
    expect(db.all("SELECT status FROM facts")).toEqual([{ status: "verified" }]);
  });

  it("lets an UPDATE through only when the newest history line says that very change", () => {
    seedV19();
    migrate(db);
    history("fact_history", "fact_id", 1, 1); // verified -> disputed, user-approved kept
    expect(() => db.run("UPDATE facts SET status = 'rejected'")).toThrow(/lifecycle gate/); // another target
    expect(() => db.run("UPDATE facts SET status = 'disputed', epistemic = 'explicit'")).toThrow(
      /lifecycle gate/,
    );
    db.run("UPDATE facts SET status = 'disputed'");
    expect(db.all("SELECT status FROM facts")).toEqual([{ status: "disputed" }]);
    // the line is spent: the row is where it says, so repeating it from here is a bare update again
    expect(() => db.run("UPDATE facts SET status = 'rejected'")).toThrow(/lifecycle gate/);
    expect(() => db.run("UPDATE facts SET status = 'verified'")).toThrow(/lifecycle gate/);
    // another row's line does not count
    history("item_history", "item_id", 2, 1); // says verified -> disputed, but item 2 is a candidate
    expect(() => db.run("UPDATE items SET status = 'disputed' WHERE id = 2")).toThrow(
      /lifecycle gate/,
    );
  });

  it("refuses a line whose earlier state is not the row's own, however the target matches", () => {
    seedV19();
    migrate(db);
    // item 2 is a candidate/explicit; the line says verified -> disputed with the epistemic type kept
    history("item_history", "item_id", 2, 1, { fromE: "explicit", toE: "explicit" });
    expect(() => db.run("UPDATE items SET status = 'disputed' WHERE id = 2")).toThrow(
      /lifecycle gate/,
    );
    // fact 1 is verified/user-approved; the line names the right statuses but another earlier type
    history("fact_history", "fact_id", 1, 1, { fromE: "explicit" });
    expect(() => db.run("UPDATE facts SET status = 'disputed'")).toThrow(/lifecycle gate/);
  });

  it("refuses a line whose target epistemic type is not the one the update sets", () => {
    seedV19();
    migrate(db);
    history("fact_history", "fact_id", 1, 1, { toE: "explicit" });
    expect(() => db.run("UPDATE facts SET status = 'disputed'")).toThrow(/lifecycle gate/);
    db.run("UPDATE facts SET status = 'disputed', epistemic = 'explicit'");
    expect(db.all("SELECT status, epistemic FROM facts")).toEqual([
      { status: "disputed", epistemic: "explicit" },
    ]);
  });

  it("reads only the newest line: an older line that said the same change does not let it through again", () => {
    seedV19();
    migrate(db);
    history("fact_history", "fact_id", 1, 1); // verified -> disputed
    db.run("UPDATE facts SET status = 'disputed'");
    history("fact_history", "fact_id", 1, 2, { from: "disputed", to: "verified" });
    db.run("UPDATE facts SET status = 'verified'");
    // line 1 says exactly this change, but line 2 is the newest and says another
    expect(() => db.run("UPDATE facts SET status = 'disputed'")).toThrow(/lifecycle gate/);
  });

  it("lets user_authored change only behind an undo line", () => {
    seedV19();
    migrate(db);
    history("fact_history", "fact_id", 1, 1);
    expect(() => db.run("UPDATE facts SET status = 'disputed', user_authored = 1")).toThrow(
      /lifecycle gate/,
    );
    history("fact_history", "fact_id", 1, 2, { action: "undo" }); // the line of 1 is spent: the row is still verified
    db.run("UPDATE facts SET status = 'disputed', user_authored = 1");
    expect(db.all("SELECT status, user_authored FROM facts")).toEqual([
      { status: "disputed", user_authored: 1 },
    ]);
  });

  it("changes a row's other columns freely (the gate watches three columns)", () => {
    seedV19();
    migrate(db);
    db.run("UPDATE items SET name = 'A2', valid_at = '2026-12-01' WHERE id = 1");
    db.run("UPDATE facts SET value = 'w', context = 'c', confidence = 0.2");
    expect(db.all("SELECT name FROM items WHERE id = 1")).toEqual([{ name: "A2" }]);
  });

  it("cannot update a history line or delete it while its row stands, and a cascade deletes it with the row", () => {
    seedV19();
    migrate(db);
    history("relation_history", "relation_id", 1, 1);
    history("relation_history", "relation_id", 1, 2);
    expect(() => db.run("UPDATE relation_history SET reason = 'x'")).toThrow(/immutable/);
    expect(() => db.run("DELETE FROM relation_history WHERE seq = 2")).toThrow(
      /only with their row/,
    );
    expect(() => db.run("DELETE FROM relation_history")).toThrow(/only with their row/);
    db.run("DELETE FROM relations WHERE id = 1");
    expect(db.all("SELECT count(*) AS n FROM relation_history")).toEqual([{ n: 0 }]);
  });

  it("deletes every kind's history with its row, and leaves another row's history", () => {
    seedV19();
    migrate(db);
    db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at) VALUES (2, 'k', 'v2', 'explicit', 'candidate', ?)`,
      [STAMP],
    );
    history("fact_history", "fact_id", 1, 1);
    history("fact_history", "fact_id", 2, 1);
    db.run("DELETE FROM evidence WHERE fact_id = 1");
    db.run("DELETE FROM facts WHERE id = 1");
    expect(db.all("SELECT fact_id FROM fact_history")).toEqual([{ fact_id: 2 }]);
    history("item_history", "item_id", 1, 1);
    db.run("DELETE FROM insights");
    db.run("DELETE FROM relations");
    db.run("DELETE FROM facts WHERE item_id = 1");
    db.run("DELETE FROM items WHERE id = 1");
    expect(db.all("SELECT count(*) AS n FROM item_history")).toEqual([{ n: 0 }]);
  });

  it("numbers a row's lines from 1 without repeats, with an actor from the four", () => {
    seedV19();
    migrate(db);
    history("fact_history", "fact_id", 1, 1);
    expect(() => history("fact_history", "fact_id", 1, 1)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => history("fact_history", "fact_id", 1, 0)).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO fact_history (fact_id, seq, at, actor, action, to_status, to_epistemic)
         VALUES (1, 9, ?, 'robot', 'x', 'verified', 'explicit')`,
        [STAMP],
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO fact_history (fact_id, seq, at, actor, action, to_status, to_epistemic, basis_source_id)
         VALUES (1, 9, ?, 'user', 'x', 'verified', 'explicit', 1)`,
        [STAMP],
      ),
    ).toThrow(/CHECK/); // a source id without its version
  });

  it("ties insight_user_inputs to an Insight and one fact or relation, and removes a line with either", () => {
    seedV19();
    migrate(db);
    db.run("INSERT INTO insight_user_inputs (insight_id, fact_id) VALUES (1, 1)");
    expect(() =>
      db.run("INSERT INTO insight_user_inputs (insight_id, fact_id) VALUES (1, 1)"),
    ).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO insight_user_inputs (insight_id) VALUES (1)")).toThrow(
      /CHECK/,
    );
    expect(() =>
      db.run("INSERT INTO insight_user_inputs (insight_id, fact_id, relation_id) VALUES (1, 1, 1)"),
    ).toThrow(/CHECK/);
    db.run("INSERT INTO insight_user_inputs (insight_id, relation_id) VALUES (1, 1)");
    db.run("DELETE FROM relations WHERE id = 1");
    expect(db.all("SELECT fact_id, relation_id FROM insight_user_inputs")).toEqual([
      { fact_id: 1, relation_id: null },
    ]);
    db.run("DELETE FROM insights WHERE id = 1");
    expect(db.all("SELECT count(*) AS n FROM insight_user_inputs")).toEqual([{ n: 0 }]);
  });
});

describe("schema v21 (S01-T06, S01-R18, R20, R22)", () => {
  const STAMP = "2026-11-22T00:00:00Z";
  /** A v20 database with an item, a fact and a history line: what the migration must leave alone. */
  function seedV20(): void {
    migrate(db, migrations.slice(0, 20));
    db.run("INSERT INTO connector_instances (id, kind) VALUES ('c', 'k')");
    db.run(
      "INSERT INTO sources (connector_instance_id, namespace, external_id) VALUES ('c', '', 'e')",
    );
    db.run(
      `INSERT INTO items (type, name, epistemic, status, observed_at)
       VALUES ('Project', 'A', 'explicit', 'candidate', ?)`,
      [STAMP],
    );
    db.run(
      `INSERT INTO facts (item_id, kind, value, epistemic, status, observed_at)
       VALUES (1, 'target_date', '2026-12-01', 'user-approved', 'verified', ?)`,
      [STAMP],
    );
    db.run(
      `INSERT INTO fact_history (fact_id, seq, at, actor, action, from_status, to_status, from_epistemic, to_epistemic)
       VALUES (1, 1, ?, 'user', 'approve', 'candidate', 'verified', 'explicit', 'user-approved')`,
      [STAMP],
    );
  }
  const revision = () =>
    db.all("SELECT knowledge_revision AS r, change_seq AS c FROM revisions")[0] as {
      r: number;
      c: number;
    };
  const element = (over: Record<string, unknown> = {}) => {
    const row = {
      kind: "fact-kind",
      name: "x_kind",
      rule: '{"elementKind":"fact-kind"}',
      status: "candidate",
      edition: 1,
      ...over,
    };
    return db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition) VALUES (?, ?, ?, ?, ?)",
      [row.kind, row.name, row.rule, row.status, row.edition] as never,
    ).lastInsertRowid;
  };
  const line = (
    id: number,
    seq: number,
    o: { from?: string; to?: string; fromE?: number; toE?: number; action?: string } = {},
  ) =>
    db.run(
      `INSERT INTO ontology_history (element_id, seq, at, actor, action, from_status, to_status, from_edition, to_edition)
       VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?)`,
      [
        id,
        seq,
        STAMP,
        o.action ?? "test",
        o.from ?? "candidate",
        o.to ?? "verified",
        o.fromE ?? 1,
        o.toE ?? 1,
      ],
    );

  // schema.semantic-migration (migration 2)
  it("adds the three tables to a v20 database and leaves its rows, history and revisions alone", () => {
    seedV20();
    const before = revision();
    migrate(db);
    expect(schemaVersion(db)).toBe(21);
    expect(revision()).toEqual(before); // the seed is not a knowledge change an upgrade should show
    expect(db.all("SELECT name, status, epistemic FROM items")).toEqual([
      { name: "A", status: "candidate", epistemic: "explicit" },
    ]);
    expect(db.all("SELECT kind, value, status FROM facts")).toEqual([
      { kind: "target_date", value: "2026-12-01", status: "verified" },
    ]);
    expect(db.all("SELECT fact_id, seq, action FROM fact_history")).toEqual([
      { fact_id: 1, seq: 1, action: "approve" },
    ]);
    expect(db.all("SELECT count(*) AS n FROM ontology_history")).toEqual([{ n: 0 }]);
    expect(db.all("SELECT count(*) AS n FROM ontology_basis")).toEqual([{ n: 0 }]);
  });

  it("does not rebuild the knowledge tables: their history and gate triggers survive", () => {
    seedV20();
    migrate(db);
    expect(db.all("SELECT count(*) AS n FROM fact_history")).toEqual([{ n: 1 }]);
    const triggers = db
      .all("SELECT name FROM sqlite_schema WHERE type = 'trigger'")
      .map((r) => r.name);
    for (const t of ["items", "facts", "relations"]) {
      expect(triggers).toContain(`${t}_lifecycle_gate`);
    }
    expect(() => db.run("UPDATE facts SET status = 'rejected'")).toThrow(/lifecycle gate/);
  });

  it("seeds the registry with the code's constants and R4's, verified, edition 1, the same every time", () => {
    migrate(db);
    const seed = () =>
      db.all("SELECT element_kind, name, rule, status, edition FROM ontology_elements ORDER BY id");
    const dates = {
      elementKind: "fact-kind",
      itemTypes: ["Project", "System"],
      valueType: "date",
      cardinality: "one",
    };
    const form = {
      elementKind: "fact-kind",
      itemTypes: ["Concept", "Project", "System"],
      valueType: "surface-form",
      cardinality: "many",
    };
    expect(
      seed().map((r) => [
        r.element_kind,
        r.name,
        JSON.parse(r.rule as string),
        r.status,
        r.edition,
      ]),
    ).toEqual([
      ["item-type", "Project", { elementKind: "item-type" }, "verified", 1],
      ["item-type", "System", { elementKind: "item-type" }, "verified", 1],
      ["item-type", "Concept", { elementKind: "item-type" }, "verified", 1],
      ["fact-kind", "target_date", dates, "verified", 1],
      ["fact-kind", "completion_date", dates, "verified", 1],
      [
        "fact-kind",
        "definition",
        {
          elementKind: "fact-kind",
          itemTypes: ["Concept"],
          valueType: "text",
          cardinality: "many",
        },
        "verified",
        1,
      ],
      ["fact-kind", "alias.synonym", form, "verified", 1],
      ["fact-kind", "alias.abbreviation", form, "verified", 1],
      ["fact-kind", "alias.translation", form, "verified", 1],
      [
        "relation-type",
        "DEPENDS_ON",
        {
          elementKind: "relation-type",
          subjectTypes: ["Project", "System"],
          objectTypes: ["Project", "System"],
          symmetric: false,
        },
        "verified",
        1,
      ],
    ]);
    const first = seed();
    db.close();
    db = openBetterSqlite3(":memory:");
    migrate(db);
    expect(seed()).toEqual(first);
  });

  it("is atomic: a failure after the seed leaves no table, no seed and the old version", () => {
    seedV20();
    const failing = [
      ...migrations.slice(0, 20),
      (d: SqlDriver) => {
        (migrations[20] as (d: SqlDriver) => void)(d);
        throw new Error("broken");
      },
    ];
    expect(() => migrate(db, failing)).toThrow(/broken/);
    expect(schemaVersion(db)).toBe(20);
    expect(tables().filter((t) => t.startsWith("ontology_"))).toEqual([]);
    migrate(db);
    expect(db.all("SELECT count(*) AS n FROM ontology_elements")).toEqual([{ n: 10 }]);
  });

  it("refuses a database newer than the build instead of downgrading it", () => {
    migrate(db);
    expect(() => migrate(db, migrations.slice(0, 20))).toThrow(/newer than this build/);
    expect(schemaVersion(db)).toBe(21);
  });

  it("takes an identifier name of 40 characters at most, a kind of the three, and an edition of 1 or more", () => {
    migrate(db);
    element({ name: "a".repeat(40) });
    element(); // x_kind
    for (const name of ["", "1abc", "a b", "a-b", "가나", "a".repeat(41), "a'b"]) {
      expect(() => element({ name }), name).toThrow(/CHECK/);
    }
    expect(() => element({ kind: "other", name: "k2" })).toThrow(/CHECK/);
    expect(() => element({ name: "k3", edition: 0 })).toThrow(/CHECK/);
    expect(() => element({ name: "k4", rule: "not json" })).toThrow(/CHECK/);
    expect(() => element({ name: "k5", rule: "[]" })).toThrow(/CHECK/);
    expect(() => element({ name: "k6", status: "unknown" })).toThrow(/CHECK/);
    expect(() => element({ name: "x_kind" })).toThrow(/UNIQUE/);
    element({ kind: "item-type", name: "x_kind" }); // the same name in another kind is another element
  });

  it("holds no text in the history or the lineage: numbers and codes only", () => {
    migrate(db);
    expect(columns("ontology_history")).toEqual([
      "element_id",
      "seq",
      "at",
      "actor",
      "action",
      "from_status",
      "to_status",
      "from_edition",
      "to_edition",
      "reason",
      "basis_source_id",
      "basis_version",
      "batch",
      "reverts_seq",
    ]);
    expect(columns("ontology_basis")).toEqual(["element_id", "source_id", "version"]);
    expect(
      db.all("SELECT \"table\" FROM pragma_foreign_key_list('ontology_basis')").map((r) => r.table),
    ).toEqual(["ontology_elements"]); // the source version is a number, not a key
  });

  it("refuses a status, rule or edition change with no history line behind it", () => {
    migrate(db);
    const id = element();
    expect(() => db.run("UPDATE ontology_elements SET status = 'verified'")).toThrow(
      /ontology gate/,
    );
    expect(() => db.run("UPDATE ontology_elements SET edition = 2")).toThrow(/ontology gate/);
    expect(() => db.run(`UPDATE ontology_elements SET rule = '{"a":1}'`)).toThrow(/ontology gate/);
    expect(db.all("SELECT status, edition FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { status: "candidate", edition: 1 },
    ]);
  });

  it("lets a change through only when the newest line says that very change, and a rule only with its edition", () => {
    migrate(db);
    const id = element({ status: "verified" });
    line(id, 1, { from: "verified", to: "verified", fromE: 1, toE: 2, action: "change-rule" });
    // another target, or the right one without the edition, does not pass
    expect(() => db.run("UPDATE ontology_elements SET edition = 3 WHERE id = ?", [id])).toThrow(
      /ontology gate/,
    );
    expect(() =>
      db.run(`UPDATE ontology_elements SET rule = '{"b":1}' WHERE id = ?`, [id]),
    ).toThrow(/ontology gate/); // a rule change that leaves the edition where it was
    db.run(`UPDATE ontology_elements SET rule = '{"b":1}', edition = 2 WHERE id = ?`, [id]);
    expect(db.all("SELECT edition FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { edition: 2 },
    ]);
    // the line is spent
    expect(() =>
      db.run(`UPDATE ontology_elements SET rule = '{"c":1}', edition = 2 WHERE id = ?`, [id]),
    ).toThrow(/ontology gate/);
    // only the newest line counts: line 1 said edition 2, line 2 says a retirement
    line(id, 2, { from: "verified", to: "superseded", fromE: 2, toE: 3, action: "retire" });
    expect(() => db.run("UPDATE ontology_elements SET edition = 2, status = 'verified'")).toThrow(
      /ontology gate/,
    );
    db.run("UPDATE ontology_elements SET status = 'superseded', edition = 3 WHERE id = ?", [id]);
    expect(db.all("SELECT status, edition FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { status: "superseded", edition: 3 },
    ]);
  });

  it("does not let a stale line authorize a change the row has since moved past (approve, undo, then a raw UPDATE)", () => {
    migrate(db);
    const id = element(); // candidate, edition 1
    line(id, 1, { from: "candidate", to: "verified", action: "approve" });
    db.run("UPDATE ontology_elements SET status = 'verified' WHERE id = ?", [id]);
    line(id, 2, { from: "verified", to: "candidate", action: "undo" });
    db.run("UPDATE ontology_elements SET status = 'candidate' WHERE id = ?", [id]);
    // line 1 still says candidate -> verified, but the newest line is line 2
    expect(() =>
      db.run("UPDATE ontology_elements SET status = 'verified' WHERE id = ?", [id]),
    ).toThrow(/ontology gate/);
    expect(db.all("SELECT status FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { status: "candidate" },
    ]);
  });

  it("never renames an element or changes its kind, with or without a history line", () => {
    migrate(db);
    const id = element({ status: "verified" });
    line(id, 1, { from: "verified", to: "verified" });
    expect(() =>
      db.run("UPDATE ontology_elements SET name = 'Renamed' WHERE id = ?", [id]),
    ).toThrow(/keeps its name and kind/);
    expect(() =>
      db.run("UPDATE ontology_elements SET element_kind = 'item-type' WHERE id = ?", [id]),
    ).toThrow(/keeps its name and kind/);
    expect(() => db.run("UPDATE ontology_elements SET name = name WHERE id = ?", [id])).toThrow(
      /keeps its name and kind/,
    );
    expect(db.all("SELECT element_kind, name FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { element_kind: "fact-kind", name: "x_kind" },
    ]);
  });

  it("refuses a rule change even behind a line that keeps the edition: a rule changes only with its edition", () => {
    migrate(db);
    const id = element({ status: "verified" });
    line(id, 1, { from: "verified", to: "verified", fromE: 1, toE: 1, action: "change-rule" });
    expect(() =>
      db.run(`UPDATE ontology_elements SET rule = '{"b":1}' WHERE id = ?`, [id]),
    ).toThrow(/ontology gate/);
    expect(db.all("SELECT rule FROM ontology_elements WHERE id = ?", [id])).toEqual([
      { rule: '{"elementKind":"fact-kind"}' },
    ]);
  });

  it("cannot update a history line or delete it while its element stands; a cascade deletes it with the element", () => {
    migrate(db);
    const id = element();
    line(id, 1);
    line(id, 2);
    expect(() => db.run("UPDATE ontology_history SET reason = 'x'")).toThrow(/immutable/);
    expect(() => db.run("DELETE FROM ontology_history WHERE seq = 2")).toThrow(
      /only with their row/,
    );
    expect(() => db.run("DELETE FROM ontology_history")).toThrow(/only with their row/);
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, 1, 1)", [id]);
    const other = element({ name: "other" });
    line(other, 1);
    db.run("DELETE FROM ontology_elements WHERE id = ?", [id]);
    expect(db.all("SELECT element_id FROM ontology_history")).toEqual([{ element_id: other }]);
    expect(db.all("SELECT count(*) AS n FROM ontology_basis")).toEqual([{ n: 0 }]);
  });

  it("numbers a line from 1 without repeats, with an actor from the four and a basis in a pair", () => {
    migrate(db);
    const id = element();
    line(id, 1);
    expect(() => line(id, 1)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => line(id, 0)).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO ontology_history (element_id, seq, at, actor, action, to_status, to_edition)
         VALUES (?, 9, ?, 'robot', 'x', 'verified', 1)`,
        [id, STAMP],
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.run(
        `INSERT INTO ontology_history (element_id, seq, at, actor, action, to_status, to_edition, basis_version)
         VALUES (?, 9, ?, 'user', 'x', 'verified', 1, 1)`,
        [id, STAMP],
      ),
    ).toThrow(/CHECK/);
  });

  it("raises the knowledge revision once per changed element row, and not for a line or a lineage row", () => {
    migrate(db);
    const start = revision().r;
    const id = element();
    expect(revision().r).toBe(start + 1);
    line(id, 1);
    db.run("INSERT INTO ontology_basis (element_id, source_id, version) VALUES (?, 1, 1)", [id]);
    expect(revision().r).toBe(start + 1);
    db.run("UPDATE ontology_elements SET status = 'verified' WHERE id = ?", [id]);
    expect(revision().r).toBe(start + 2);
    db.run("DELETE FROM ontology_elements WHERE id = ?", [id]);
    expect(revision().r).toBe(start + 3);
  });
});
