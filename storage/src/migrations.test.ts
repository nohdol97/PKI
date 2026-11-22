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
    expect(schemaVersion(db)).toBe(14);
    expect(migrations).toHaveLength(14);
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
      "facts",
      "insight_evidence",
      "insights",
      "invalidations",
      "items",
      "jobs",
      "keyword_index",
      "provider_calls",
      "relations",
      "revisions",
      "schedules",
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

describe("schema v14 (I03-T08)", () => {
  it("adds the schedules table, one period per kind and target, and leaves the jobs alone", () => {
    migrate(db, migrations.slice(0, 13));
    db.run(
      `INSERT INTO jobs (kind, status, run_after, fairness_key, registered_change_seq, created_at, updated_at)
       VALUES ('maintenance', 'queued', 1, 'maintenance', 0, 1, 1)`,
    );
    migrate(db);
    expect(schemaVersion(db)).toBe(14);
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
