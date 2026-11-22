"""I04-T11 (spec I04-R19, site-setup S22): the deletion scenario of the V02 site runner. Helpers only; run.py owns the
refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. The installed app refuses debugging switches and the real
collectors live in the deployment fork, so the operator drives the steps (RUNBOOK section 8). This module prepares three
synthetic canaries, then (after the operator closed the app) counts the invalidation records read-only and searches every
file under the data directory for the canaries.
"""
import json
import ntpath
import os
import random
import sqlite3
import string
from urllib.request import pathname2url

import run_record as rr
from common import results

CHECK_ID = "I04-C3:delete-scenario"
STATE_FILE = "delete-scenario-state.json"
COLLECTOR_KINDS = ("site-mail", "site-messenger", "site-wiki")
# the operator attests these; the runner cannot see the screens or the site's own projection jobs
OBSERVATIONS = ("launched-installed", "source-deleted-event", "access-revoked-event", "reads-gone", "projections-clean")
ROLES = ("deleted", "revoked", "kept")  # the source deleted at its origin, the one whose access was lost, the survivor
# every kind of deleting event the invalidation table records: the two the scenario causes, and the screen's own
# deletion, which must not have happened (a user deletion would put the same text out of the files for another reason)
EXPECTED_EVENTS = {"source-deleted": 1, "access-revoked": 1, "user-deleted": 0}
CANARY_LEN = 24
# FTS5 stores a term as a SUFFIX when the term before it shares a prefix, so the whole word can be absent from the file
# while its tail is there. The tail is what is searched: long and random enough to be unique, short enough to survive a
# shared prefix of CANARY_LEN - TAIL_LEN characters.
TAIL_LEN = 12
CHUNK = 1 << 20


class ConfigError(Exception):
    pass


class StaleData(Exception):
    """The canonical DB holds data from before this run."""


def validate_config(cfg):
    """The delete-scenario config: the installer identity of the V02 config, a collector kind, optional extra folders."""
    if not isinstance(cfg, dict):
        raise ConfigError("config must be a JSON object")
    if not (isinstance(cfg.get("productName"), str) and isinstance(cfg.get("installedExe"), str)):
        raise ConfigError("config needs productName and installedExe strings")
    collector = cfg.get("collector")
    if not (isinstance(collector, dict) and collector.get("kind") in COLLECTOR_KINDS):
        raise ConfigError("config needs collector.kind: one of {}".format(", ".join(COLLECTOR_KINDS)))
    user_data = cfg.get("userDataDir")
    if not (isinstance(user_data, str) and _is_abs(ntpath.expandvars(user_data))):
        raise ConfigError("config needs userDataDir: the absolute folder of the Electron shell's userData (Chromium storage), "
                          "which lies outside the data folder (site-setup S22)")
    extra = cfg.get("extraScanDirs", [])
    # %VAR% is expanded first, as scan_dirs does: what is validated is what is scanned
    if not (isinstance(extra, list) and all(isinstance(d, str) and _is_abs(ntpath.expandvars(d)) for d in extra)):
        raise ConfigError("extraScanDirs must be a list of absolute Windows folder paths")
    return cfg


def _is_abs(path):
    return ntpath.isabs(path)


def new_canaries():
    """Three synthetic words, lowercase letters only, each starting with a different letter: FTS stores words with a shared
    prefix once, so a shared prefix would let one canary's presence hide another's absence."""
    firsts = random.SystemRandom().sample(string.ascii_lowercase, len(ROLES))
    rng = random.SystemRandom()
    return {role: first + "".join(rng.choice(string.ascii_lowercase) for _ in range(CANARY_LEN - 1))
            for role, first in zip(ROLES, firsts)}


def prepare(db_path, out_dir):
    """Refuses an existing data folder DB (old residue would be scanned as if it were this run's); writes the state."""
    if os.path.exists(db_path):
        raise StaleData("the canonical DB already exists: start from an empty data folder (RUNBOOK step 1)")
    os.makedirs(out_dir, exist_ok=True)
    canaries = new_canaries()
    with open(os.path.join(out_dir, STATE_FILE), "w", encoding="utf-8") as fh:
        json.dump({"startedAt": rr.now_iso(), "canaries": canaries}, fh)
    return canaries


def load_state(out_dir):
    with open(os.path.join(out_dir, STATE_FILE), encoding="utf-8") as fh:
        state = json.load(fh)
    canaries = state["canaries"]
    if sorted(canaries) != sorted(ROLES):
        raise ConfigError("state file does not hold the three canaries")
    return state["startedAt"], canaries


def _forms(canary):
    """The byte forms searched, all of the LOWERCASED tail of the word (the window is lowercased too, so a store that
    capitalises or folds case is found): ASCII, UTF-16LE and UTF-16BE."""
    tail = canary.lower()[-TAIL_LEN:]
    return {tail.encode("ascii"), tail.encode("utf-16-le"), tail.encode("utf-16-be")}


def _file_has(path, forms, overlap):
    tail = b""
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                return False
            window = (tail + chunk).lower()  # bytes.lower is ASCII-only: it leaves the zero bytes of UTF-16 alone
            if any(f in window for f in forms):
                return True
            tail = (tail + chunk)[-overlap:] if overlap else b""


def scan_canaries(dirs, canaries):
    """(found, unreadable): `found` is {role: 1 if the canary's tail is in any file under any folder, else 0}; `unreadable`
    is how many folders or files could not be read (a count, never a name: the verdict cannot be PASS while it is not 0).
    Every file is read, whatever its name: the database, -journal/-wal/-shm, a projection's own files, the Chromium
    storage of the userData folder."""
    forms = {role: _forms(c) for role, c in canaries.items()}
    overlap = max(len(f) for fs in forms.values() for f in fs) - 1
    found = {role: 0 for role in canaries}
    unreadable = [0]

    def walk_error(_exc):
        unreadable[0] += 1

    for root in dirs:
        if not os.path.isdir(root):
            raise ConfigError("scan folder not found")
        for base, _dirs, files in os.walk(root, onerror=walk_error):
            for name in sorted(files):
                path = os.path.join(base, name)
                try:
                    for role in canaries:
                        if not found[role] and _file_has(path, forms[role], overlap):
                            found[role] = 1
                except OSError:
                    unreadable[0] += 1
    return found, unreadable[0]


def scan_dirs(cfg, db_path):
    """The folders the scan reads: the data folder (the DB's), the Electron userData folder (Chromium storage, OUTSIDE the
    data folder) and the operator's extra folders. %VAR% in the config paths is expanded."""
    return [ntpath.dirname(db_path), ntpath.expandvars(cfg["userDataDir"])] + [ntpath.expandvars(d) for d in cfg.get("extraScanDirs", [])]


def open_ro(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def read_delete_counts(db_path):
    """How many records of each deleting kind the invalidation table holds (it keeps counts and ids, never content)."""
    db = open_ro(db_path)
    try:
        counts = {kind: 0 for kind in EXPECTED_EVENTS}
        for kind, n in db.execute("SELECT change_kind, count(*) FROM invalidations GROUP BY change_kind"):
            if kind in counts:
                counts[kind] = int(n)
        return counts
    finally:
        db.close()


def read_index_terms(db_path, canaries):
    """{role: 1 if the canary is a term of the keyword index}, by `fts5vocab` on a read-only connection (a temp vocabulary
    table: nothing is written to the file). The byte scan cannot prove the index clean on its own, since a term
    can be stored as a suffix; this asks the index what terms it holds. Needs the product's `keyword_index` table (schema
    v1 on) and an SQLite with FTS5 (the product's own better-sqlite3 build has it; Python's sqlite3 usually does)."""
    db = open_ro(db_path)
    try:
        db.execute("CREATE VIRTUAL TABLE temp.pki_canary_vocab USING fts5vocab(main, keyword_index, 'row')")
        return {role: int(db.execute("SELECT count(*) FROM temp.pki_canary_vocab WHERE term = ?", (c.lower(),)).fetchone()[0] > 0)
                for role, c in canaries.items()}
    finally:
        db.close()


def judge(counts, found, observed, index, unreadable):
    """FAIL: the deleting events are not exactly one of each kind (and no user deletion), or a deleted source's canary is
    still in a file or in the keyword index. INCONCLUSIVE: some path could not be read, the survivor's canary is not found
    in the files AND in the index (a scan that cannot see a canary proves nothing), or an attestation is missing."""
    if counts != EXPECTED_EVENTS or found["deleted"] or found["revoked"] or index["deleted"] or index["revoked"]:
        return "FAIL"
    if unreadable or not found["kept"] or not index["kept"] or set(OBSERVATIONS) - set(observed):
        return "INCONCLUSIVE"
    return "PASS"


def build_record(cfg, app_version, counts, found, verdict, observed, started_at, index, unreadable, commit=None):
    import platform as platform_module
    u = platform_module.uname()
    return {
        "schema": rr.SCHEMA, "record": "i04-delete-scenario", "status": "passed" if verdict == "PASS" else "failed",
        "verdict": verdict, "os": " ".join(x for x in (u.system, u.release, u.version, u.machine) if x),
        "appVersion": app_version, "collectorKind": cfg["collector"]["kind"], "deletedByKind": dict(counts),
        "canariesFound": found["deleted"] + found["revoked"], "controlCanaryFound": bool(found["kept"]),
        "indexCanariesFound": index["deleted"] + index["revoked"], "controlCanaryInIndex": bool(index["kept"]),
        "unreadablePaths": unreadable,
        "observed": [w for w in OBSERVATIONS if w in observed],
        "commit": commit if commit and rr.COMMIT_RE.match(commit) else "unknown",
        "startedAt": started_at, "finishedAt": rr.now_iso(),
    }


def write_results(record, verdict, observed, out_dir, literals):
    """The allowlisted pasteable pair (fails closed, writes nothing on error), then the local raw/ record."""
    from common.fingerprint import environment_fingerprint
    from common.redact import Redactor
    facts = {"collector_kind": record["collectorKind"], "app_version": results.normalize_version(record["appVersion"])[0],
             "deleted_source_deleted": record["deletedByKind"]["source-deleted"],
             "deleted_access_revoked": record["deletedByKind"]["access-revoked"],
             "deleted_user_deleted": record["deletedByKind"]["user-deleted"],
             "index_canaries_found": record["indexCanariesFound"], "control_canary_in_index": record["controlCanaryInIndex"],
             "unreadable_paths": record["unreadablePaths"],
             "canaries_found": record["canariesFound"], "control_canary_found": record["controlCanaryFound"],
             "observed": [w for w in OBSERVATIONS if w in observed],
             "kit_commit": record["commit"][:12] if record["commit"] != "unknown" else "unknown"}
    obj = {"schema_version": results.SCHEMA_VERSION, "kit": "v02-site-flow", "mode": "real",
           "created": record["finishedAt"].split(".")[0] + "Z",
           "environment": results.project_environment(environment_fingerprint()),
           "checks": [{"id": CHECK_ID, "verdict": verdict, "facts": facts,
                       "codes": ["i04_manual_observations", "i04_scan_scope"]}],
           "metrics": {}, "notes": ["unit_tests_not_site_evidence"], "dropped_fields": 0}
    redactor = Redactor(literals={x: "<REDACTED>" for x in literals})
    paths = results.write_result_obj(obj, out_dir, redactor)
    results.write_raw_files(out_dir, {"README": ""}, redactor)
    with open(os.path.join(out_dir, "raw", "run-record.delete-scenario.json"), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return paths
