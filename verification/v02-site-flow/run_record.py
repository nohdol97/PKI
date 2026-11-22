"""The V02 run record form, v1 (spec V02 "T12가 넘기는 것" 4·5). One form for both writers:
apps/web/e2e/v02-flow.e2e.ts (Provider kind `test-double`, targets browser/electron) and this kit's `record`
(kind `real`, target windows-installer). A record is LOCAL: it is never pasted (it holds OS text and operator
input); the pasteable pair is projected from it by run.py.

STATUS: written off-site; only synthetic records were checked.
"""
import datetime
import glob
import json
import os
import re

SCHEMA = 1
RECORD_NAMES = ("v02-flow.e2e", "v02-site-flow")
KINDS = ("test-double", "real")
REAL_PROVIDER_IDS = ("openai-compatible", "claude-code", "codex")
E2E_TARGETS = ("browser", "electron")
SITE_TARGET = "windows-installer"
TARGETS = E2E_TARGETS + (SITE_TARGET,)
COUNT_KEYS = ("sourceVersions", "insights", "activeInsights", "jobsNotSucceeded", "providerCalls", "droppedQuotes",
              "droppedOther")
TOP_KEYS = {"schema", "record", "status", "provider", "target", "os", "appVersion", "node", "electron", "commit",
            "worktreeDirty", "startedAt", "finishedAt", "steps", "counts"}
TESTKIT_MARK = "@pki/testkit"
STRICT_VERSION = re.compile(r"^\d{1,5}\.\d{1,5}\.\d{1,5}(\.\d{1,6})?$")
COMMIT_RE = re.compile(r"^([0-9a-f]{40}|unknown)$")
TIME_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$")


def parse_time(value):
    if not (isinstance(value, str) and TIME_RE.match(value)):
        raise ValueError("not a UTC timestamp")
    base, _, frac = value[:-1].partition(".")
    t = datetime.datetime.strptime(base, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
    return t + datetime.timedelta(microseconds=int(frac.ljust(6, "0")) if frac else 0)


def now_iso():
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "{:03d}Z".format(t.microsecond // 1000)


def _text(value):
    return isinstance(value, str) and value.strip() != ""


def validate_record(obj):
    """Problems of a run record (empty list = valid)."""
    if not isinstance(obj, dict):
        return ["record must be an object"]
    problems = []
    missing = (TOP_KEYS - {"node", "electron"}) - set(obj)
    problems += ["missing '{}'".format(k) for k in sorted(missing)]
    problems += ["unexpected '{}'".format(k) for k in sorted(set(obj) - TOP_KEYS)]
    if obj.get("schema") != SCHEMA:
        problems.append("schema must be {}".format(SCHEMA))
    if obj.get("record") not in RECORD_NAMES:
        problems.append("record name not known")
    if obj.get("status") not in ("passed", "failed"):
        problems.append("status must be passed or failed")
    target = obj.get("target")
    if target not in TARGETS:
        problems.append("target not known")

    provider = obj.get("provider")
    if not isinstance(provider, dict):
        problems.append("provider must be an object")
        provider = {}
    kind = provider.get("kind")
    if kind not in KINDS:
        problems.append("provider.kind missing or not one of {}".format(KINDS))
    for key in ("id", "name", "version"):
        if not _text(provider.get(key)):
            problems.append("provider.{} is required".format(key))
    if set(provider) - {"kind", "id", "name", "version"}:
        problems.append("provider has unexpected keys")
    if kind == "real":
        # a test double can never be recorded as real: only the real Provider ids, never the testkit, only on site
        if provider.get("id") not in REAL_PROVIDER_IDS:
            problems.append("real provider id not one of {}".format(REAL_PROVIDER_IDS))
        if TESTKIT_MARK in str(provider.get("name")) or TESTKIT_MARK in str(provider.get("version")):
            problems.append("a testkit Provider cannot be real")
        if target != SITE_TARGET or obj.get("record") != "v02-site-flow":
            problems.append("real is recorded only by the site runner on the Windows installer")
    if target == SITE_TARGET and kind != "real":
        problems.append("the Windows installer record needs a real provider")
    if kind == "test-double" and target not in E2E_TARGETS:
        problems.append("a test double runs only in the E2E targets")

    if not _text(obj.get("os")):
        problems.append("os is required")
    app_version = obj.get("appVersion")
    if target == SITE_TARGET:
        if not (isinstance(app_version, str) and STRICT_VERSION.match(app_version)):
            problems.append("appVersion of the installer must be a strict version")
    elif app_version != "source":
        problems.append("appVersion of a source run is 'source'")
    for key in ("node", "electron"):
        if obj.get(key) is not None and not _text(obj.get(key)):
            problems.append("{} must be a string or null".format(key))
    if not (isinstance(obj.get("commit"), str) and COMMIT_RE.match(obj["commit"])):
        problems.append("commit must be 40 hex characters or 'unknown'")
    if not isinstance(obj.get("worktreeDirty"), bool):
        problems.append("worktreeDirty must be a boolean")
    times = []
    for key in ("startedAt", "finishedAt"):
        try:
            times.append(parse_time(obj.get(key)))
        except ValueError:
            problems.append("{} must be a UTC timestamp".format(key))
    if len(times) == 2 and times[1] < times[0]:
        problems.append("finishedAt is before startedAt")
    steps = obj.get("steps")
    if not (isinstance(steps, list) and steps and all(_text(s) for s in steps)):
        problems.append("steps must be a non-empty list of names")
    counts = obj.get("counts")
    if not isinstance(counts, dict) or set(counts) != set(COUNT_KEYS):
        problems.append("counts must hold exactly {}".format(", ".join(COUNT_KEYS)))
    elif not all(isinstance(counts[k], int) and not isinstance(counts[k], bool) and counts[k] >= 0 for k in COUNT_KEYS):
        problems.append("counts must be non-negative integers")
    return problems


def load_current_records(folder, since, commit=None):
    """({target: record}, {reason: count}) for run-record.*.json in `folder`. A record that finished before `since`
    (the start of the current run), of another commit (when given), or that fails validation is ignored and counted:
    Playwright clears only its default output folder, so earlier runs can still lie there."""
    floor = parse_time(since)
    kept, ignored = {}, {}

    def skip(reason):
        ignored[reason] = ignored.get(reason, 0) + 1

    for path in sorted(glob.glob(os.path.join(folder, "run-record.*.json"))):
        try:
            with open(path, encoding="utf-8") as fh:
                obj = json.load(fh)
        except (OSError, ValueError):
            skip("invalid")
            continue
        if validate_record(obj):
            skip("invalid")
        elif parse_time(obj["finishedAt"]) < floor:
            skip("stale")
        elif commit is not None and obj["commit"] != commit:
            skip("other-commit")
        else:
            kept[obj["target"]] = obj
    return kept, ignored
