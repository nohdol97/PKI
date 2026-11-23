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

// Schema v18 (I04-T09, I04-R4, R11, R15): what the scope policy left out of an extraction.
// One row per refused item: the source and the version of the extraction's input, the
// kind of the item, the keyed hash of its key (I04-R7: the key is names and values) and
// when. No content. The rows are not job rows, so the jobs' retention clean-up does not
// delete them; they are the registered kind `scope-drop`, so deleting the source deletes
// them. `(source_id, version, kind, item_key_hash)` is unique: extracting again records
// the same refusal once. A source's rows are cleared when its re-extraction (queued when
// a scope change makes the refusal worth judging again) has run. The version number is
// the next free one: whichever of two tasks adding a migration merges later renumbers
// (`v18` and its line in `migrations`).
const v18: Migration = (db) =>
  db.exec(`
    CREATE TABLE scope_policy_drops (
      id INTEGER PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES sources (id),
      version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
      kind TEXT NOT NULL,
      item_key_hash TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason = 'scope-policy'),
      at TEXT NOT NULL,
      UNIQUE (source_id, version, kind, item_key_hash)
    );
  `);

// Schema v19 (I01-T06, I01-R15): the scope the deployment configured for an instance, copied
// from the site registration's `connectorScopes` at start. NULL is "unknown" (the public default:
// the registration carries none), otherwise a JSON array of strings. The Broker compares an
// imported (claimed) scope with it. It is a column of an operational table, not a
// derivative, and no API route returns it. The version number is the next free one:
// whichever of two tasks adding a migration merges later renumbers (`v19` and its line in
// `migrations`).
const v19: Migration = (db) =>
  db.exec(`
    ALTER TABLE connector_instances ADD COLUMN configured_scope TEXT
      CHECK (configured_scope IS NULL
        OR (json_valid(configured_scope) AND json_type(configured_scope) = 'array'));
  `);

// Schema v20 (S01-T01, S01-R1, R5, R6, R10, R15): the Semantic registry sits on the item, fact
// and relation rows (V02-R3). Each gains `confidence` (the model's own 0..1 number, kept apart from
// the epistemic type, R10) and `user_authored` (a value the user wrote, R14); a fact gains `context`
// (R3). Rows so far keep their status and epistemic type: confidence and context are NULL,
// user_authored 0.
// - A history table per kind (R6) holds one line per creation, transition or restore: numbers and
//   codes only, never a name, value or quote. It cannot be updated, and a line cannot be deleted
//   while its row stands; the cascade of the row's own delete passes (the parent is gone by then, so
//   the guard's WHEN is false; S01 spec "S01-T01이 넘기는 것" 1). No line is invented for older rows.
//   The basis is a source id and version, not a foreign key: a number outlives a deleted version
//   (R6, provisional decision 16).
// - The gate (R5): status, epistemic type and user_authored change only when the row's newest history
//   line says that very change, so the one module that writes the line first and then updates the row
//   (storage/src/semantic-lifecycle.ts) passes and a bare UPDATE does not. An INSERT is not blocked.
// - `insight_user_inputs` (R15) ties an Insight to the fact or relation (a user-input row, R15) it used; it
//   is written from S01-T04 on and goes with the Insight or the row.
// The version number is the next free one: whichever of two tasks adding a migration merges later
// renumbers (`v20` and its line in `migrations`).
const confidenceColumn = `REAL CHECK (confidence IS NULL
  OR (typeof(confidence) IN ('real', 'integer') AND confidence >= 0 AND confidence <= 1))`;
const authoredColumn = "INTEGER NOT NULL DEFAULT 0 CHECK (user_authored IN (0, 1))";
const lifecycleKinds = [
  { table: "items", history: "item_history", fk: "item_id" },
  { table: "facts", history: "fact_history", fk: "fact_id" },
  { table: "relations", history: "relation_history", fk: "relation_id" },
] as const;
const v20: Migration = (db) =>
  db.exec(`
    ALTER TABLE items ADD COLUMN confidence ${confidenceColumn};
    ALTER TABLE items ADD COLUMN user_authored ${authoredColumn};
    ALTER TABLE facts ADD COLUMN confidence ${confidenceColumn};
    ALTER TABLE facts ADD COLUMN user_authored ${authoredColumn};
    ALTER TABLE facts ADD COLUMN context TEXT;
    ALTER TABLE relations ADD COLUMN confidence ${confidenceColumn};
    ALTER TABLE relations ADD COLUMN user_authored ${authoredColumn};
    ${lifecycleKinds
      .map(
        ({ table, history, fk }) => `
    CREATE TABLE ${history} (
      ${fk} INTEGER NOT NULL REFERENCES ${table} (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      at TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('user', 'extraction', 'propagation', 'policy')),
      action TEXT NOT NULL,
      from_status TEXT CHECK (from_status IN (${STATUS})),
      to_status TEXT NOT NULL CHECK (to_status IN (${STATUS})),
      from_epistemic TEXT CHECK (from_epistemic IN (${EPISTEMIC})),
      to_epistemic TEXT NOT NULL CHECK (to_epistemic IN (${EPISTEMIC})),
      reason TEXT,
      basis_source_id INTEGER,
      basis_version INTEGER,
      batch INTEGER,
      reverts_seq INTEGER,
      PRIMARY KEY (${fk}, seq),
      CHECK ((basis_source_id IS NULL) = (basis_version IS NULL))
    ) WITHOUT ROWID;
    CREATE TRIGGER ${history}_no_update BEFORE UPDATE ON ${history}
    BEGIN SELECT RAISE(ABORT, 'history lines are immutable'); END;
    CREATE TRIGGER ${history}_no_delete BEFORE DELETE ON ${history}
    WHEN EXISTS (SELECT 1 FROM ${table} WHERE id = old.${fk})
    BEGIN SELECT RAISE(ABORT, 'history lines are deleted only with their row'); END;
    CREATE TRIGGER ${table}_lifecycle_gate BEFORE UPDATE OF status, epistemic, user_authored ON ${table}
    WHEN (new.status IS NOT old.status OR new.epistemic IS NOT old.epistemic
          OR new.user_authored IS NOT old.user_authored)
      AND NOT EXISTS (
        SELECT 1 FROM ${history} h
        WHERE h.${fk} = old.id
          AND h.seq = (SELECT max(seq) FROM ${history} WHERE ${fk} = old.id)
          AND h.from_status = old.status AND h.to_status = new.status
          AND h.from_epistemic = old.epistemic AND h.to_epistemic = new.epistemic
          AND (new.user_authored IS old.user_authored OR h.action = 'undo'))
    BEGIN SELECT RAISE(ABORT, 'status, epistemic type and user_authored change only through the lifecycle gate'); END;`,
      )
      .join("")}

    CREATE TABLE insight_user_inputs (
      insight_id INTEGER NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
      fact_id INTEGER REFERENCES facts (id) ON DELETE CASCADE,
      relation_id INTEGER REFERENCES relations (id) ON DELETE CASCADE,
      CHECK ((fact_id IS NULL) <> (relation_id IS NULL))
    );
    CREATE UNIQUE INDEX insight_user_inputs_fact ON insight_user_inputs (insight_id, fact_id)
      WHERE fact_id IS NOT NULL;
    CREATE UNIQUE INDEX insight_user_inputs_relation ON insight_user_inputs (insight_id, relation_id)
      WHERE relation_id IS NOT NULL;
    CREATE INDEX insight_user_inputs_fact_row ON insight_user_inputs (fact_id);
    CREATE INDEX insight_user_inputs_relation_row ON insight_user_inputs (relation_id);
  `);

// Schema v21 (S01-T06, S01-R18, R20, R22): the type-definition registry (ontology elements).
// - `ontology_elements`: one row per item type, fact kind or relation type: the name (an identifier,
//   no text), its rule as JSON of the kind's fixed shape, its status (the same five) and its edition
//   (1 when it is added, +1 for every applied rule change or retirement). A change to the table
//   raises the knowledge revision (R18).
// - `ontology_basis` (the lineage, R20): the source versions a candidate was proposed from, as numbers
//   (no foreign key, as in a history line); a verified element keeps its rows and is read as having
//   none, and the row goes with its source (R22).
// - `ontology_history` (R6): one line per creation, transition or rule change, numbers and codes
//   only: the before and after edition, never a name, rule or text. As in v20 it cannot be updated,
//   and a line is deleted only with its element (the cascade passes: the parent is gone by then).
// - An element's name and kind never change (a rename would skip every R19 check).
// - The gate: status, rule and edition change only when the newest history line says that very
//   change, and a rule changes only together with its edition. An INSERT is not blocked.
// - The seed (R18): what the code constants held (Project, System, target_date, completion_date,
//   DEPENDS_ON) and R4's (Concept, definition, alias.*), all verified, edition 1, with no history line
//   (as rows before v20 have none, R6). The revision triggers are made after the seed, so a database
//   that is upgraded does not see its knowledge revision move.
// The version number is the next free one: whichever of two tasks adding a migration merges later
// renumbers (`v21` and its line in `migrations`).
const ITEM_TYPES = ["Project", "System", "Concept"] as const;
const ONTOLOGY_SEED: readonly (readonly [string, string, object])[] = [
  ...ITEM_TYPES.map((name) => ["item-type", name, { elementKind: "item-type" }] as const),
  ...["target_date", "completion_date"].map(
    (name) =>
      [
        "fact-kind",
        name,
        {
          elementKind: "fact-kind",
          itemTypes: ["Project", "System"],
          valueType: "date",
          cardinality: "one",
        },
      ] as const,
  ),
  [
    "fact-kind",
    "definition",
    { elementKind: "fact-kind", itemTypes: ["Concept"], valueType: "text", cardinality: "many" },
  ],
  ...["alias.synonym", "alias.abbreviation", "alias.translation"].map(
    (name) =>
      [
        "fact-kind",
        name,
        {
          elementKind: "fact-kind",
          itemTypes: ["Concept", "Project", "System"],
          valueType: "surface-form",
          cardinality: "many",
        },
      ] as const,
  ),
  [
    "relation-type",
    "DEPENDS_ON",
    {
      elementKind: "relation-type",
      subjectTypes: ["Project", "System"],
      objectTypes: ["Project", "System"],
      symmetric: false,
    },
  ],
];
const v21: Migration = (db) => {
  db.exec(`
    CREATE TABLE ontology_elements (
      id INTEGER PRIMARY KEY,
      element_kind TEXT NOT NULL CHECK (element_kind IN ('item-type', 'fact-kind', 'relation-type')),
      name TEXT NOT NULL CHECK (name GLOB '[A-Za-z]*' AND name NOT GLOB '*[^A-Za-z0-9_.]*'
        AND length(name) <= 40),
      rule TEXT NOT NULL CHECK (json_valid(rule) AND json_type(rule) = 'object'),
      status TEXT NOT NULL CHECK (status IN (${STATUS})),
      edition INTEGER NOT NULL CHECK (typeof(edition) = 'integer' AND edition >= 1),
      UNIQUE (element_kind, name)
    );
    CREATE TABLE ontology_basis (
      element_id INTEGER NOT NULL REFERENCES ontology_elements (id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL,
      version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
      PRIMARY KEY (element_id, source_id, version)
    ) WITHOUT ROWID;
    CREATE INDEX ontology_basis_source ON ontology_basis (source_id, version);
    CREATE TABLE ontology_history (
      element_id INTEGER NOT NULL REFERENCES ontology_elements (id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      at TEXT NOT NULL,
      actor TEXT NOT NULL CHECK (actor IN ('user', 'extraction', 'propagation', 'policy')),
      action TEXT NOT NULL,
      from_status TEXT CHECK (from_status IN (${STATUS})),
      to_status TEXT NOT NULL CHECK (to_status IN (${STATUS})),
      from_edition INTEGER,
      to_edition INTEGER NOT NULL CHECK (to_edition >= 1),
      reason TEXT,
      basis_source_id INTEGER,
      basis_version INTEGER,
      batch INTEGER,
      reverts_seq INTEGER,
      PRIMARY KEY (element_id, seq),
      CHECK ((basis_source_id IS NULL) = (basis_version IS NULL))
    ) WITHOUT ROWID;
    CREATE TRIGGER ontology_history_no_update BEFORE UPDATE ON ontology_history
    BEGIN SELECT RAISE(ABORT, 'history lines are immutable'); END;
    CREATE TRIGGER ontology_history_no_delete BEFORE DELETE ON ontology_history
    WHEN EXISTS (SELECT 1 FROM ontology_elements WHERE id = old.element_id)
    BEGIN SELECT RAISE(ABORT, 'history lines are deleted only with their row'); END;
    CREATE TRIGGER ontology_elements_lifecycle_gate
    BEFORE UPDATE OF status, rule, edition ON ontology_elements
    WHEN (new.status IS NOT old.status OR new.rule IS NOT old.rule OR new.edition IS NOT old.edition)
      AND ((new.rule IS NOT old.rule AND new.edition IS old.edition)
        OR NOT EXISTS (
          SELECT 1 FROM ontology_history h
          WHERE h.element_id = old.id
            AND h.seq = (SELECT max(seq) FROM ontology_history WHERE element_id = old.id)
            AND h.from_status = old.status AND h.to_status = new.status
            AND h.from_edition = old.edition AND h.to_edition = new.edition))
    BEGIN SELECT RAISE(ABORT, 'status, rule and edition change only through the ontology gate'); END;
    CREATE TRIGGER ontology_elements_identity_fixed BEFORE UPDATE OF name, element_kind ON ontology_elements
    BEGIN SELECT RAISE(ABORT, 'an element keeps its name and kind'); END;
  `);
  for (const [elementKind, name, rule] of ONTOLOGY_SEED) {
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition) VALUES (?, ?, ?, 'verified', 1)",
      [elementKind, name, JSON.stringify(rule)],
    );
  }
  db.exec(
    ["INSERT", "UPDATE", "DELETE"]
      .map(
        (event) => `
    CREATE TRIGGER ontology_elements_revision_${event.toLowerCase()} AFTER ${event} ON ontology_elements BEGIN
      UPDATE revisions SET knowledge_revision = knowledge_revision + 1;
    END;`,
      )
      .join(""),
  );
};

// Schema v22 (I02B-T02, I02B-R33, D11): the local file index. Three tables and the trigger that
// scrubs the index when a tombstone is written.
// - `local_locations`: the places the user approved (an operational table: settings, no source content).
//   The ids are 22 base64url characters (I02B-R2): a longer id would make the ledger refuse a deletion.
//   `root_dev`/`root_ino` are decimal text (a 64-bit file number does not fit a JS number).
// - `local_index_seq`: ONE row, the counter every sequence number comes from. It never goes down and
//   is never deleted, so the sequence is not derived from the entries' MAX(seq): a revoke that deletes
//   the greatest row would otherwise hand the number out again, at or below a cursor already given.
// - `local_file_entries`: one row per file, classified as source identity (not a derivative kind).
//   Plaintext columns (path, content hash, size, mtime, file number) exist only on the live states;
//   the keyed hashes are written with the row, so scrubbing is one UPDATE with no key needed.
// - The trigger: a tombstone row written (inserted, or updated while not lifted) scrubs the entry of
//   that source in the same transaction, whichever code wrote it. The source row is plain
//   (namespace = location id, external id = file id) or already the keyed hash (= `identity_hash`). Only
//   instance `local-files`: a JSONL line's namespace and external id are untrusted text. An entry that
//   is no longer live (`deleted`, `forgotten`) is left alone, so a collector's own `deleted` write
//   followed by the `delete` it caused does not take a second sequence number.
/** Decimal text: digits only (a 64-bit number does not fit a JS number, so it is kept as text). */
const DECIMAL = (column: string) => `${column} <> '' AND ${column} NOT GLOB '*[^0-9]*'`;
/** A file number: the inode, or `dev:ino`, each decimal. */
const FILE_NO = (column: string) =>
  `${column} GLOB '[0-9]*' AND ${column} NOT GLOB '*[^0-9:]*' AND ${column} NOT GLOB '*:*:*' AND ${column} NOT GLOB '*:'`;
const LOCAL_ID_SHAPE = (column: string) =>
  `length(${column}) = 22 AND ${column} NOT GLOB '*[^A-Za-z0-9_-]*'`;
// The entry a tombstone names, found by index and not by scan: the source row is read once (plain: its
// namespace and external id are the location id and file id, primary key `external_id`; hashed: its
// namespace is `identity_hash`, a unique index), so the plan is a MULTI-INDEX OR on those two. The
// instance is decided once, in the trigger's WHEN, so the tombstone of any other connector costs one
// primary-key read of `sources`.
const ofSource = (column: string, hashed: 0 | 1) =>
  `(SELECT ${column} FROM sources WHERE id = new.source_id AND identity_hashed = ${hashed})`;
const localEntryOfTombstone = (entry: string) => `
  ${entry}.state IN ('present', 'skipped')
  AND ((${entry}.external_id = ${ofSource("external_id", 0)}
        AND ${entry}.location_id = ${ofSource("namespace", 0)})
    OR ${entry}.identity_hash = ${ofSource("namespace", 1)})`;
const v22: Migration = (db) =>
  db.exec(`
    CREATE TABLE local_locations (
      id TEXT PRIMARY KEY CHECK (${LOCAL_ID_SHAPE("id")}),
      type TEXT NOT NULL CHECK (type IN ('folder', 'file', 'jsonl-file')),
      display_path TEXT NOT NULL,
      real_path TEXT NOT NULL,
      root_dev TEXT NOT NULL CHECK (${DECIMAL("root_dev")}),
      root_ino TEXT NOT NULL CHECK (${DECIMAL("root_ino")}),
      state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'paused', 'unavailable', 'needs-confirmation', 'revoking')),
      state_reason TEXT,
      limit_exceeded INTEGER NOT NULL DEFAULT 0 CHECK (limit_exceeded IN (0, 1)),
      last_pass_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE local_index_seq (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL CHECK (typeof(value) = 'integer' AND value >= 0)
    );
    INSERT INTO local_index_seq (id, value) VALUES (1, 0);
    CREATE TRIGGER local_index_seq_single BEFORE INSERT ON local_index_seq
    BEGIN SELECT RAISE(ABORT, 'the local index sequence has one row, made by the migration'); END;
    CREATE TRIGGER local_index_seq_never_down BEFORE UPDATE ON local_index_seq
    WHEN new.value < old.value
    BEGIN SELECT RAISE(ABORT, 'the local index sequence never goes down'); END;
    CREATE TRIGGER local_index_seq_keep BEFORE DELETE ON local_index_seq
    BEGIN SELECT RAISE(ABORT, 'the local index sequence row is never deleted'); END;
    CREATE TABLE local_file_entries (
      external_id TEXT PRIMARY KEY CHECK (${LOCAL_ID_SHAPE("external_id")}),
      location_id TEXT NOT NULL REFERENCES local_locations (id),
      identity_hash TEXT NOT NULL UNIQUE,
      relative_path TEXT,
      path_hash TEXT,
      size INTEGER CHECK (size IS NULL OR (typeof(size) = 'integer' AND size >= 0)),
      mtime_ns TEXT CHECK (mtime_ns IS NULL OR (${DECIMAL("mtime_ns")})),
      content_hash TEXT,
      content_keyed_hash TEXT,
      file_no TEXT CHECK (file_no IS NULL OR (${FILE_NO("file_no")})),
      revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 1),
      normalizer_version INTEGER,
      seq INTEGER NOT NULL UNIQUE CHECK (typeof(seq) = 'integer' AND seq >= 1),
      state TEXT NOT NULL CHECK (state IN ('present', 'skipped', 'deleted', 'forgotten')),
      pending_delete INTEGER NOT NULL DEFAULT 0 CHECK (pending_delete IN (0, 1, 2)),
      skip_reason TEXT,
      skipped_at TEXT,
      skip_limits TEXT,
      CHECK (state IN ('present', 'skipped') OR (relative_path IS NULL AND size IS NULL
        AND mtime_ns IS NULL AND content_hash IS NULL AND file_no IS NULL)),
      CHECK (state NOT IN ('present', 'skipped') OR (relative_path IS NOT NULL AND path_hash IS NOT NULL)),
      CHECK (state <> 'deleted' OR (path_hash IS NULL AND content_keyed_hash IS NULL))
    );
    CREATE UNIQUE INDEX local_file_entries_path ON local_file_entries (location_id, relative_path)
      WHERE relative_path IS NOT NULL;
    CREATE INDEX local_file_entries_location ON local_file_entries (location_id, seq);
    CREATE INDEX local_file_entries_forgotten_path ON local_file_entries (location_id, path_hash)
      WHERE state = 'forgotten';
    CREATE INDEX local_file_entries_forgotten_content ON local_file_entries (location_id, content_keyed_hash)
      WHERE state = 'forgotten';
    ${["INSERT", "UPDATE"]
      .map(
        (event) => `
    CREATE TRIGGER tombstones_local_index_${event.toLowerCase()} AFTER ${event} ON tombstones
    WHEN new.lifted_at IS NULL AND EXISTS (
      SELECT 1 FROM sources WHERE id = new.source_id AND connector_instance_id = 'local-files')
    BEGIN
      UPDATE local_index_seq SET value = value + 1 WHERE id = 1 AND EXISTS (
        SELECT 1 FROM local_file_entries e WHERE ${localEntryOfTombstone("e")});
      UPDATE local_file_entries SET
        relative_path = NULL, size = NULL, mtime_ns = NULL, content_hash = NULL, file_no = NULL,
        path_hash = CASE new.reason WHEN 'source-deleted' THEN NULL ELSE path_hash END,
        content_keyed_hash = CASE new.reason WHEN 'source-deleted' THEN NULL ELSE content_keyed_hash END,
        revision = CASE new.reason WHEN 'source-deleted' THEN revision + 1 ELSE revision END,
        state = CASE new.reason WHEN 'source-deleted' THEN 'deleted' ELSE 'forgotten' END,
        pending_delete = 0, skip_reason = NULL, skipped_at = NULL, skip_limits = NULL,
        seq = (SELECT value FROM local_index_seq WHERE id = 1)
       WHERE ${localEntryOfTombstone("local_file_entries")};
    END;`,
      )
      .join("")}
  `);

// Schema v23 (S02-T01, S02-R2, R3): the knowledge-schema catalogue's first edition.
// - `ontology_elements.origin` (R3): where a definition came from: `seed` (the product put it there),
//   `user` (the user added it through the API) or `source-proposed` (an automated actor proposed it from
//   a source). It is written once, when the row is made, and never changes (a trigger refuses). An added
//   column needs no table rebuild: the column has a constant default and a CHECK, and the rule stays JSON,
//   so the new value type `identifier` needs no schema change either (the closed list of value types is in
//   code, as it was for S01's three).
// - The fill runs before this migration adds any row, in R3's order: a lineage row, or a creation line by
//   an automated actor (the lineage row goes with its source, the line stays), means `source-proposed`; a
//   creation line by the user means `user`; a name (of that kind) in the product seed means `seed` (a row
//   no user created, which a spec merged earlier may have seeded); the rest is `user`. Then the rows the
//   catalogue lacks are added as `verified`, edition 1, `origin = seed`, with no history line.
// - A name that already exists (same kind, R19's comparison) is left alone whatever its status.
// - The three widened rules (target_date, completion_date, DEPENDS_ON) are widened only while the stored
//   rule is S01's seed rule to the letter and the status is `verified`; the edition goes up by one and no
//   history line is written (a migration is not an actor). The lifecycle gate demands such a line, so it is
//   dropped for the update and made again as v21 made it.
// - The knowledge revision does not move: this is the seed's kind of write (as in v21).
// The migration keeps its own copy of the constants (a later edition of the catalogue must not change what
// an earlier migration does); `schema.catalogue-migration` compares the copy with the catalogue.
// The version number is the next free one: whichever of two tasks adding a migration merges later
// renumbers (`v23` and its line in `migrations`).
type SeedRow = readonly [elementKind: string, name: string, rule: object];
const V23_ITEM_TYPES = [
  "Person",
  "Organization",
  "Decision",
  "Task",
  "Commitment",
  "Event",
  "Issue",
  "Dependency",
  "BusinessRule",
  "OpenQuestion",
];
const V23_ALL_ITEM_TYPES = [...V23_ITEM_TYPES, "Project", "System", "Concept"];
const v23Relation = (
  name: string,
  subjectTypes: string[],
  objectTypes: string[],
  symmetric = false,
) =>
  [
    "relation-type",
    name,
    { elementKind: "relation-type", subjectTypes, objectTypes, symmetric },
  ] as const;
const v23Fact = (name: string, itemTypes: string[], valueType: string, cardinality: string) =>
  ["fact-kind", name, { elementKind: "fact-kind", itemTypes, valueType, cardinality }] as const;
/** What v23 adds; the lists are sorted as an element's stored rule is (the type lists of a rule). */
const V23_ADDITIONS: readonly SeedRow[] = [
  ...V23_ITEM_TYPES.map((name) => ["item-type", name, { elementKind: "item-type" }] as const),
  v23Relation(
    "BELONGS_TO",
    ["Organization", "Person", "Project", "System", "Task"],
    ["Organization", "Project"],
  ),
  v23Relation(
    "RESPONSIBLE_FOR",
    ["Organization", "Person"],
    ["Commitment", "Decision", "Issue", "Project", "System", "Task"],
  ),
  v23Relation("RELATED_TO", [...V23_ALL_ITEM_TYPES].sort(), [...V23_ALL_ITEM_TYPES].sort(), true),
  v23Relation("DECIDED", ["Organization", "Person"], ["Decision"]),
  v23Relation(
    "CAUSED_BY",
    ["Decision", "Event", "Issue", "Task"],
    ["BusinessRule", "Decision", "Dependency", "Event", "Issue"],
  ),
  v23Fact("identifier.email", ["Organization", "Person"], "identifier", "many"),
  v23Fact("identifier.key", [...V23_ALL_ITEM_TYPES].sort(), "identifier", "one"),
  v23Fact(
    "statement",
    [
      "BusinessRule",
      "Commitment",
      "Decision",
      "Dependency",
      "Event",
      "Issue",
      "OpenQuestion",
      "Task",
    ],
    "text",
    "many",
  ),
];
/** The widened rules: element, S01's seed rule (the one condition) and the widened rule. */
const V23_WIDENED: readonly (readonly [kind: string, name: string, to: object])[] = [
  ...["target_date", "completion_date"].map(
    (name) =>
      [
        "fact-kind",
        name,
        {
          elementKind: "fact-kind",
          itemTypes: ["Commitment", "Project", "System", "Task"],
          valueType: "date",
          cardinality: "one",
        },
      ] as const,
  ),
  [
    "relation-type",
    "DEPENDS_ON",
    {
      elementKind: "relation-type",
      subjectTypes: ["Commitment", "Project", "System", "Task"],
      objectTypes: ["Commitment", "Dependency", "Project", "System", "Task"],
      symmetric: false,
    },
  ],
];
const v23: Migration = (db) => {
  const revision = db.all("SELECT knowledge_revision FROM revisions")[0]
    ?.knowledge_revision as number;
  db.exec(`
    ALTER TABLE ontology_elements ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
      CHECK (origin IN ('seed', 'user', 'source-proposed'));
  `);
  const seedKeys = new Set(
    [...ONTOLOGY_SEED, ...V23_ADDITIONS].map(([kind, name]) => `${kind}:${name}`),
  );
  const creation = (id: number) =>
    db.all(
      "SELECT actor FROM ontology_history WHERE element_id = ? AND seq = 1 AND action = 'created'",
      [id],
    )[0]?.actor as string | undefined;
  const existing = db.all("SELECT id, element_kind, name FROM ontology_elements");
  for (const row of existing) {
    const id = row.id as number;
    const created = creation(id);
    const hasLineage =
      db.all("SELECT 1 AS n FROM ontology_basis WHERE element_id = ? LIMIT 1", [id]).length > 0;
    const origin =
      hasLineage || (created !== undefined && created !== "user")
        ? "source-proposed"
        : created === "user"
          ? "user"
          : seedKeys.has(`${row.element_kind as string}:${row.name as string}`)
            ? "seed"
            : "user";
    db.run("UPDATE ontology_elements SET origin = ? WHERE id = ?", [origin, id]);
  }
  const squash = (name: string) => name.toLowerCase().replace(/[_.-]/g, "");
  const taken = new Set(
    existing.map((r) => `${r.element_kind as string}:${squash(r.name as string)}`),
  );
  for (const [kind, name, rule] of V23_ADDITIONS) {
    if (taken.has(`${kind}:${squash(name)}`)) continue;
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES (?, ?, ?, 'verified', 1, 'seed')",
      [kind, name, JSON.stringify(rule)],
    );
  }
  // the lifecycle gate demands a history line for an edition change; a migration writes none
  db.exec("DROP TRIGGER ontology_elements_lifecycle_gate");
  for (const [kind, name, to] of V23_WIDENED) {
    const from = ONTOLOGY_SEED.find(([k, n]) => k === kind && n === name)?.[2];
    db.run(
      `UPDATE ontology_elements SET rule = ?, edition = edition + 1
       WHERE element_kind = ? AND name = ? AND status = 'verified' AND rule = ?`,
      [JSON.stringify(to), kind, name, JSON.stringify(from)],
    );
  }
  db.exec(`
    CREATE TRIGGER ontology_elements_lifecycle_gate
    BEFORE UPDATE OF status, rule, edition ON ontology_elements
    WHEN (new.status IS NOT old.status OR new.rule IS NOT old.rule OR new.edition IS NOT old.edition)
      AND ((new.rule IS NOT old.rule AND new.edition IS old.edition)
        OR NOT EXISTS (
          SELECT 1 FROM ontology_history h
          WHERE h.element_id = old.id
            AND h.seq = (SELECT max(seq) FROM ontology_history WHERE element_id = old.id)
            AND h.from_status = old.status AND h.to_status = new.status
            AND h.from_edition = old.edition AND h.to_edition = new.edition))
    BEGIN SELECT RAISE(ABORT, 'status, rule and edition change only through the ontology gate'); END;
    CREATE TRIGGER ontology_elements_origin_fixed BEFORE UPDATE OF origin ON ontology_elements
    BEGIN SELECT RAISE(ABORT, 'an element keeps its origin'); END;
  `);
  db.run("UPDATE revisions SET knowledge_revision = ?", [revision]);
};

// Schema v24 (S02-T04, S02-R11, R14, R15, R16): the merge, distinct-mark, candidate and split-move
// tables of entity resolution. S02's spec calls this its second migration; the number is the next free
// one when this task merged, and whichever of two tasks adding a migration merges later renumbers
// (`v24` and its line in `migrations`).
// - `item_merges` (R11): "the member is the representative's" as one line, no row moved. One line per
//   member (a member has one representative), so a chain is a path of lines and a group a tree; a line
//   never points at its own member. `active` is 0 while the group's lineage cannot be put together
//   (R13: the whole group's lines rest together). Both ends are foreign keys: a deleted item takes its
//   lines, after the derivative kind `entity-merge` has joined the chain around it (R14).
// - `item_distinct` (R16): "these two are not the same", the smaller id first, who left it (`user`, or
//   `link-check` for R8's check) and when.
// - `merge_candidates` (R10): a pair the product suggests, the smaller id first, the signal codes as a
//   JSON array of codes, and when. No text. S02-T06 writes it; it is created here with the other three.
// - `item_split_moves` (R15): one line per fact or relation a split moved, numbers only. S02-T07 writes
//   it. The three references are foreign keys that cascade, so a deleted item or row takes the line.
// None holds a name, value or quote; all four belong to the derivative kinds `entity-merge` and
// `merge-candidate` (backend derivative-coverage.ts).
const v24: Migration = (db) =>
  db.exec(`
    CREATE TABLE item_merges (
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL UNIQUE REFERENCES items (id) ON DELETE CASCADE,
      representative_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      at TEXT NOT NULL,
      CHECK (member_id <> representative_id)
    );
    CREATE INDEX item_merges_representative ON item_merges (representative_id);

    CREATE TABLE item_distinct (
      item_a INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      item_b INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      by TEXT NOT NULL CHECK (by IN ('user', 'link-check')),
      at TEXT NOT NULL,
      PRIMARY KEY (item_a, item_b),
      CHECK (item_a < item_b)
    ) WITHOUT ROWID;
    CREATE INDEX item_distinct_b ON item_distinct (item_b);

    CREATE TABLE merge_candidates (
      item_a INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      item_b INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      signals TEXT NOT NULL CHECK (json_valid(signals) AND json_type(signals) = 'array'),
      at TEXT NOT NULL,
      PRIMARY KEY (item_a, item_b),
      CHECK (item_a < item_b)
    ) WITHOUT ROWID;
    CREATE INDEX merge_candidates_b ON merge_candidates (item_b);

    CREATE TABLE item_split_moves (
      id INTEGER PRIMARY KEY,
      from_item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      to_item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      fact_id INTEGER REFERENCES facts (id) ON DELETE CASCADE,
      relation_id INTEGER REFERENCES relations (id) ON DELETE CASCADE,
      CHECK ((fact_id IS NULL) <> (relation_id IS NULL))
    );
    CREATE INDEX item_split_moves_from ON item_split_moves (from_item_id);
    CREATE INDEX item_split_moves_to ON item_split_moves (to_item_id);
  `);

// Schema v25 (S03-T04, S03-R1, R2, R13): the two extension tables of the analytical semantic and the
// analytical type definitions' first rows. The tables hold no knowledge (an item, its facts and its relations
// are the registry's rows):
// - `dataset_tables`: which stored table a `Dataset` item stands for, `(source, table key)` unique. The key is
//   the sheet's name for a workbook and empty for a CSV file. The row goes with its item (the cascade); the
//   source row is never deleted, so a deleted source's rows are removed by the registered kind
//   `analytical-check` (backend `TABLE_CLASSIFICATION` classifies the table under it).
// - `analytical_checks`: the numbers and codes of one data check of one fact: `(fact, check)` unique, the
//   version it read (and the other table's, for a Join). It goes with its fact or its version (the cascade).
//   Only counts and codes: no cell of a table is stored here (S03-R18).
// The rows follow v23's way: a name that already exists (same kind, R19's comparison) is left alone, whatever
// its status; the rest is `verified`, edition 1, `origin = seed`, with no history line. `definition` and
// `alias.*` are widened to Metric and Dataset only while the stored rule is S02's seed rule to the letter and
// `verified`; the lifecycle gate demands a history line for an edition change, so it is dropped for the update
// and made again with the text it had (v21's, v23's). The knowledge revision does not move.
// The migration keeps its own copy of the constants (a later edition of the catalogue must not change what
// an earlier migration does); `ontology.analytical-seeds` compares the copy with `ANALYTICAL_SEED`.
// The version number is the next free one: whichever of two tasks adding a migration merges later
// renumbers (`v25` and its line in `migrations`).
const v25Fact = (
  name: string,
  itemType: string,
  valueType: string,
  cardinality: string,
  dataChecks: string[] = [],
): SeedRow => [
  "fact-kind",
  name,
  {
    elementKind: "fact-kind",
    itemTypes: [itemType],
    valueType,
    cardinality,
    ...(dataChecks.length > 0 ? { dataChecks } : {}),
  },
];
const v25Link = (name: string, subject: string, object: string): SeedRow => [
  "relation-type",
  name,
  {
    elementKind: "relation-type",
    subjectTypes: [subject],
    objectTypes: [object],
    symmetric: false,
  },
];
/** What v25 adds; the lists are sorted as an element's stored rule is. */
const V25_ADDITIONS: readonly SeedRow[] = [
  ...["Dataset", "Metric", "Join"].map((name): SeedRow => [
    "item-type",
    name,
    { elementKind: "item-type" },
  ]),
  v25Fact("dataset.column", "Dataset", "header", "many"),
  v25Fact("dataset.role", "Dataset", "dataset-role", "one"),
  v25Fact("dataset.grain", "Dataset", "column-set", "one", ["grain", "schema"]),
  v25Fact("dataset.measure", "Dataset", "column", "many", ["schema"]),
  v25Fact("dataset.dimension", "Dataset", "column", "many", ["schema"]),
  v25Fact("dataset.time_dimension", "Dataset", "column", "many", ["schema"]),
  v25Fact("metric.calculation", "Metric", "calculation", "one", ["aggregation", "schema"]),
  v25Fact("metric.unit", "Metric", "text", "one"),
  v25Fact("metric.version", "Metric", "text", "one"),
  v25Fact("metric.currency", "Metric", "currency", "one"),
  v25Fact("metric.period", "Metric", "period", "one"),
  v25Fact("join.keys", "Join", "key-pairs", "one", ["schema"]),
  v25Fact("join.cardinality", "Join", "join-cardinality", "one", ["join-cardinality"]),
  v25Link("MEASURED_ON", "Metric", "Dataset"),
  v25Link("JOIN_LEFT", "Join", "Dataset"),
  v25Link("JOIN_RIGHT", "Join", "Dataset"),
  v25Link("USES_JOIN", "Metric", "Join"),
];
/** The four rules S02 seeded (as S01's ONTOLOGY_SEED stored them) and what they are widened to. */
const V25_WIDENED: readonly (readonly [
  name: string,
  from: readonly string[],
  to: readonly string[],
])[] = [
  ["definition", ["Concept"], ["Concept", "Dataset", "Metric"]],
  ...["alias.synonym", "alias.abbreviation", "alias.translation"].map(
    (name) =>
      [
        name,
        ["Concept", "Project", "System"],
        ["Concept", "Dataset", "Metric", "Project", "System"],
      ] as const,
  ),
];
const v25: Migration = (db) => {
  const revision = db.all("SELECT knowledge_revision FROM revisions")[0]
    ?.knowledge_revision as number;
  db.exec(`
    CREATE TABLE dataset_tables (
      id INTEGER PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES sources (id),
      table_key TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (typeof(row_count) = 'integer' AND row_count >= 0),
      UNIQUE (source_id, table_key)
    );
    CREATE INDEX dataset_tables_item ON dataset_tables (item_id);
    CREATE TABLE analytical_checks (
      id INTEGER PRIMARY KEY,
      fact_id INTEGER NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
      check_name TEXT NOT NULL CHECK (check_name IN ('schema', 'grain', 'join-cardinality', 'aggregation')),
      passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
      failure_code TEXT,
      examined INTEGER NOT NULL CHECK (typeof(examined) = 'integer' AND examined >= 0),
      violations INTEGER NOT NULL CHECK (typeof(violations) = 'integer' AND violations >= 0),
      skipped INTEGER NOT NULL CHECK (typeof(skipped) = 'integer' AND skipped >= 0),
      version_id INTEGER NOT NULL REFERENCES source_versions (id) ON DELETE CASCADE,
      other_version_id INTEGER REFERENCES source_versions (id) ON DELETE CASCADE,
      checked_at TEXT NOT NULL,
      UNIQUE (fact_id, check_name)
    );
    CREATE INDEX analytical_checks_version ON analytical_checks (version_id);
    CREATE INDEX analytical_checks_other_version ON analytical_checks (other_version_id)
      WHERE other_version_id IS NOT NULL;
  `);
  const squash = (name: string) => name.toLowerCase().replace(/[_.-]/g, "");
  const taken = new Set(
    db
      .all("SELECT element_kind, name FROM ontology_elements")
      .map((r) => `${r.element_kind as string}:${squash(r.name as string)}`),
  );
  for (const [kind, name, rule] of V25_ADDITIONS) {
    if (taken.has(`${kind}:${squash(name)}`)) continue;
    db.run(
      "INSERT INTO ontology_elements (element_kind, name, rule, status, edition, origin) VALUES (?, ?, ?, 'verified', 1, 'seed')",
      [kind, name, JSON.stringify(rule)],
    );
  }
  // the lifecycle gate demands a history line for an edition change; a migration writes none
  db.exec("DROP TRIGGER ontology_elements_lifecycle_gate");
  for (const [name, from, to] of V25_WIDENED) {
    const rule = (itemTypes: readonly string[]) =>
      JSON.stringify({
        elementKind: "fact-kind",
        itemTypes,
        valueType: name === "definition" ? "text" : "surface-form",
        cardinality: "many",
      });
    db.run(
      `UPDATE ontology_elements SET rule = ?, edition = edition + 1
       WHERE element_kind = 'fact-kind' AND name = ? AND status = 'verified' AND rule = ?`,
      [rule(to), name, rule(from)],
    );
  }
  db.exec(`
    CREATE TRIGGER ontology_elements_lifecycle_gate
    BEFORE UPDATE OF status, rule, edition ON ontology_elements
    WHEN (new.status IS NOT old.status OR new.rule IS NOT old.rule OR new.edition IS NOT old.edition)
      AND ((new.rule IS NOT old.rule AND new.edition IS old.edition)
        OR NOT EXISTS (
          SELECT 1 FROM ontology_history h
          WHERE h.element_id = old.id
            AND h.seq = (SELECT max(seq) FROM ontology_history WHERE element_id = old.id)
            AND h.from_status = old.status AND h.to_status = new.status
            AND h.from_edition = old.edition AND h.to_edition = new.edition))
    BEGIN SELECT RAISE(ABORT, 'status, rule and edition change only through the ontology gate'); END;
  `);
  db.run("UPDATE revisions SET knowledge_revision = ?", [revision]);
};

// Schema v26 (S02-T08, S02-R17, R18): additive only. A valid interval's end on facts and
// relations, the assertion links between two facts, the links an Insight rests on, and
// the count of validity dates an extraction dropped. No stored row is rewritten.
const v26: Migration = (db) => {
  db.exec(`
    ALTER TABLE facts ADD COLUMN valid_until TEXT;
    ALTER TABLE relations ADD COLUMN valid_until TEXT;
    ALTER TABLE jobs ADD COLUMN dropped_validity INTEGER CHECK (dropped_validity >= 0);
    CREATE TABLE assertion_links (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('SUPERSEDES', 'CONTRADICTS')),
      from_fact_id INTEGER NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
      to_fact_id INTEGER NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
      created_by TEXT NOT NULL CHECK (created_by IN ('rule', 'propagation', 'user')),
      basis_source_id INTEGER,
      basis_version INTEGER,
      at TEXT NOT NULL,
      CHECK (from_fact_id <> to_fact_id),
      CHECK (type <> 'CONTRADICTS' OR from_fact_id < to_fact_id),
      CHECK ((basis_source_id IS NULL) = (basis_version IS NULL)),
      UNIQUE (type, from_fact_id, to_fact_id)
    );
    CREATE INDEX assertion_links_to ON assertion_links (to_fact_id);
    CREATE TABLE insight_link_inputs (
      insight_id INTEGER NOT NULL REFERENCES insights (id) ON DELETE CASCADE,
      link_id INTEGER NOT NULL REFERENCES assertion_links (id) ON DELETE CASCADE,
      PRIMARY KEY (insight_id, link_id)
    ) WITHOUT ROWID;
    CREATE INDEX insight_link_inputs_link ON insight_link_inputs (link_id);
  `);
};

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
  v18,
  v19,
  v20,
  v21,
  v22,
  v23,
  v24,
  v25,
  v26,
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
