"""I07-T05 (I07-R12, R17, site-setup S31): the installed-build check of the instance scopes. Helpers only; run.py owns the
refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows or against a real installed build. It compares the canonical DB's
`connector_instances.configured_scope` (read-only) with the fork's scopes file. It proves "the value reached the canonical
DB" and nothing more: whether the Broker uses it is a test of the upstream repository. The result file holds numbers and a
verdict only: no scope value and no instance id is read into it.
"""
import json
import os
import platform as platform_module
import sqlite3
from urllib.request import pathname2url

import delete_scenario
import run_record as rr

ConfigError = delete_scenario.ConfigError
RESULT_FILE = "scopes-check-result.json"


def _object_pairs(pairs):
    seen = {}
    for key, value in pairs:
        if key == "__proto__" or key in seen:
            raise ConfigError("expected file: the key `__proto__` and a key that appears twice are refused")
        seen[key] = value
    return seen


def normalize(values):
    """The product's normalizeScope: sorted (UTF-16 code unit order, like JS) and de-duplicated."""
    return sorted(set(values), key=lambda s: s.encode("utf-16-be", "surrogatepass"))


def load_expected(path):
    """{instance id: normalized scope list, or None}. The rules of I07-R3; a bad file or entry is a config error, never a verdict."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh, object_pairs_hook=_object_pairs)
    except (OSError, ValueError) as exc:
        if isinstance(exc, ConfigError):
            raise
        raise ConfigError("expected file is not readable JSON ({})".format(type(exc).__name__))
    if not isinstance(data, dict):
        raise ConfigError("expected file must be a JSON object")
    expected = {}
    for key, value in data.items():
        if value is None:
            expected[key] = None
        elif isinstance(value, list) and all(isinstance(v, str) and v != "" for v in value):
            expected[key] = normalize(value)
        else:
            raise ConfigError("expected file has an entry that is neither null nor an array of non-empty strings")
    return expected


def open_ro(db_path):
    """A read-only connection: never creates the database. On a WAL database SQLite may create empty -shm/-wal files."""
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def read_stored(db_path):
    """{instance id: stored value text or None}. Raises sqlite3.Error when the DB is missing, busy or not the product's."""
    db = open_ro(db_path)
    try:
        return {row[0]: row[1] for row in db.execute("SELECT id, configured_scope FROM connector_instances")}
    finally:
        db.close()


def _stored_equals(raw, wanted):
    if raw is None:
        return False
    try:
        return json.loads(raw) == wanted
    except ValueError:
        return False


def compare(expected, stored):
    """The four counts over the expected entries that carry a scope."""
    same = different = missing = 0
    for key, wanted in expected.items():
        if wanted is None:
            continue
        if key not in stored:
            missing += 1
        elif _stored_equals(stored[key], wanted):
            same += 1
        else:
            different += 1
    return {"compared": same + different + missing, "same": same, "different": different, "missing": missing}


def judge(counts):
    """FAIL before INCONCLUSIVE: a different value is a failure even when another expected instance is not in the DB yet."""
    if counts["different"]:
        return "FAIL"
    if counts["compared"] == 0 or counts["missing"]:
        return "INCONCLUSIVE"
    return "PASS"


def build_record(app_version, counts, verdict):
    u = platform_module.uname()
    return {"schema": rr.SCHEMA, "record": "i07-scopes-check", "verdict": verdict,
            "os": " ".join(x for x in (u.system, u.release, u.version, u.machine) if x),
            "appVersion": app_version, **counts, "finishedAt": rr.now_iso()}


def write_result(record, out_dir):
    path = os.path.join(out_dir, RESULT_FILE)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2, sort_keys=True)
    return path
