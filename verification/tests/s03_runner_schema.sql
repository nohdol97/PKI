-- The tables and columns the S34 runner (v02-site-flow/analytical_scenario.py read_counts) reads. A name here must exist in
-- the real schema: storage/src/analytical-runner-schema.test.ts migrates a database and checks every table and column below.
CREATE TABLE source_versions (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, version INTEGER NOT NULL, blocks TEXT);
CREATE TABLE tombstones (source_id INTEGER PRIMARY KEY, covers_version INTEGER NOT NULL);
CREATE TABLE dataset_tables (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, source_id INTEGER NOT NULL, row_count INTEGER NOT NULL);
CREATE TABLE items (id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE facts (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE analytical_checks (id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL, check_name TEXT NOT NULL, passed INTEGER NOT NULL);
CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source_id INTEGER, status TEXT NOT NULL,
                   created_at INTEGER NOT NULL, finished_at INTEGER);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
