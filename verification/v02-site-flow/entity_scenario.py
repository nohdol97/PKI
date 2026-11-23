"""S02-T10 (S02-R27, R28, site-setup S33): the entity-resolution scenario of the V02 site runner. Helpers only; run.py owns the
refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. `record` is a measurement the operator reads, not a check: it counts
the canonical DB read-only, in its FINAL state (never history lines), and writes numbers and code names only. No text, value
or item name is read into the output. Every table and column below is the one storage/src/migrations.ts creates.

The product does not store whether a merge line came from a candidate or from the user's own choice, so "candidates the user
accepted" is not counted: the merge lines (active and resting) and the distinct marks by maker stand in for it.
"""
import json
import os
import sqlite3
from urllib.request import pathname2url

SETTING_KEY = "semantic.autoDispute"  # knowledge-engine/src/conflicts.ts AUTO_DISPUTE_SETTING
PHASES = ("off", "on")
# storage/src/migrations.ts item-type seed (v23 types and the first three); any other type, a user-made one included, is
# counted under "other", never echoed
SEED_ITEM_TYPES = ("Person", "Organization", "Decision", "Task", "Commitment", "Event", "Issue", "Dependency",
                   "BusinessRule", "OpenQuestion", "Project", "System", "Concept")
# item_distinct.by: the user's mark, or the code that refused a link (`links_refused`)
DISTINCT_MAKERS = ("user", "link-check")


def open_ro(db_path):
    """A read-only connection: never creates the database and writes no content. On a WAL database SQLite may create empty -shm/-wal files."""
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def read_counts(db_path, phase):
    """The S33 measurement of the canonical DB in its final state. Raises sqlite3.Error when the DB is missing or busy."""
    db = open_ro(db_path)
    try:
        items = {}
        for kind, n in db.execute("SELECT type, count(*) FROM items GROUP BY type"):
            key = kind if kind in SEED_ITEM_TYPES else "other"
            items[key] = items.get(key, 0) + int(n)
        merges = {"active": 0, "resting": 0}
        for active, n in db.execute("SELECT active, count(*) FROM item_merges GROUP BY active"):
            merges["active" if active == 1 else "resting"] += int(n)
        distinct = {maker: 0 for maker in DISTINCT_MAKERS}
        for maker, n in db.execute("SELECT by, count(*) FROM item_distinct GROUP BY by"):
            if maker in distinct:
                distinct[maker] += int(n)
        stored = db.execute("SELECT value FROM settings WHERE key = ?", (SETTING_KEY,)).fetchone()
        setting = "unset" if stored is None else stored[0] if stored[0] in ("on", "off") else "other"
        return {
            "phase": phase,
            "setting": setting,
            "items": items,
            "candidates": db.execute("SELECT count(*) FROM merge_candidates").fetchone()[0],
            "merges": merges,
            "distinctBy": distinct,
            "factsWithValidity": db.execute(
                "SELECT count(*) FROM facts WHERE valid_at IS NOT NULL OR valid_until IS NOT NULL").fetchone()[0],
            # facts whose interval the user fixed: one per row however many times (`set-validity`, actor user)
            "validityFixedByUser": db.execute(
                "SELECT count(DISTINCT fact_id) FROM fact_history WHERE actor = 'user' AND action = 'set-validity'").fetchone()[0],
            # facts the policy disputed on a contradiction (S02-R20): the setting on, one per row
            "autoDisputes": db.execute(
                "SELECT count(DISTINCT fact_id) FROM fact_history WHERE actor = 'policy' AND reason = 'contradiction'").fetchone()[0],
        }
    finally:
        db.close()


def phase_warning(counts):
    """The phase names the file; a stored setting that disagrees with it is reported, not refused (the operator reads it)."""
    on = counts["setting"] == "on"
    if (counts["phase"] == "on") != on:
        return "phase {}, but the stored setting is {}".format(counts["phase"], counts["setting"])
    return None


def write_counts(counts, out_dir):
    path = os.path.join(out_dir, "entity-counts.{}.json".format(counts["phase"]))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(counts, fh, ensure_ascii=False, indent=2, sort_keys=True)
    return path
