"""S01-T10 (S01-R24, R25, site-setup S32): the Semantic scenario of the V02 site runner. Helpers only; run.py owns the
refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. `record` is a measurement the operator reads, not a check: it counts
the canonical DB read-only, in its FINAL state (never history lines: a row promoted, taken back and promoted again is one
row), and writes numbers and code names only. No text, value or item name is read into the output.
"""
import json
import os
import sqlite3
from urllib.request import pathname2url

SETTING_KEY = "semantic.autoVerify"  # knowledge-engine/src/auto-verify.ts AUTO_VERIFY_SETTING
STATUSES = ("candidate", "verified", "disputed", "rejected", "superseded")
PHASES = ("off", "on")
# storage/src/migrations.ts seed form kinds; any other kind (a user-made one included) is counted under "other", never echoed
SEED_FORM_KINDS = ("alias.synonym", "alias.abbreviation", "alias.translation")
# history actions that change neither a status nor an epistemic type (storage/src/semantic-lifecycle.ts STATE_NEUTRAL_ACTIONS)
STATE_NEUTRAL = ("merge", "unmerge", "split", "set-validity")


def open_ro(db_path):
    """A read-only connection: never creates the file, never writes."""
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def _by_status(rows):
    counts = {status: 0 for status in STATUSES}
    for status, n in rows:
        if status in counts:
            counts[status] = int(n)
    return counts


def _promoted(db, table, history, fk):
    """(promoted, still verified, judged wrong) of one table: rows with a policy `auto-verify` line, counted once each.
    Judged wrong = now disputed/rejected/superseded AND the newest state line is the user's (a policy dispute is not)."""
    neutral = ",".join("'{}'".format(a) for a in STATE_NEUTRAL)
    promoted = "EXISTS (SELECT 1 FROM {h} h WHERE h.{fk} = t.id AND h.actor = 'policy' AND h.action = 'auto-verify')".format(
        h=history, fk=fk)
    newest_actor = ("(SELECT h.actor FROM {h} h WHERE h.{fk} = t.id AND h.action NOT IN ({n}) "
                    "ORDER BY h.seq DESC LIMIT 1)").format(h=history, fk=fk, n=neutral)
    query = ("SELECT count(*), coalesce(sum(t.status = 'verified'), 0), "
             "coalesce(sum(t.status IN ('disputed', 'rejected', 'superseded') AND {actor} = 'user'), 0) "
             "FROM {t} t WHERE {promoted}").format(t=table, promoted=promoted, actor=newest_actor)
    return tuple(int(x) for x in db.execute(query).fetchone())


def read_counts(db_path, phase):
    """The S32 measurement of the canonical DB in its final state. Raises sqlite3.Error when the DB is missing or busy."""
    db = open_ro(db_path)
    try:
        forms = {}
        for kind, status, n in db.execute(
                "SELECT kind, status, count(*) FROM facts WHERE substr(kind, 1, 6) = 'alias.' GROUP BY kind, status"):
            key = kind if kind in SEED_FORM_KINDS else "other"
            bucket = forms.setdefault(key, {s: 0 for s in STATUSES})
            if status in bucket:
                bucket[status] += int(n)
        definitions = _by_status(db.execute("SELECT status, count(*) FROM facts WHERE kind = 'definition' GROUP BY status"))
        fact = _promoted(db, "facts", "fact_history", "fact_id")
        relation = _promoted(db, "relations", "relation_history", "relation_id")
        stored = db.execute("SELECT value FROM settings WHERE key = ?", (SETTING_KEY,)).fetchone()
        setting = "unset" if stored is None else stored[0] if stored[0] in ("on", "off") else "other"
        return {"phase": phase, "setting": setting, "forms": forms, "definitions": definitions,
                "promoted": fact[0] + relation[0], "promotedStanding": fact[1] + relation[1],
                "promotedJudgedWrong": fact[2] + relation[2]}
    finally:
        db.close()


def phase_warning(counts):
    """The phase names the file; a stored setting that disagrees with it is reported, not refused (the operator reads it)."""
    on = counts["setting"] == "on"
    if (counts["phase"] == "on") != on:
        return "phase {}, but the stored setting is {}".format(counts["phase"], counts["setting"])
    return None


def write_counts(counts, out_dir):
    path = os.path.join(out_dir, "semantic-counts.{}.json".format(counts["phase"]))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(counts, fh, ensure_ascii=False, indent=2, sort_keys=True)
    return path
