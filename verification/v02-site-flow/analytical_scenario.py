"""S03-T10 (S03-R21, site-setup S34): the analytical-semantic scenario of the V02 site runner. Helpers only; run.py owns the
refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. `record` is a measurement the operator reads, not a check: it counts
the canonical DB read-only, in its FINAL state, and writes numbers and code names only. No text, value or item name is read
into the output. Every table and column below is the one storage/src/migrations.ts creates.

Two things S03-R21 asks for are not here, on purpose: the product stores no reason a source was not made a table (the profile
job only skips it), so per-reason counts are not recorded; and `jobs` has no start timestamp, so a duration is
`finished_at - created_at`, an upper bound that includes the time the job waited in the queue.
"""
import json
import os
import sqlite3
from urllib.request import pathname2url

PROFILE_KEY = "analytical.profile"  # storage/src/analytical.ts ANALYTICAL_PROFILE_SETTING
MAX_CELLS_KEY = "analytical.maxCells"  # storage/src/analytical.ts ANALYTICAL_MAX_CELLS_SETTING
# storage/src/migrations.ts analytical kind seed (v25); any other kind, a user-made one included, is counted under "other"
SEED_FACT_KINDS = ("dataset.column", "dataset.role", "dataset.grain", "dataset.measure", "dataset.dimension",
                   "dataset.time_dimension", "metric.calculation", "metric.unit", "metric.version", "metric.currency",
                   "metric.period", "join.keys", "join.cardinality")
ITEM_TYPES = ("Dataset", "Metric", "Join")
CHECK_NAMES = ("schema", "grain", "join-cardinality", "aggregation")
# the current version of every source that is not tombstoned, with whether a block carries a csv or xlsx locator
# (storage/src/analytical.ts isTabularVersion)
TABLE_SOURCES = """
    SELECT c.source_id FROM (SELECT source_id, max(version) AS version FROM source_versions GROUP BY source_id) c
      JOIN source_versions v ON v.source_id = c.source_id AND v.version = c.version
     WHERE NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.source_id = c.source_id AND t.covers_version >= c.version)
       AND v.blocks IS NOT NULL
       AND EXISTS (SELECT 1 FROM json_each(v.blocks) b WHERE json_extract(b.value, '$.locator.format') IN ('csv', 'xlsx'))"""


def open_ro(db_path):
    """A read-only connection: never creates the database and writes no content. On a WAL database SQLite may create empty -shm/-wal files."""
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def _stored(db, key):
    row = db.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return None if row is None else row[0]


def _job_ms(db, kind, source_id):
    """finished_at - created_at of the newest succeeded job of the kind for the source (an upper bound: includes queue wait)."""
    row = db.execute(
        "SELECT finished_at - created_at FROM jobs WHERE kind = ? AND source_id = ? AND status = 'succeeded' "
        "AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1", (kind, source_id)).fetchone()
    return None if row is None else int(row[0])


def read_counts(db_path):
    """The S34 measurement of the canonical DB in its final state. Raises sqlite3.Error when the DB is missing or busy."""
    db = open_ro(db_path)
    try:
        profile = _stored(db, PROFILE_KEY)
        setting = "unset" if profile is None else profile if profile in ("on", "off") else "other"
        cells = _stored(db, MAX_CELLS_KEY)
        max_cells = "unset" if cells is None else int(cells) if cells.isdigit() else "other"
        sources = [r[0] for r in db.execute(TABLE_SOURCES)]
        with_table = {r[0] for r in db.execute("SELECT DISTINCT source_id FROM dataset_tables")}
        items = {}
        for kind, status, n in db.execute("SELECT type, status, count(*) FROM items GROUP BY type, status"):
            if kind in ITEM_TYPES:
                items.setdefault(kind, {})[status] = int(n)
        facts = {}
        # the facts of Dataset, Metric and Join items only: a fact of any other item type is not an analytical fact
        for kind, n in db.execute("SELECT f.kind, count(*) FROM facts f JOIN items i ON i.id = f.item_id "
                                  "WHERE i.type IN ({}) GROUP BY f.kind".format(", ".join("?" * len(ITEM_TYPES))), ITEM_TYPES):
            key = kind if kind in SEED_FACT_KINDS else "other"
            facts[key] = facts.get(key, 0) + int(n)
        checks = {}
        for name, passed, n in db.execute("SELECT check_name, passed, count(*) FROM analytical_checks GROUP BY check_name, passed"):
            if name in CHECK_NAMES:
                checks.setdefault(name, {"passed": 0, "failed": 0})["passed" if passed == 1 else "failed"] += int(n)
        big = db.execute("SELECT source_id, max(row_count) FROM dataset_tables").fetchone()
        largest = None
        if big is not None and big[0] is not None:
            largest = {"rowCount": int(big[1]), "profileMs": _job_ms(db, "dataset-profile", big[0]),
                       "checkMs": _job_ms(db, "analytical-check", big[0])}
        return {
            "setting": setting,
            "maxCells": max_cells,
            "tableSources": len(sources),
            "tables": db.execute("SELECT count(*) FROM dataset_tables").fetchone()[0],
            "sourcesWithoutTable": len([s for s in sources if s not in with_table]),
            # Dataset items the user rejected that still hold a table: the product's count of a table "mistaken" for one
            "datasetsRejected": db.execute(
                "SELECT count(DISTINCT i.id) FROM items i JOIN dataset_tables t ON t.item_id = i.id "
                "WHERE i.type = 'Dataset' AND i.status = 'rejected'").fetchone()[0],
            "items": items,
            "facts": facts,
            "checks": checks,
            "largest": largest,  # the times include the wait in the queue
        }
    finally:
        db.close()


def setting_warning(counts):
    """The stored profile setting that is not `on` is reported, not refused: a record with the profile OFF measures nothing."""
    if counts["setting"] != "on":
        return "the stored setting {} is {}, not on".format(PROFILE_KEY, counts["setting"])
    return None


def write_counts(counts, out_dir):
    path = os.path.join(out_dir, "analytical-counts.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(counts, fh, ensure_ascii=False, indent=2, sort_keys=True)
    return path
