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
// text), so the screen can show it (ARCHITECTURE section 7), and the lease token,
// raised on every claim, so only the current holder calls the Broker and closes
// the job. Statuses: queued, leased, done, superseded, held, failed (renamed in v11).
const v6: Migration = (db) =>
  db.exec(`
    ALTER TABLE jobs ADD COLUMN reason TEXT;
    ALTER TABLE jobs ADD COLUMN lease_token INTEGER NOT NULL DEFAULT 0;
  `);

// Schema v7 (V02-T04, cross-spec decision D1): the Connector's own version of a
// record (a JSONL line's `version`), kept beside the product's per-source version
// and compared to order arrivals (storage/src/sources.ts). Null where the
// Connector gives none (V01 Connectors, rows from before v7).
const v7: Migration = (db) =>
  db.exec(
    "ALTER TABLE source_versions ADD COLUMN revision INTEGER CHECK (revision IS NULL OR revision >= 1);",
  );

// Schema v8 (V02-T05, V02-R6): how many facts and relations an extraction
// dropped, counted where its result is written: quotes the body did not hold
// exactly once, and anything else (an unknown candidate, a bad date). Null for a
// job that wrote no extraction (other kinds, rows from before v8).
const v8: Migration = (db) =>
  db.exec(`
    ALTER TABLE jobs ADD COLUMN dropped_quotes INTEGER CHECK (dropped_quotes >= 0);
    ALTER TABLE jobs ADD COLUMN dropped_other INTEGER CHECK (dropped_other >= 0);
  `);

// Schema v9 (V02-T08, V02-R12; reasons agreed with the I01 and I04 specs):
// - A tombstone's reason tells who deleted: `user-deleted` (the screen's
//   request), `source-deleted` (the Connector reported it gone) or
//   `access-revoked`. A v8 `deleted` row cannot tell the two apart, so it becomes
//   `user-deleted`, the one that never lets the source back (as I04 decides).
//   The table is rebuilt under its own name (a rename would fail on the
//   source_versions trigger that names it) and its triggers recreated.
// - The keyword index's FTS5 `secure-delete` option, kept in the index itself:
//   a deleted version's words leave the index's segments instead of staying
//   behind as delete markers. PRAGMA secure_delete, which zeroes freed pages, is
//   per connection and is set where a connection opens (the driver adapter).
const v9: Migration = (db) =>
  db.exec(`
    CREATE TEMP TABLE tombstones_v8 AS SELECT source_id, version, at, reason FROM tombstones;
    DROP TABLE tombstones;
    CREATE TABLE tombstones (
      source_id INTEGER PRIMARY KEY REFERENCES sources (id),
      version INTEGER NOT NULL CHECK (version >= 1),
      at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('user-deleted', 'source-deleted', 'access-revoked'))
    );
    INSERT INTO tombstones (source_id, version, at, reason)
      SELECT source_id, version, at,
        CASE reason WHEN 'deleted' THEN 'user-deleted' ELSE reason END
      FROM tombstones_v8;
    DROP TABLE tombstones_v8;
    CREATE TRIGGER tombstones_insert AFTER INSERT ON tombstones BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    CREATE TRIGGER tombstones_update AFTER UPDATE ON tombstones BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    INSERT INTO keyword_index (keyword_index, rank) VALUES ('secure-delete', 1);
  `);

// Schema v10 (I04-T01, I04-R4): one invalidation record per propagation, written
// in the propagating transaction (so a rollback leaves none). It holds no content:
// the change sequence, the source's internal id, the change kind (for a tombstone,
// its reason) and, per registered derivative kind, how many rows were removed and
// recomputed (JSON objects of counts, filled when the propagation ends). Ids are
// never reused: a re-extraction job's target names one (`scope-recompute:<id>`, I04-R15).
const v10: Migration = (db) =>
  db.exec(`
    CREATE TABLE invalidations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      change_seq INTEGER NOT NULL CHECK (change_seq >= 0),
      source_id INTEGER NOT NULL REFERENCES sources (id),
      change_kind TEXT NOT NULL CHECK (change_kind IN ('new-version', 'old-versions-pruned',
        'scope-changed', 'source-deleted', 'access-revoked', 'user-deleted')),
      removed_by_kind TEXT NOT NULL DEFAULT '{}',
      recomputed_by_kind TEXT NOT NULL DEFAULT '{}',
      at TEXT NOT NULL
    );
  `);

// Schema v11 (I03-T01, I03-R1, R2): the job table of the persistent queue,
// rebuilt under its own name (SQLite cannot drop NOT NULL from source_id).
// - Eight statuses under a CHECK; V02-T03's are renamed: leased -> running,
//   done -> succeeded, failed -> dead_letter (a V02 failure was final, so it
//   becomes a dead letter the user can retry), the rest kept. `reason` stays.
// - A job may have no source (a Connector sync, a projection rebuild, cleanup);
//   source and fence version come together, and the kinds fenced by a source
//   (extract, projection-remove) must have one. `target` names a projection or
//   Connector instance, '' when none.
// - Every time is UTC milliseconds (an ISO TEXT always sorts above an INTEGER,
//   so a converted lease would otherwise never expire). Migrated rows get the
//   migration time as created/updated/run-at, and as finished time when their
//   status is done (succeeded, superseded, dead_letter); attempts 0, token kept,
//   priority 'user', fairness key the source's Connector instance (the kind if
//   its source row is gone: every row is copied, never dropped), the change
//   sequence of now, no policy fingerprint (empty means changed).
// - Duplicate guards: (kind, target, source, fence version); (schedule, slot);
//   and, since UNIQUE never binds NULLs, one open job per (kind, target) among
//   sourceless jobs, and one open job per schedule. The schedule table arrives
//   with I03-T08, so schedule_id carries no foreign key yet.
// - The setting recording the policy version held jobs were last judged under
//   (`jobs.held-policy-version`, the V02 backend's) is removed; the first start
//   judges the migrated held jobs once by their empty fingerprint (I03-R2, held-release.ts).
const OPEN_STATUSES = "('queued', 'running', 'retry', 'held')";
const NOW_MS = "CAST(round((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";
const v11: Migration = (db) =>
  db.exec(`
    CREATE TEMP TABLE jobs_v10 AS
      SELECT j.id, j.kind, j.source_id, j.fence_version, j.status, j.lease_until, j.reason,
             j.lease_token, j.dropped_quotes, j.dropped_other,
             coalesce(s.connector_instance_id, j.kind) AS fairness_key
        FROM jobs j LEFT JOIN sources s ON s.id = j.source_id;
    DROP TABLE jobs;
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      source_id INTEGER REFERENCES sources (id),
      fence_version INTEGER,
      status TEXT NOT NULL CHECK (status IN
        ('queued', 'running', 'retry', 'held', 'succeeded', 'superseded', 'cancelled', 'dead_letter')),
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      run_after INTEGER NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER,
      heartbeat_at INTEGER,
      priority TEXT NOT NULL DEFAULT 'user' CHECK (priority IN ('user', 'scheduled', 'maintenance')),
      fairness_key TEXT NOT NULL,
      schedule_id INTEGER,
      slot INTEGER,
      checkpoint TEXT,
      result_counts TEXT,
      policy_fingerprint TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      registered_change_seq INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      dropped_quotes INTEGER CHECK (dropped_quotes >= 0),
      dropped_other INTEGER CHECK (dropped_other >= 0),
      CHECK ((source_id IS NULL) = (fence_version IS NULL)),
      CHECK (source_id IS NOT NULL OR kind NOT IN ('extract', 'projection-remove')),
      CHECK ((schedule_id IS NULL) = (slot IS NULL)),
      UNIQUE (kind, target, source_id, fence_version),
      UNIQUE (schedule_id, slot)
    );
    CREATE UNIQUE INDEX jobs_open_sourceless ON jobs (kind, target)
      WHERE source_id IS NULL AND status IN ${OPEN_STATUSES};
    CREATE UNIQUE INDEX jobs_open_per_schedule ON jobs (schedule_id)
      WHERE schedule_id IS NOT NULL AND status IN ${OPEN_STATUSES};
    CREATE INDEX jobs_source ON jobs (source_id);
    INSERT INTO jobs (id, kind, source_id, fence_version, status, reason, lease_token,
        lease_until, run_after, fairness_key, registered_change_seq, created_at, updated_at,
        finished_at, dropped_quotes, dropped_other)
      SELECT id, kind, source_id, fence_version,
        CASE status WHEN 'leased' THEN 'running' WHEN 'done' THEN 'succeeded'
          WHEN 'failed' THEN 'dead_letter' ELSE status END,
        reason, lease_token,
        CASE WHEN lease_until IS NULL THEN NULL
          ELSE CAST(round((julianday(lease_until) - 2440587.5) * 86400000) AS INTEGER) END,
        ${NOW_MS}, fairness_key, (SELECT change_seq FROM revisions), ${NOW_MS}, ${NOW_MS},
        CASE WHEN status IN ('done', 'failed', 'superseded') THEN ${NOW_MS} END,
        dropped_quotes, dropped_other
      FROM jobs_v10;
    DROP TABLE jobs_v10;
    DELETE FROM settings WHERE key = 'jobs.held-policy-version';
  `);

// Schema v12 (I01-T01, I01-R8): a source is identified by instance + namespace +
// external id; the namespace is where an external id is unique within one
// instance (one wiki space, one mailbox), "" when it has one range. A v11 source
// takes "". sources is rebuilt the v2 way (the UNIQUE constraint cannot change in
// place): copied aside, dropped and recreated under its own name so the tables
// referencing it (source_versions, jobs, tombstones, invalidations) keep that reference; no
// reference cascades, and defer_foreign_keys holds their check until the rows are
// back. The namespace has no default: whoever writes a source names it.
const v12: Migration = (db) =>
  db.exec(`
    PRAGMA defer_foreign_keys = ON;
    CREATE TEMP TABLE sources_v11 AS
      SELECT id, connector_instance_id, external_id, access_scope FROM sources;
    DROP TABLE sources;
    CREATE TABLE sources (
      id INTEGER PRIMARY KEY,
      connector_instance_id TEXT NOT NULL REFERENCES connector_instances (id),
      namespace TEXT NOT NULL,
      external_id TEXT NOT NULL,
      access_scope TEXT,
      UNIQUE (connector_instance_id, namespace, external_id)
    );
    INSERT INTO sources (id, connector_instance_id, namespace, external_id, access_scope)
      SELECT id, connector_instance_id, '', external_id, access_scope FROM sources_v11;
    DROP TABLE sources_v11;
  `);

// Schema v13 (I04-T05, I04-R9): the tombstone's shape.
// - `version` becomes `covers_version`: the tombstone covers every product version
//   up to it, 0 for a source deleted before any version was stored. It is also the
//   high-water mark of the source's version numbers once its versions are purged.
// - `last_revision`: the source system's revision at the deletion, empty for the
//   screen's deletion and for rows from before v13. `lifted_at`: when the user
//   lifted it, empty while it blocks arrivals.
// - Both numbers are whole (typeof checks: INTEGER affinity alone keeps 5.5 as it is).
// - Every row is copied: nothing a v12 row holds is dropped; a v12 row whose version is
//   not a whole number (only hand-written SQL could store one) fails the whole migration. The three reasons stay
//   (v9 already turned `deleted` into `user-deleted`, and its CHECK admits no other).
// - The table is rebuilt under its own name, as in v9 (its CHECK changes). Its
//   triggers: an insert raises the change sequence, an update only when the cover
//   moves (a reason change, a revision or a lift changes no content), and a source
//   version at or below the cover is refused, lifted or not (a number is never reused).
const v13: Migration = (db) =>
  db.exec(`
    CREATE TEMP TABLE tombstones_v12 AS SELECT source_id, version, at, reason FROM tombstones;
    DROP TABLE tombstones;
    CREATE TABLE tombstones (
      source_id INTEGER PRIMARY KEY REFERENCES sources (id),
      covers_version INTEGER NOT NULL
        CHECK (typeof(covers_version) = 'integer' AND covers_version >= 0),
      last_revision INTEGER
        CHECK (last_revision IS NULL OR (typeof(last_revision) = 'integer' AND last_revision >= 1)),
      at TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('user-deleted', 'source-deleted', 'access-revoked')),
      lifted_at TEXT
    );
    INSERT INTO tombstones (source_id, covers_version, at, reason)
      SELECT source_id, version, at, reason FROM tombstones_v12;
    DROP TABLE tombstones_v12;
    CREATE TRIGGER tombstones_insert AFTER INSERT ON tombstones BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    CREATE TRIGGER tombstones_update AFTER UPDATE ON tombstones
    WHEN new.covers_version <> old.covers_version BEGIN
      UPDATE revisions SET change_seq = change_seq + 1;
    END;
    DROP TRIGGER source_versions_after_tombstone;
    CREATE TRIGGER source_versions_after_tombstone BEFORE INSERT ON source_versions
    WHEN new.version <= (SELECT covers_version FROM tombstones WHERE source_id = new.source_id)
    BEGIN SELECT RAISE(ABORT, 'a source version must be greater than its tombstone'); END;
  `);

// Schema v14 (I04-T07, I04-R7): the installation's identity key and the mark of a
// source whose identifier is the keyed hash. The key lives in the canonical
// database (one row, 32 random bytes), not in the secrets store: losing a key
// there would silently void every deletion. `identity_hashed` is how a start finds
// whether any hash exists (a missing key then stops it); the hashing itself needs
// HMAC and runs after `migrate` (identity.ts).
const v14: Migration = (db) =>
  db.exec(`
    CREATE TABLE identity_key (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key BLOB NOT NULL CHECK (typeof(key) = 'blob' AND length(key) = 32)
    );
    INSERT INTO identity_key (id, key) VALUES (1, randomblob(32));
    ALTER TABLE sources ADD COLUMN identity_hashed INTEGER NOT NULL DEFAULT 0
      CHECK (identity_hashed IN (0, 1));
  `);

// Schema v15 (I03-T08, I03-R18): the schedule table. One row per (kind, target), the
// period as the JSON of the backend's Period (opaque here) with the zone its daily
// and weekly slots were computed in, the next due time, the slot of the last run,
// the pause code, and the counters the activity screen shows. jobs.schedule_id
// points here by value (no reference: v11 left the column plain and a schedule is
// never deleted). No default schedule is written: I03-T09 creates them.
const v15: Migration = (db) =>
  db.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      target TEXT NOT NULL DEFAULT '',
      period TEXT NOT NULL,
      zone TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      next_due INTEGER NOT NULL,
      last_run_slot INTEGER,
      paused_code TEXT,
      failure_seen_job INTEGER NOT NULL DEFAULT 0,
      revived_job INTEGER NOT NULL DEFAULT 0,
      warning TEXT,
      last_missed INTEGER NOT NULL DEFAULT 0,
      registered_count INTEGER NOT NULL DEFAULT 0,
      coalesced_count INTEGER NOT NULL DEFAULT 0,
      held_coalesced_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      already_ran_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (kind, target)
    );
  `);

// Schema v16 (I01-T02, I01-R9, R13): what a Connector's record leaves in the store.
// - `sources.last_revision`: the greatest revision the source system gave that the
//   store accepted (arrivals are ordered by it; it outlives a purge and a lift),
//   empty for a source from before it. `sources.scope_claimed`: 1 when the scope
//   is a user's own claim (an import, I01-R15), set by the arrival path.
// - `source_versions` gains the record's schema version (rows so far are 1), the
//   provenance (JSON: author, participants, times, metadata) and the blocks (JSON).
//   They belong to the version and go with it (I01-R13). Columns are added, not
//   rebuilt as v5 did: ADD COLUMN rewrites no row, so ids, triggers, the keyword
//   index and every table pointing at a version stay as they were, and the
//   immutability trigger (which guards UPDATE) is never fired.
// - `tombstones.last_revision` is I04-T05's (v13); nothing here.
const v16: Migration = (db) =>
  db.exec(`
    ALTER TABLE sources ADD COLUMN last_revision INTEGER
      CHECK (last_revision IS NULL OR (typeof(last_revision) = 'integer' AND last_revision >= 1));
    ALTER TABLE sources ADD COLUMN scope_claimed INTEGER NOT NULL DEFAULT 0
      CHECK (scope_claimed IN (0, 1));
    ALTER TABLE source_versions ADD COLUMN record_schema_version INTEGER NOT NULL DEFAULT 1
      CHECK (record_schema_version >= 1);
    ALTER TABLE source_versions ADD COLUMN meta TEXT CHECK (meta IS NULL OR json_valid(meta));
    ALTER TABLE source_versions ADD COLUMN blocks TEXT CHECK (blocks IS NULL OR json_valid(blocks));
  `);

// Schema v17 (I01-T03, I01-R17): the state of a rescan on the instance row.
// `rescan_pending` is 1 from the moment a sync drops an expired cursor until the page
// that ends the rescan is stored, so a rescan that did not end in one sync is finished
// by the next. `deletions_may_be_missed` is 1 after a rescan of a Connector that does not
// report deletions on rescan; the Sources screen shows it until the next rescan ends
// (I01-R17). The version number is the next free one: whichever of two tasks adding a
// migration merges later renumbers (`v17` and its line in `migrations`).
const v17: Migration = (db) =>
  db.exec(`
    ALTER TABLE connector_instances ADD COLUMN rescan_pending INTEGER NOT NULL DEFAULT 0
      CHECK (rescan_pending IN (0, 1));
    ALTER TABLE connector_instances ADD COLUMN deletions_may_be_missed INTEGER NOT NULL DEFAULT 0
      CHECK (deletions_may_be_missed IN (0, 1));
  `);

/** Index i holds the migration that brings the schema to version i + 1. */
export const migrations: readonly Migration[] = [
  v1,
  v2,
  v3,
  v4,
  v5,
  v6,
  v7,
  v8,
  v9,
  v10,
  v11,
  v12,
  v13,
  v14,
  v15,
  v16,
  v17,
];

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
