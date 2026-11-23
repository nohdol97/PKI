#!/usr/bin/env python3
"""V02 site runner (V02-R18, spec V02 "T12가 넘기는 것"): the V02 flow on the Windows installer with a real Provider.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. Off-site only the refusals and the record form ran (unit tests).
The installed app refuses debugging switches, so nothing can drive its screens: the operator walks them (RUNBOOK.md)
and this runner checks the preconditions, prepares the synthetic input, then counts the canonical DB read-only.

  preflight   refusal checks only (V02-H2): a test double Provider, or not a Windows installer
  prepare     refusal checks, the DB must not exist yet; writes v02-plain.jsonl and run-state.json to --out
  record      refusal checks; counts the DB like v02-flow.e2e; writes the pasteable result.json/result.md and the
              local raw/run-record.windows-installer.json
  summarize   lists the current run records of a folder, ignoring stale, other-commit and malformed ones
  queue-scenario preflight|prepare|record --scenario kill|sleep|hibernate|clock-forward|clock-back|timezone
              the queue and scheduler recovery scenarios of I03 (S19, see queue_scenario.py): their own refusals
              ("배포처 후속", I03-H2 ① outside the Windows installer, ② no manual sleep confirmation record); needs no Provider
  delete-scenario preflight|prepare|record   the deletion scenario of I04 (S22, see delete_scenario.py): its own refusal
              ("배포처 후속", I04-H2 ②) outside the Windows installer; needs no Provider
  semantic-scenario preflight|record --phase off|on   the Semantic measurement of S01 (S32, see semantic_scenario.py): its own
              refusal ("배포처 후속", S01-H2) outside a Windows installed build with a real Provider; `record` writes counts, no verdict
  entity-scenario preflight|record --phase off|on   the entity-resolution measurement of S02 (S33, see entity_scenario.py): its own
              refusal ("배포처 후속", S02-H2) under the same two conditions; `--phase` is the state of `semantic.autoDispute`;
              `record` writes counts, no verdict

Exit values: 0 ok/PASS, 1 FAIL or INCONCLUSIVE or a write refusal, 2 config error, 3 `배포처 후속` notice, 4 stale data.
"""
import argparse
import json
import ntpath
import os
import platform as platform_module
import sqlite3
import subprocess
import sys
from urllib.request import pathname2url

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
REPO = os.path.dirname(VERIF)
for _p in (HERE, VERIF):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import delete_scenario  # noqa: E402
import entity_scenario  # noqa: E402
import queue_scenario  # noqa: E402
import semantic_scenario  # noqa: E402
import run_record as rr  # noqa: E402
from common import results  # noqa: E402
from common.fingerprint import environment_fingerprint  # noqa: E402
from common.redact import RedactionError, Redactor  # noqa: E402

KIT = "v02-site-flow"
CHECK_ID = "V02-C4:site-flow"
NOTICE_EXIT, CONFIG_EXIT, STALE_EXIT = 3, 2, 4
NOTICE_DOUBLE = ("배포처 후속: S14 test double Provider(또는 설정과 다른 Provider)의 실행은 배포처 결과로 기록하지 않는다. "
                 "실제 Provider(openai-compatible, claude-code, codex)를 설정하고 Windows 설치본에서 다시 실행한다(V02-H2 ①).")
NOTICE_NOT_INSTALLER = ("배포처 후속: S14 Windows 설치본이 아닌 환경의 실행은 배포처 결과로 기록하지 않는다. "
                        "R04의 설치 파일로 설치한 Windows 11에서 실행한다(V02-H2 ②, 이유: {code}).")
NOTICE_DELETE_NOT_INSTALLER = ("배포처 후속: S22 Windows 설치본이 아닌 환경의 삭제 시나리오는 배포처 결과로 기록하지 않는다. "
                               "미구현, 배포처 후속: 실제 수집기가 있는 배포처 포크에서, R04의 설치 파일로 설치한 Windows 11에서 실행한다(I04-H2 ②, 이유: {code}).")
NOTICE_QUEUE_NOT_INSTALLER = ("배포처 후속: S19 Windows 설치본이 아닌 환경의 큐·스케줄러 복구 시나리오는 배포처 결과로 기록하지 않는다. "
                              "미구현, 배포처 후속: R04의 설치 파일로 설치한 Windows 11에서 실행한다(I03-H2 ①, 이유: {code}).")
NOTICE_SLEEP_RECORD = ("배포처 후속: S19 절전·최대 절전 시나리오의 수동 확인 기록({file})이 없거나 이 실행과 맞지 않아 배포처 결과로 기록하지 않는다. "
                       "RUNBOOK 9절의 양식으로 PC를 실제로 재운 뒤 적는다(I03-H2 ②, 이유: {code}).")
NOTICE_SEMANTIC_DOUBLE = ("배포처 후속: S32 test double Provider(또는 설정과 다른 Provider)로는 표기·정의 추출과 자동 승격을 배포처 결과로 재지 않는다. "
                          "실제 Provider(openai-compatible, claude-code, codex)를 설정하고 Windows 설치본에서 다시 실행한다(S01-H2, 이유: test-double).")
NOTICE_SEMANTIC_NOT_INSTALLER = ("배포처 후속: S32 Windows 설치본이 아닌 환경에서는 표기·정의 추출과 자동 승격을 배포처 결과로 재지 않는다. "
                                 "R04의 설치 파일로 설치한 Windows 11에서 실제 Provider로 실행한다(S01-H2, 이유: {code}).")
NOTICE_ENTITY_DOUBLE = ("배포처 후속: S33 test double Provider(또는 설정과 다른 Provider)로는 넓힌 유형의 추출과 합치기 후보를 배포처 결과로 재지 않는다. "
                        "실제 Provider(openai-compatible, claude-code, codex)를 설정하고 Windows 설치본에서 다시 실행한다(S02-H2, 이유: test-double).")
NOTICE_ENTITY_NOT_INSTALLER = ("배포처 후속: S33 Windows 설치본이 아닌 환경에서는 넓힌 유형의 추출과 합치기 후보를 배포처 결과로 재지 않는다. "
                               "R04의 설치 파일로 설치한 Windows 11에서 실제 Provider로 실행한다(S02-H2, 이유: {code}).")
# the operator attests these; `launched-installed`: every start was the installed exe (the DB does not say which
# binary wrote it, and dist\app or source runs use the same data folder)
OBSERVATIONS = ("launched-installed", "insight-inference", "evidence-opened", "reimport-no-new", "restart-kept")
EXPECTED = {"sourceVersions": 3, "insights": 1, "activeInsights": 1, "jobsNotSucceeded": 0}
MIN_PROVIDER_CALLS = 3  # ok `extract` calls: one per source; a schema mismatch calls once more (extraction.calls)
APP_DIR, DB_FILE = "PKI", "pki.sqlite"  # storage/src/data-directory.ts, backend/src/composition.ts
FIXTURE_SET, FIXTURE_FILE = "plain", "v02-plain.jsonl"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"


class Refusal(Exception):
    def __init__(self, notice, code):
        super().__init__(code)
        self.notice, self.code = notice, code


StaleData = delete_scenario.StaleData  # one class for both scenarios
ConfigError = delete_scenario.ConfigError


class RecordInvalid(Exception):
    """The runner's own record failed the form check: nothing is written."""


DB_BUSY_HINT = ("refused: the canonical DB is locked or has an unfinished write. Close the app completely "
                "(also from the tray) and run `record` again.")


def load_json_object(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ConfigError("config is not readable JSON ({})".format(type(exc).__name__))
    if not isinstance(cfg, dict):
        raise ConfigError("config must be a JSON object")
    return cfg


def load_config(path):
    cfg = load_json_object(path)
    provider = cfg.get("provider")
    if not (isinstance(cfg.get("productName"), str) and isinstance(cfg.get("installedExe"), str)
            and isinstance(provider, dict)
            and all(isinstance(provider.get(k), str) and provider[k] for k in ("kind", "id", "name", "version"))):
        raise ConfigError("config needs productName, installedExe and provider.{kind,id,name,version} strings")
    return cfg


# ---- refusals (V02-H2): Provider first, so one run prints one notice ------------------------------------------------

def check_provider(cfg):
    p = cfg["provider"]
    if p["kind"] != "real" or p["id"] not in rr.REAL_PROVIDER_IDS or rr.TESTKIT_MARK in p["name"]:
        raise Refusal(NOTICE_DOUBLE, "test-double")


def _norm(path):
    return ntpath.normcase(ntpath.normpath(path.strip().strip('"'))).rstrip("\\")


def check_installer(cfg, platform, read_uninstall, is_file, in_git_tree, notice=NOTICE_NOT_INSTALLER):
    """The installed app's version from its uninstall entry, or Refusal ②. Inputs are measured, never overridable."""
    def refuse(code):
        raise Refusal(notice.format(code=code), code)

    if platform != "win32":
        refuse("not-windows")
    exe = ntpath.expandvars(cfg["installedExe"])
    if not (ntpath.isabs(exe) and exe.lower().endswith(".exe") and is_file(exe)):
        refuse("exe-missing")
    norm = _norm(exe)
    parts = norm.split("\\")
    if any(parts[i:i + 2] == ["dist", "app"] for i in range(len(parts))) or in_git_tree(exe):
        refuse("build-output")
    for entry in read_uninstall():
        location = entry.get("InstallLocation")
        if entry.get("DisplayName") != cfg["productName"] or not isinstance(location, str) or not location.strip():
            continue
        if norm.startswith(_norm(location) + "\\"):
            version = entry.get("DisplayVersion")
            if isinstance(version, str) and rr.STRICT_VERSION.match(version):
                return version
            refuse("app-version")
    refuse("not-installed")


def read_uninstall_windows():
    """DisplayName/InstallLocation/DisplayVersion of every uninstall entry (HKCU, HKLM, both registry views).
    NEVER EXECUTED: written off-site."""
    import winreg  # noqa: PLC0415 - Windows only
    entries = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                root = winreg.OpenKey(hive, UNINSTALL_KEY, 0, winreg.KEY_READ | view)
            except OSError:
                continue
            with root:
                for i in range(winreg.QueryInfoKey(root)[0]):
                    try:
                        with winreg.OpenKey(root, winreg.EnumKey(root, i)) as key:
                            entry = {}
                            for name in ("DisplayName", "InstallLocation", "DisplayVersion"):
                                try:
                                    entry[name] = winreg.QueryValueEx(key, name)[0]
                                except OSError:
                                    pass
                            entries.append(entry)
                    except OSError:
                        continue
    return entries


def in_git_tree(path):
    d = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.exists(os.path.join(d, ".git")):
            return True
        parent = os.path.dirname(d)
        if parent == d:
            return False
        d = parent


def gate(cfg):
    check_provider(cfg)
    return check_installer(cfg, sys.platform, read_uninstall_windows, os.path.isfile, in_git_tree)


_in_git_tree = in_git_tree


def delete_gate(cfg, platform=None, read_uninstall=None, is_file=None, in_git_tree=None):
    """The installer check of the deletion scenario (I04-H2 ②): the same measured inputs, the S22 notice, no Provider."""
    return check_installer(cfg, platform or sys.platform, read_uninstall or read_uninstall_windows, is_file or os.path.isfile,
                           in_git_tree or _in_git_tree, notice=NOTICE_DELETE_NOT_INSTALLER)


def queue_gate(cfg, platform=None, read_uninstall=None, is_file=None, in_git_tree=None):
    """The installer check of the queue scenarios (I03-H2 ①): the same measured inputs, the S19 notice, no Provider."""
    return check_installer(cfg, platform or sys.platform, read_uninstall or read_uninstall_windows, is_file or os.path.isfile,
                           in_git_tree or _in_git_tree, notice=NOTICE_QUEUE_NOT_INSTALLER)


def semantic_gate(cfg, platform=None, read_uninstall=None, is_file=None, in_git_tree=None):
    """The two conditions of the Semantic scenario (S01-H2): a real Provider, then the installed build. Provider first, so one
    run prints one notice; both notices start with `배포처 후속` and name S32. The inputs are measured, never overridable."""
    try:
        check_provider(cfg)
    except Refusal:
        raise Refusal(NOTICE_SEMANTIC_DOUBLE, "test-double")
    return check_installer(cfg, platform or sys.platform, read_uninstall or read_uninstall_windows, is_file or os.path.isfile,
                           in_git_tree or _in_git_tree, notice=NOTICE_SEMANTIC_NOT_INSTALLER)


def entity_gate(cfg, platform=None, read_uninstall=None, is_file=None, in_git_tree=None):
    """The two conditions of the entity scenario (S02-H2), the same as the Semantic one with the S33 notices."""
    try:
        check_provider(cfg)
    except Refusal:
        raise Refusal(NOTICE_ENTITY_DOUBLE, "test-double")
    return check_installer(cfg, platform or sys.platform, read_uninstall or read_uninstall_windows, is_file or os.path.isfile,
                           in_git_tree or _in_git_tree, notice=NOTICE_ENTITY_NOT_INSTALLER)


# ---- prepare / record ------------------------------------------------------------------------------------------------

def site_db_path():
    local = os.environ.get("LOCALAPPDATA")
    if not local or not ntpath.isabs(local):
        raise ConfigError("LOCALAPPDATA is not an absolute path; the product refuses to guess its data folder too")
    return ntpath.join(local, APP_DIR, DB_FILE)


def fixture_text():
    """The golden `plain` set as one JSONL text, as apps/web/e2e/v02-screens.ts fixtureSetText("plain") builds it."""
    fixtures = os.path.join(REPO, "fixtures")
    with open(os.path.join(fixtures, "v02-expected.json"), encoding="utf-8") as fh:
        files = json.load(fh)["sets"][FIXTURE_SET]["files"]
    parts = []
    for name in files:
        with open(os.path.join(fixtures, name), encoding="utf-8") as fh:
            parts.append(fh.read().strip())
    return "\n".join(parts)


def prepare(db_path, out_dir):
    if os.path.exists(db_path):
        raise StaleData("the canonical DB already exists: start from an empty data folder (RUNBOOK step 1)")
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, FIXTURE_FILE), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(fixture_text())
    with open(os.path.join(out_dir, "run-state.json"), "w", encoding="utf-8") as fh:
        json.dump({"startedAt": rr.now_iso()}, fh)


def open_ro(db_path):
    """A read-only connection: never creates the file, never writes (no rollback of a hot journal either)."""
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def read_site_db(db_path, cfg, started_at):
    """The e2e's counts from the canonical DB, opened read-only. An ok extraction call by any Provider id other than
    the configured real one is refusal ①; connection tests (`task_kind = 'connection-test'`) neither count nor
    refuse. The DB holds only the Provider id: a double bound under a real id is kept out of the installer by
    V01-T15's build check, not by this runner. A call row older than the run is stale."""
    floor = rr.parse_time(started_at)
    db = open_ro(db_path)
    try:
        one = lambda sql, *a: int(db.execute(sql, a).fetchone()[0])  # noqa: E731
        calls = db.execute("SELECT provider, outcome, task_kind, created_at FROM provider_calls").fetchall()
        for _provider, _outcome, _kind, created in calls:
            try:
                if rr.parse_time(created) < floor:
                    raise StaleData("provider calls older than this run are in the DB")
            except ValueError:
                raise StaleData("a provider call has an unreadable time")
        seen = {provider for provider, outcome, kind, _c in calls if outcome == "ok" and kind == "extract"}
        if seen - {cfg["provider"]["id"]}:
            raise Refusal(NOTICE_DOUBLE, "observed-provider")
        return {
            "sourceVersions": one("SELECT count(*) FROM source_versions"),
            "insights": one("SELECT count(*) FROM insights"),
            "activeInsights": one("SELECT count(*) FROM insights WHERE state = 'active'"),
            "jobsNotSucceeded": one("SELECT count(*) FROM jobs WHERE status <> 'succeeded'"),
            "providerCalls": one("SELECT count(*) FROM provider_calls WHERE provider = ? AND outcome = 'ok' AND task_kind = 'extract'",
                                 cfg["provider"]["id"]),
            "droppedQuotes": one("SELECT coalesce(sum(dropped_quotes), 0) FROM jobs"),
            "droppedOther": one("SELECT coalesce(sum(dropped_other), 0) FROM jobs"),
        }
    finally:
        db.close()


def judge(counts, observed):
    if any(counts[k] != v for k, v in EXPECTED.items()) or counts["providerCalls"] < MIN_PROVIDER_CALLS:
        return "FAIL"
    if set(OBSERVATIONS) - set(observed):
        return "INCONCLUSIVE"
    return "PASS"


def _git(*args):
    try:
        res = subprocess.run(["git", "-C", REPO] + list(args), capture_output=True, text=True, timeout=30)
        return res.stdout.strip() if res.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def build_site_record(cfg, app_version, counts, verdict, started_at):
    commit = _git("rev-parse", "HEAD")
    u = platform_module.uname()
    return {
        "schema": rr.SCHEMA, "record": "v02-site-flow", "status": "passed" if verdict == "PASS" else "failed",
        "provider": {k: cfg["provider"][k] for k in ("kind", "id", "name", "version")},
        "target": rr.SITE_TARGET, "os": " ".join(x for x in (u.system, u.release, u.version, u.machine) if x),
        "appVersion": app_version, "node": None, "electron": None,
        "commit": commit if commit and rr.COMMIT_RE.match(commit) else "unknown",
        "worktreeDirty": bool(_git("status", "--porcelain")),
        "startedAt": started_at, "finishedAt": rr.now_iso(),
        "steps": ["prepare", "operator-screens", "record"], "counts": counts,
    }


def write_results(record, verdict, observed, out_dir, literals):
    """The allowlisted pasteable pair (fails closed, writes nothing on error), then the local raw/ run record.
    The record must pass its own form check first."""
    problems = rr.validate_record(record)
    if problems:
        raise RecordInvalid("; ".join(problems[:5]))
    p = record["provider"]
    c = record["counts"]
    facts = {"provider_kind": p["kind"], "provider_id": p["id"], "app_version": results.normalize_version(record["appVersion"])[0],
             "source_versions": c["sourceVersions"], "insights": c["insights"], "active_insights": c["activeInsights"],
             "jobs_not_succeeded": c["jobsNotSucceeded"], "provider_calls": c["providerCalls"],
             "dropped_quotes": c["droppedQuotes"], "dropped_other": c["droppedOther"],
             "observed": [w for w in OBSERVATIONS if w in observed],
             "kit_commit": record["commit"][:12] if record["commit"] != "unknown" else "unknown"}
    notes = ["unit_tests_not_site_evidence"]
    if p["id"] == "openai-compatible":
        facts["model"] = results.model_fact(p["version"])
    else:
        version, ok = results.normalize_version(p["version"])
        facts["version"] = version
        if not ok:
            notes.append("version_unrecognized")
    obj = {"schema_version": results.SCHEMA_VERSION, "kit": KIT, "mode": "real",
           "created": record["finishedAt"].split(".")[0] + "Z",
           "environment": results.project_environment(environment_fingerprint()),
           "checks": [{"id": CHECK_ID, "verdict": verdict, "facts": facts,
                       "codes": ["v02_manual_observations", "v02_dropped_counts_unjudged"]}],
           "metrics": {}, "notes": notes, "dropped_fields": 0}
    redactor = Redactor(literals={x: "<REDACTED>" for x in literals})
    paths = results.write_result_obj(obj, out_dir, redactor)
    results.write_raw_files(out_dir, {"README": ""}, redactor)  # adds README_NEVER_PASTE.txt
    with open(os.path.join(out_dir, "raw", "run-record.{}.json".format(rr.SITE_TARGET)), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return paths


# ---- deletion scenario (I04-R19, S22) -------------------------------------------------------------------------------

def run_delete_scenario(args):
    """Refusal first, before the config is read: outside Windows nothing else is looked at. Raises like the other commands."""
    if sys.platform != "win32":
        raise Refusal(NOTICE_DELETE_NOT_INSTALLER.format(code="not-windows"), "not-windows")
    cfg = delete_scenario.validate_config(load_json_object(args.config))
    app_version = delete_gate(cfg)
    if args.action == "preflight":
        print("preflight ok: installed app {}, collector {}".format(app_version, cfg["collector"]["kind"]))
        return 0
    if not args.out:
        raise ConfigError("--out is required for {}".format(args.action))
    db_path = site_db_path()
    if args.action == "prepare":
        canaries = delete_scenario.prepare(db_path, args.out)
        print("wrote {} to --out. Put each word into the text of one synthetic item of the site's test system, "
              "RUNBOOK.md section 8 (never into a real item):".format(delete_scenario.STATE_FILE))
        for role in delete_scenario.ROLES:
            print("  {:8} {}".format(role, canaries[role]))
        return 0
    started_at, canaries = delete_scenario.load_state(args.out)
    counts = delete_scenario.read_delete_counts(db_path)
    # the data folder, the Electron userData folder (Chromium storage, outside the data folder) and the extra folders
    dirs = delete_scenario.scan_dirs(cfg, db_path)
    found, unreadable = delete_scenario.scan_canaries(dirs, canaries)
    index = delete_scenario.read_index_terms(db_path, canaries)
    verdict = delete_scenario.judge(counts, found, args.observed, index, unreadable)
    record = delete_scenario.build_record(cfg, app_version, counts, found, verdict, args.observed, started_at, index,
                                          unreadable, commit=_git("rev-parse", "HEAD"))
    delete_scenario.write_results(record, verdict, args.observed, args.out, args.redact)
    print("{} {} (paste only result.json/result.md; never raw/)".format(delete_scenario.CHECK_ID, verdict))
    return 0 if verdict == "PASS" else 1


# ---- Semantic measurement (S01-R25, S32) -----------------------------------------------------------------------------

def run_semantic_scenario(args):
    """Refusal first, before the config is read: outside Windows nothing else is looked at. Raises like the other commands."""
    if sys.platform != "win32":
        raise Refusal(NOTICE_SEMANTIC_NOT_INSTALLER.format(code="not-windows"), "not-windows")
    cfg = load_config(args.config)
    app_version = semantic_gate(cfg)
    if args.action == "preflight":
        print("preflight ok: installed app {}, provider {}".format(app_version, cfg["provider"]["id"]))
        return 0
    if not args.out or not args.phase:
        raise ConfigError("--out and --phase are required for record")
    counts = semantic_scenario.read_counts(site_db_path(), args.phase)
    warning = semantic_scenario.phase_warning(counts)
    if warning:
        print("warning: {}".format(warning), file=sys.stderr)
    path = semantic_scenario.write_counts(counts, args.out)
    print("wrote {} (counts only, no text; this is a measurement, not a verdict)".format(os.path.basename(path)))
    return 0


# ---- Entity-resolution measurement (S02-R27, R28, S33) ----------------------------------------------------------------

def run_entity_scenario(args):
    """Refusal first, before the config is read: outside Windows nothing else is looked at. Raises like the other commands."""
    if sys.platform != "win32":
        raise Refusal(NOTICE_ENTITY_NOT_INSTALLER.format(code="not-windows"), "not-windows")
    cfg = load_config(args.config)
    app_version = entity_gate(cfg)
    if args.action == "preflight":
        print("preflight ok: installed app {}, provider {}".format(app_version, cfg["provider"]["id"]))
        return 0
    if not args.out or not args.phase:
        raise ConfigError("--out and --phase are required for record")
    counts = entity_scenario.read_counts(site_db_path(), args.phase)
    warning = entity_scenario.phase_warning(counts)
    if warning:
        print("warning: {}".format(warning), file=sys.stderr)
    path = entity_scenario.write_counts(counts, args.out)
    print("wrote {} (counts only, no text; this is a measurement, not a verdict)".format(os.path.basename(path)))
    return 0


# ---- queue and scheduler recovery scenarios (I03-R25, S19) ------------------------------------------------------------

def run_queue_scenario(args, installer_check=None, db_path=None):
    """Refusal first, before the config is read: outside Windows nothing else is looked at. `installer_check` and `db_path`
    are for the tests only (main's keyword arguments, no command-line switch reaches them): a stand-in for "this is the
    Windows installed build", which lets a development PC reach the second refusal, the missing sleep record."""
    if installer_check is None and sys.platform != "win32":
        raise Refusal(NOTICE_QUEUE_NOT_INSTALLER.format(code="not-windows"), "not-windows")
    cfg = queue_scenario.validate_config(load_json_object(args.config))
    app_version = (installer_check or queue_gate)(cfg)
    scenario = args.scenario
    if args.action == "preflight":
        print("preflight ok: installed app {}, scenario {}".format(app_version, scenario))
        return 0
    if not args.out:
        raise ConfigError("--out is required for {}".format(args.action))
    db_path = db_path or site_db_path()
    if args.action == "prepare":
        try:
            queue_scenario.prepare(db_path, args.out, scenario)
        except queue_scenario.StaleBaseline as exc:
            raise StaleData(str(exc)) from exc
        print("wrote {} to --out. Next: RUNBOOK.md section 9 (scenario {}), then `record`.".format(queue_scenario.STATE_FILE, scenario))
        return 0
    sleep_path = args.sleep_record or os.path.join(args.out, queue_scenario.SLEEP_RECORD_FILE)
    needs_sleep = scenario in queue_scenario.SLEEP_SCENARIOS
    if needs_sleep and not os.path.isfile(sleep_path):
        raise Refusal(NOTICE_SLEEP_RECORD.format(file=queue_scenario.SLEEP_RECORD_FILE, code="sleep-record-missing"), "sleep-record-missing")
    started_at, state_scenario, baseline = queue_scenario.load_state(args.out)
    if state_scenario != scenario:
        raise ConfigError("the state in --out is of scenario {}: run `prepare --scenario {}` first".format(state_scenario, scenario))
    window = None
    if needs_sleep:
        try:
            window = queue_scenario.sleep_window(queue_scenario.read_sleep_record(sleep_path, scenario, started_at))
        except queue_scenario.SleepRecordInvalid as exc:
            raise Refusal(NOTICE_SLEEP_RECORD.format(file=queue_scenario.SLEEP_RECORD_FILE, code="sleep-record-invalid"),
                          "sleep-record-invalid") from exc
    snap = queue_scenario.read_queue_state(db_path, baseline, window)
    verdict = queue_scenario.judge(scenario, args.observed, snap, cfg["expectedEffectRows"])
    record = queue_scenario.build_record(cfg, app_version, scenario, snap, verdict, args.observed, started_at, commit=_git("rev-parse", "HEAD"))
    queue_scenario.write_results(record, verdict, args.observed, args.out, args.redact)
    print("{} {} (paste only result.json/result.md; never raw/)".format(queue_scenario.CHECK_ID, verdict))
    return 0 if verdict == "PASS" else 1


# ---- entry -----------------------------------------------------------------------------------------------------------

def main(argv=None, installer_check=None, db_path=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    for name in ("preflight", "prepare", "record"):
        sp = sub.add_parser(name)
        sp.add_argument("--config", required=True)
        if name != "preflight":
            sp.add_argument("--out", required=True)
        if name == "record":
            sp.add_argument("--observed", action="append", default=[], choices=OBSERVATIONS)
            sp.add_argument("--redact", action="append", default=[])
    sp = sub.add_parser("delete-scenario")
    sp.add_argument("action", choices=("preflight", "prepare", "record"))
    sp.add_argument("--config", required=True)
    sp.add_argument("--out")
    sp.add_argument("--observed", action="append", default=[], choices=delete_scenario.OBSERVATIONS)
    sp.add_argument("--redact", action="append", default=[])
    sp = sub.add_parser("semantic-scenario")
    sp.add_argument("action", choices=("preflight", "record"))
    sp.add_argument("--config", required=True)
    sp.add_argument("--out")
    sp.add_argument("--phase", choices=semantic_scenario.PHASES)
    sp = sub.add_parser("entity-scenario")
    sp.add_argument("action", choices=("preflight", "record"))
    sp.add_argument("--config", required=True)
    sp.add_argument("--out")
    sp.add_argument("--phase", choices=entity_scenario.PHASES)
    sp = sub.add_parser("queue-scenario")
    sp.add_argument("action", choices=("preflight", "prepare", "record"))
    sp.add_argument("--scenario", required=True, choices=queue_scenario.SCENARIOS)
    sp.add_argument("--config", required=True)
    sp.add_argument("--out")
    sp.add_argument("--sleep-record", help="the manual sleep confirmation record; default <out>/sleep-confirmation.json")
    sp.add_argument("--observed", action="append", default=[], choices=queue_scenario.ALL_OBSERVATIONS)
    sp.add_argument("--redact", action="append", default=[])
    sp = sub.add_parser("summarize")
    sp.add_argument("--records", required=True)
    sp.add_argument("--since", required=True)
    sp.add_argument("--commit", help="full 40-hex SHA, or a name git resolves in this checkout (e.g. HEAD)")
    args = ap.parse_args(argv)

    if args.command == "summarize":
        commit = args.commit
        if commit == "unknown":
            print("--commit unknown pairs nothing: a site record without a commit cannot show the same-commit E2E "
                  "(record the pairing as 미검증)", file=sys.stderr)
            return CONFIG_EXIT
        if commit is not None and not rr.COMMIT_RE.match(commit):
            commit = _git("rev-parse", "--verify", "--quiet", commit + "^{commit}")
            if not commit:
                print("--commit does not name a commit of this checkout", file=sys.stderr)
                return CONFIG_EXIT
        try:
            kept, ignored = rr.load_current_records(args.records, args.since, commit)
        except ValueError:
            print("--since must be a UTC timestamp like 2026-11-22T01:00:00.000Z", file=sys.stderr)
            return CONFIG_EXIT
        for target in sorted(kept):
            r = kept[target]
            print("{:18} {:12} {:18} {:7} droppedQuotes={}".format(target, r["provider"]["kind"], r["provider"]["id"],
                                                                     r["status"], r["counts"]["droppedQuotes"]))
        print("ignored: {}".format(json.dumps(ignored, sort_keys=True)))
        return 0

    try:
        if args.command == "delete-scenario":
            return run_delete_scenario(args)
        if args.command == "semantic-scenario":
            return run_semantic_scenario(args)
        if args.command == "entity-scenario":
            return run_entity_scenario(args)
        if args.command == "queue-scenario":
            return run_queue_scenario(args, installer_check=installer_check, db_path=db_path)
        cfg = load_config(args.config)
        app_version = gate(cfg)
        if args.command == "preflight":
            print("preflight ok: installed app {}, provider {}".format(app_version, cfg["provider"]["id"]))
            return 0
        db_path = site_db_path()
        if args.command == "prepare":
            prepare(db_path, args.out)
            print("wrote {} and run-state.json to --out. Next: RUNBOOK.md steps 3-7, close the app, then `record`."
                  .format(FIXTURE_FILE))
            return 0
        with open(os.path.join(args.out, "run-state.json"), encoding="utf-8") as fh:
            started_at = json.load(fh)["startedAt"]
        counts = read_site_db(db_path, cfg, started_at)
        verdict = judge(counts, args.observed)
        record = build_site_record(cfg, app_version, counts, verdict, started_at)
        write_results(record, verdict, args.observed, args.out, args.redact)
        print("{} {} (paste only result.json/result.md; never raw/)".format(CHECK_ID, verdict))
        return 0 if verdict == "PASS" else 1
    except Refusal as refusal:
        print(refusal.notice)
        return NOTICE_EXIT
    except (ConfigError, OSError, KeyError, ValueError) as exc:
        print("config error: {}".format(exc), file=sys.stderr)
        return CONFIG_EXIT
    except StaleData as exc:
        print("stale-data: {}".format(exc), file=sys.stderr)
        return STALE_EXIT
    except (RedactionError, RecordInvalid, sqlite3.Error) as exc:
        busy = isinstance(exc, sqlite3.OperationalError) and any(w in str(exc) for w in ("locked", "readonly", "busy"))
        print(DB_BUSY_HINT if busy else "refused: {}: {}".format(type(exc).__name__, exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
