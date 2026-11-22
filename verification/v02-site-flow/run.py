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
OBSERVATIONS = ("insight-inference", "evidence-opened", "reimport-no-new", "restart-kept")
EXPECTED = {"sourceVersions": 3, "insights": 1, "activeInsights": 1, "jobsNotSucceeded": 0}
MIN_PROVIDER_CALLS = 3  # one extraction per source; a schema mismatch calls once more (extraction.calls)
APP_DIR, DB_FILE = "PKI", "pki.sqlite"  # storage/src/data-directory.ts, backend/src/composition.ts
FIXTURE_SET, FIXTURE_FILE = "plain", "v02-plain.jsonl"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall"


class Refusal(Exception):
    def __init__(self, notice, code):
        super().__init__(code)
        self.notice, self.code = notice, code


class StaleData(Exception):
    """The canonical DB holds data from before this run."""


class ConfigError(Exception):
    pass


def load_config(path):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ConfigError("config is not readable JSON ({})".format(type(exc).__name__))
    if not isinstance(cfg, dict):
        raise ConfigError("config must be a JSON object")
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


def check_installer(cfg, platform, read_uninstall, is_file, in_git_tree):
    """The installed app's version from its uninstall entry, or Refusal ②. Inputs are measured, never overridable."""
    def refuse(code):
        raise Refusal(NOTICE_NOT_INSTALLER.format(code=code), code)

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


def read_site_db(db_path, cfg, started_at):
    """The e2e's counts from the canonical DB, opened read-only. The record's Provider kind follows the calls the DB
    shows: an ok call by anything but the configured real Provider is refusal ①; a row older than the run is stale."""
    floor = rr.parse_time(started_at)
    db = sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)
    try:
        one = lambda sql, *a: int(db.execute(sql, a).fetchone()[0])  # noqa: E731
        calls = db.execute("SELECT provider, outcome, created_at FROM provider_calls").fetchall()
        for _provider, _outcome, created in calls:
            try:
                if rr.parse_time(created) < floor:
                    raise StaleData("provider calls older than this run are in the DB")
            except ValueError:
                raise StaleData("a provider call has an unreadable time")
        seen = {provider for provider, outcome, _c in calls if outcome == "ok"}
        if seen - {cfg["provider"]["id"]}:
            raise Refusal(NOTICE_DOUBLE, "observed-provider")
        return {
            "sourceVersions": one("SELECT count(*) FROM source_versions"),
            "insights": one("SELECT count(*) FROM insights"),
            "activeInsights": one("SELECT count(*) FROM insights WHERE state = 'active'"),
            "jobsNotSucceeded": one("SELECT count(*) FROM jobs WHERE status <> 'succeeded'"),
            "providerCalls": one("SELECT count(*) FROM provider_calls WHERE provider = ? AND outcome = 'ok'",
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
    """The allowlisted pasteable pair (fails closed, writes nothing on error), then the local raw/ run record."""
    p = record["provider"]
    c = record["counts"]
    facts = {"provider_kind": p["kind"], "provider_id": p["id"], "app_version": results.normalize_version(record["appVersion"])[0],
             "source_versions": c["sourceVersions"], "insights": c["insights"], "active_insights": c["activeInsights"],
             "jobs_not_succeeded": c["jobsNotSucceeded"], "provider_calls": c["providerCalls"],
             "dropped_quotes": c["droppedQuotes"], "dropped_other": c["droppedOther"],
             "observed": [w for w in OBSERVATIONS if w in observed]}
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


# ---- entry -----------------------------------------------------------------------------------------------------------

def main(argv=None):
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
    sp = sub.add_parser("summarize")
    sp.add_argument("--records", required=True)
    sp.add_argument("--since", required=True)
    sp.add_argument("--commit")
    args = ap.parse_args(argv)

    if args.command == "summarize":
        try:
            kept, ignored = rr.load_current_records(args.records, args.since, args.commit)
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
        cfg = load_config(args.config)
        app_version = gate(cfg)
        if args.command == "preflight":
            print("preflight ok: installed app {}, provider {}".format(app_version, cfg["provider"]["id"]))
            return 0
        db_path = site_db_path()
        if args.command == "prepare":
            prepare(db_path, args.out)
            print("wrote {} and run-state.json to --out. Next: RUNBOOK.md steps 3-6, close the app, then `record`."
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
    except (RedactionError, sqlite3.Error) as exc:
        print("refused: {}".format(type(exc).__name__), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
