import type { SqlDriver } from "./sql-driver.ts";

export type Migration = (db: SqlDriver) => void;

// Schema v1 (V01-R6). Each table carries only what a V01 task reads or writes;
// later tasks add columns through new migrations, never by editing this one.
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

// Schema v2 (V01-T04): one row per Connector instance. The kind is recorded so
// the Broker can tell which Connector a source came from (a site-* source is
// never synthetic, V01-C4 broker.class); the cursor is written in the same
// transaction as the page it follows (ADR 0013 decision 1). sources is rebuilt
// with a foreign key to it (SQLite cannot add one in place); a v1 source gets an
// instance of kind 'unknown', which is no upstream kind and so never synthetic.
// Rows are copied aside, sources is dropped and recreated under the same name
// (a rename would rewrite source_versions' reference to the old table). Dropping
// leaves source_versions rows orphaned for a moment; defer_foreign_keys holds that
// check until commit, and re-inserting the parent rows resolves it.
const v2: Migration = (db) =>
  db.exec(`
    CREATE TABLE connector_instances (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      cursor TEXT
    );
    INSERT INTO connector_instances (id, kind)
      SELECT DISTINCT connector_instance_id, 'unknown' FROM sources;
    PRAGMA defer_foreign_keys = ON;
    CREATE TEMP TABLE sources_v1 AS SELECT id, connector_instance_id, external_id FROM sources;
    DROP TABLE sources;
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      connector_instance_id TEXT NOT NULL REFERENCES connector_instances (id),
      external_id TEXT NOT NULL,
      UNIQUE (connector_instance_id, external_id)
    );
    INSERT INTO sources (id, connector_instance_id, external_id)
      SELECT id, connector_instance_id, external_id FROM sources_v1;
    DROP TABLE sources_v1;
  `);

// Schema v3 (V01-T07): a source's access scope, which a Connector fills and the
// Broker maps to a data classification (ADR 0014). NULL means none was given.
// It never makes a source synthetic; only the synthetic manifest does.
const v3: Migration = (db) => db.exec("ALTER TABLE sources ADD COLUMN access_scope TEXT");

// Schema v4 (V01-T08). History gets the reason code of an attempt that never ran
// (T07 handoff 3), and an attempt blocked before the egress decision named a
// destination stores none: destination and policy_version become nullable, but
// only for "blocked" rows; every other row, the budget-exhausted one included,
// still carries both. A v3 blocked row had no reason column: it reads "unrecorded".
// consents becomes one row per Provider (the latest v3 row is kept), so granting
// again replaces the old consent instead of leaving two to choose between.
// Neither table is referenced by a foreign key, trigger or view, so each is
// rebuilt under a temporary name and renamed.
const v4: Migration = (db) =>
  db.exec(`
    CREATE TABLE provider_calls_v4 (
      id INTEGER PRIMARY KEY,
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      provider TEXT NOT NULL,
      destination TEXT,
      task_kind TEXT NOT NULL,
      classification TEXT NOT NULL,
      policy_version TEXT,
      outcome TEXT NOT NULL,
      reason TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE (request_id, attempt),
      CHECK (outcome = 'blocked' OR (destination IS NOT NULL AND policy_version IS NOT NULL)),
      CHECK ((outcome IN ('blocked', 'budget-exhausted')) = (reason IS NOT NULL))
    );
    INSERT INTO provider_calls_v4 (id, request_id, attempt, provider, destination, task_kind,
        classification, policy_version, outcome, reason, duration_ms, created_at)
      SELECT id, request_id, attempt, provider, destination, task_kind, classification,
        policy_version, outcome,
        CASE WHEN outcome IN ('blocked', 'budget-exhausted') THEN 'unrecorded' END,
        duration_ms, created_at
      FROM provider_calls;
    DROP TABLE provider_calls;
    ALTER TABLE provider_calls_v4 RENAME TO provider_calls;

    CREATE TABLE consents_v4 (
      id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL UNIQUE,
      destination TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      allowed_classes TEXT NOT NULL,
      granted_at TEXT NOT NULL
    );
    INSERT INTO consents_v4 (id, provider, destination, policy_version, allowed_classes, granted_at)
      SELECT id, provider, destination, policy_version, allowed_classes, granted_at FROM consents
      WHERE id IN (SELECT max(id) FROM consents GROUP BY provider);
    DROP TABLE consents;
    ALTER TABLE consents_v4 RENAME TO consents;
  `);

// R3 lists of the V02 spec: an item, fact or relation has one of each.
const EPISTEMIC = "'explicit', 'user-approved', 'inferred', 'hypothesis'";
const STATUS = "'candidate', 'verified', 'disputed', 'superseded', 'rejected'";
const KNOWLEDGE_COLUMNS = `
      epistemic TEXT NOT NULL CHECK (epistemic IN (${EPISTEMIC})),
      status TEXT NOT NULL CHECK (status IN (${STATUS})),
      valid_at TEXT,
      observed_at TEXT NOT NULL`;
// The knowledge revision rises once per changed item, fact or relation row.
const revisionTriggers = ["items", "facts", "relations"]
  .flatMap((table) =>
    ["INSERT", "UPDATE", "DELETE"].map(
      (event) => `
    CREATE TRIGGER ${table}_revision_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
      UPDATE revisions SET knowledge_revision = knowledge_revision + 1;
    END;`,
    ),
  )
  .join("");

// Schema v5 (V02-T02): the V02 spec's knowledge schema (R3), migration 5 after V01's four.
// - source_versions gains its per-source version number (1, 2, ...), which
//   fences, tombstones and engine notifications compare. A new version must be
//   greater than the source's latest, so the latest id is also the latest version,
//   and greater than its tombstone's, so a purged source never reuses a number
//   (V02-R12). It is rebuilt (a NOT NULL column cannot be added without a
//   default) with AUTOINCREMENT, so a deleted version's id is never handed out
//   again; rows keep their ids, so keyword_index rows still match, and its
//   triggers are recreated after the copy so it is not indexed twice.
// - jobs carries the source and the version it was registered for (the fence)
//   instead of a version row id: deleting a source's versions (V02-R12) must leave
//   the job for the fence to close as superseded. lease_until is the lease (R4).
// - revisions holds the change sequence (ADR 0013 decision 6), raised by triggers
//   on every new version and every tombstone written, and the knowledge revision.
//   A v4 database starts at its number of stored versions, one change each.
// - Evidence points at an immutable version; the span is [start, end) in code
//   points, which SQLite's length() and substr() count for TEXT.
// - A tombstone holds no content; the sources row (identifier only) stays.
// - An Insight is deleted with its X or Y item; a resolved one keeps no summary.
const v5: Migration = (db) =>
  db.exec(`
    PRAGMA defer_foreign_keys = ON;
    CREATE TEMP TABLE source_versions_v4 AS
      SELECT id, source_id,
        row_number() OVER (PARTITION BY source_id ORDER BY id) AS version,
        content_hash, title, body
      FROM source_versions;
    CREATE TEMP TABLE jobs_v4 AS SELECT id, kind, source_version_id, status FROM jobs;
    DROP TABLE jobs;
    DROP TABLE source_versions;

    CREATE TABLE source_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources (id),
      version INTEGER NOT NULL CHECK (version >= 1),
      content_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      UNIQUE (source_id, version)
    );
    INSERT INTO source_versions (id, source_id, version, content_hash, title, body)
      SELECT id, source_id, version, content_hash, title, body FROM source_versions_v4;

    CREATE TABLE revisions (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      change_seq INTEGER NOT NULL,
      knowledge_revision INTEGER NOT NULL
    );
    INSERT INTO revisions (id, change_seq, knowledge_revision)
      SELECT 1, count(*), 0 FROM source_versions_v4;

    CREATE TRIGGER source_versions_immutable BEFORE UPDATE ON source_versions
    BEGIN SELECT RAISE(ABORT, 'source versions are immutable'); END;
    CREATE TRIGGER source_versions_increasing BEFORE INSERT ON source_versions
    WHEN new.version <= (SELECT coalesce(max(version), 0) FROM source_versions
                          WHERE source_id = new.source_id)
    BEGIN SELECT RAISE(ABORT, 'a new source version must be greater than the latest'); END;
    CREATE TRIGGER source_versions_after_tombstone BEFORE INSERT ON source_versions
    WHEN new.version <= (SELECT version FROM tombstones WHERE source_id = new.source_id)
    BEGIN SELECT RAISE(ABORT, 'a source version must be greater than its tombstone'); END;
    CREATE TRIGGER source_versions_index AFTER INSERT ON source_versions BEGIN
      INSERT INTO keyword_index (rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER source_versions_change_seq AFTER INSERT ON source_versions BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    CREATE TRIGGER source_versions_unindex AFTER DELETE ON source_versions BEGIN
      INSERT INTO keyword_index (keyword_index, rowid, title, body)
      VALUES ('delete', old.id, old.title, old.body);
    END;

    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      source_id INTEGER NOT NULL REFERENCES sources (id),
      fence_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      lease_until TEXT,
      UNIQUE (kind, source_id, fence_version)
    );
    INSERT INTO jobs (id, kind, source_id, fence_version, status)
      SELECT j.id, j.kind, v.source_id, v.version, j.status
      FROM jobs_v4 j JOIN source_versions_v4 v ON v.id = j.source_version_id;
    DROP TABLE jobs_v4;
    DROP TABLE source_versions_v4;

    CREATE TABLE items (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,${KNOWLEDGE_COLUMNS}
    );
    CREATE TABLE facts (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items (id),
      kind TEXT NOT NULL,
      value TEXT NOT NULL,${KNOWLEDGE_COLUMNS},
      UNIQUE (item_id, kind, value)
    );
    CREATE TABLE relations (
      id INTEGER PRIMARY KEY,
      subject_id INTEGER NOT NULL REFERENCES items (id),
      type TEXT NOT NULL,
      object_id INTEGER NOT NULL REFERENCES items (id),${KNOWLEDGE_COLUMNS},
      UNIQUE (subject_id, type, object_id)
    );
    CREATE INDEX relations_object ON relations (object_id);
    ${revisionTriggers}

    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY,
      source_version_id INTEGER NOT NULL REFERENCES source_versions (id) ON DELETE CASCADE,
      fact_id INTEGER REFERENCES facts (id) ON DELETE CASCADE,
      relation_id INTEGER REFERENCES relations (id) ON DELETE CASCADE,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      quote TEXT NOT NULL,
      CHECK ((fact_id IS NULL) <> (relation_id IS NULL)),
      CHECK (start_offset >= 0 AND end_offset > start_offset
             AND length(quote) = end_offset - start_offset)
    );
    CREATE UNIQUE INDEX evidence_fact_span ON evidence
      (fact_id, source_version_id, start_offset, end_offset) WHERE fact_id IS NOT NULL;
    CREATE UNIQUE INDEX evidence_relation_span ON evidence
      (relation_id, source_version_id, start_offset, end_offset) WHERE relation_id IS NOT NULL;
    CREATE INDEX evidence_source_version ON evidence (source_version_id);
    CREATE TRIGGER evidence_immutable BEFORE UPDATE ON evidence
    BEGIN SELECT RAISE(ABORT, 'evidence is immutable'); END;

    CREATE TABLE insights (
      id INTEGER PRIMARY KEY,
      rule TEXT NOT NULL,
      x_item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      y_item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      epistemic TEXT NOT NULL CHECK (epistemic IN (${EPISTEMIC})),
      state TEXT NOT NULL CHECK (state IN ('active', 'dirty', 'resolved')),
      summary TEXT,
      UNIQUE (rule, x_item_id, y_item_id),
      CHECK ((state = 'resolved') = (summary IS NULL))
    );
    CREATE INDEX insights_y ON insights (y_item_id);
    CREATE TABLE insight_evidence (
      insight_id INTEGER NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
      evidence_id INTEGER NOT NULL REFERENCES evidence (id) ON DELETE CASCADE,
      PRIMARY KEY (insight_id, evidence_id)
    ) WITHOUT ROWID;
    CREATE INDEX insight_evidence_evidence ON insight_evidence (evidence_id);

    CREATE TABLE tombstones (
      source_id INTEGER PRIMARY KEY REFERENCES sources (id),
      version INTEGER NOT NULL CHECK (version >= 1),
      at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('deleted', 'access-revoked'))
    );
    CREATE TRIGGER tombstones_insert AFTER INSERT ON tombstones BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    CREATE TRIGGER tombstones_update AFTER UPDATE ON tombstones BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
  `);

// Schema v6 (V02-T03): why a job was held or failed, as a code (never Provider
// text), so the screen can show it (ARCHITECTURE section 7). Statuses: queued,
// leased, done, superseded, held, failed (storage/src/jobs.ts).
const v6: Migration = (db) => db.exec("ALTER TABLE jobs ADD COLUMN reason TEXT;");

/** Index i holds the migration that brings the schema to version i + 1. */
export const migrations: readonly Migration[] = [v1, v2, v3, v4, v5, v6];

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
