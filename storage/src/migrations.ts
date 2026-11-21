import type { SqlDriver } from "./sql-driver.ts";

export type Migration = (db: SqlDriver) => void;

// Schema v1 (V01-R6). Each table carries only what a V01 task reads or writes;
// later tasks add columns through new migrations, never by editing this one.
// Deferred with owners named in the spec task table: connector cursor storage
// (V01-T04 migration) and source access_scope (V01-T07).
const v1: Migration = (db) =>
  db.exec(`
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      connector_instance_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      UNIQUE (connector_instance_id, external_id)
    );

    CREATE TABLE source_versions (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources (id),
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL
    );
    CREATE INDEX source_versions_source ON source_versions (source_id);

    -- A stored version never changes (ADR 0013 decision 2); deletion removes rows.
    CREATE TRIGGER source_versions_immutable BEFORE UPDATE ON source_versions
    BEGIN SELECT RAISE(ABORT, 'source versions are immutable'); END;

    -- Keyword index: a projection kept in the canonical file and updated in the
    -- same transaction as source_versions (ARCHITECTURE section 4).
    CREATE VIRTUAL TABLE keyword_index USING fts5 (
      title, body, content = 'source_versions', content_rowid = 'id'
    );
    CREATE TRIGGER source_versions_index AFTER INSERT ON source_versions BEGIN
      INSERT INTO keyword_index (rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER source_versions_unindex AFTER DELETE ON source_versions BEGIN
      INSERT INTO keyword_index (keyword_index, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
    END;

    -- Minimal job record; V02 adds lease and fence columns.
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      source_version_id INTEGER NOT NULL REFERENCES source_versions (id),
      status TEXT NOT NULL
    );

    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- ADR 0014: a consent is bound to provider, destination and policy version.
    CREATE TABLE consents (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL,
      destination TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      allowed_classes TEXT NOT NULL,
      granted_at TEXT NOT NULL
    );

    -- ADR 0014: history holds no body, prompt, response or secret. One row per
    -- attempt, so Broker retries of a request each leave their own record.
    -- duration_ms is absent for calls that never ran.
    CREATE TABLE provider_calls (
      id INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      provider TEXT NOT NULL,
      destination TEXT NOT NULL,
      task_kind TEXT NOT NULL,
      classification TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      outcome TEXT NOT NULL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE (request_id, attempt)
    );
  `);

/** Index i holds the migration that brings the schema to version i + 1. */
export const migrations: readonly Migration[] = [v1];

export function schemaVersion(db: SqlDriver): number {
  return db.all("PRAGMA user_version")[0]?.user_version as number;
}

/** Applies each pending migration and its version bump in one transaction. */
export function migrate(db: SqlDriver, steps: readonly Migration[] = migrations): void {
  const current = schemaVersion(db);
  if (current > steps.length) {
    throw new Error(`database schema v${current} is newer than this build (v${steps.length})`);
  }
  steps.slice(current).forEach((step, i) =>
    db.transaction(() => {
      step(db);
      db.exec(`PRAGMA user_version = ${current + i + 1}`);
    }),
  );
}
