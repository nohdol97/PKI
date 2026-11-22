"""I03-T13 (spec I03-R25, site-setup S19): the queue and scheduler recovery scenarios of the V02 site runner. Helpers
only; run.py owns the refusal gate and the command line.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. The installed app refuses debugging switches and the test-only job
kind `test-effect` is not in an installed build, so the operator drives the steps (RUNBOOK section 9) with the app's own
screens and the real Provider: import synthetic sources, then kill the app, put the PC to sleep or hibernate, move the
clock or change the time zone. This module snapshots the canonical DB read-only before (`prepare`) and after (`record`),
reads what the queue left, and judges it. The sleep and hibernate scenarios also need the operator's manual confirmation
record (`sleep-confirmation.json`): the runner cannot make a PC sleep and cannot see that it did.
"""
import json
import os
import sqlite3
from urllib.request import pathname2url

import delete_scenario
import run_record as rr
from common import results

CHECK_ID = "I03-C2:queue-scenario"
STATE_FILE = "queue-scenario-state.json"
SLEEP_RECORD_FILE = "sleep-confirmation.json"
SCENARIOS = ("kill", "sleep", "hibernate", "clock-forward", "clock-back", "timezone")
SLEEP_SCENARIOS = ("sleep", "hibernate")
# a 10-minute period is the shortest: a sleep shorter than it cannot have made a slot due
MIN_SLEEP_SECONDS = 600
# the operator attests these; the runner cannot see the screens, the power state or the clock setting
OBSERVATIONS = {
    "kill": ("launched-installed", "killed-while-running", "restarted-installed", "no-duplicate-visible"),
    "sleep": ("launched-installed", "slept-with-work-due", "woke-app-running", "merge-visible"),
    "hibernate": ("launched-installed", "hibernated-with-work-due", "woke-app-running", "merge-visible"),
    "clock-forward": ("launched-installed", "clock-moved-forward", "clock-restored", "merge-visible"),
    "clock-back": ("launched-installed", "clock-moved-back", "clock-restored", "no-rerun-visible"),
    "timezone": ("launched-installed", "timezone-changed", "timezone-restored", "no-rerun-visible"),
}
ALL_OBSERVATIONS = tuple(dict.fromkeys(w for words in OBSERVATIONS.values() for w in words))
OPEN_STATUSES = ("queued", "running", "retry", "held")
# these need the queue to have found due work it did not run: a wake or a forward clock jump merges the missed slots
NEEDS_MERGE = ("sleep", "hibernate", "clock-forward")
SLEEP_RECORD_KEYS = {"schema", "scenario", "sleptAt", "wokeAt"}


ConfigError = delete_scenario.ConfigError  # one class for every scenario of the runner


class SleepRecordInvalid(Exception):
    """The manual sleep confirmation record does not fit this run."""


def validate_config(cfg):
    """The queue-scenario config: the installer identity of the V02 config and how many effect rows the synthetic input
    the operator imports must leave (one succeeded extraction per imported source version)."""
    if not isinstance(cfg, dict):
        raise ConfigError("config must be a JSON object")
    if not (isinstance(cfg.get("productName"), str) and isinstance(cfg.get("installedExe"), str)):
        raise ConfigError("config needs productName and installedExe strings")
    n = cfg.get("expectedEffectRows")
    if not (isinstance(n, int) and not isinstance(n, bool) and n >= 1):
        raise ConfigError("config needs expectedEffectRows: the number of synthetic sources the operator imports (a whole number from 1)")
    return cfg


def open_ro(db_path):
    return sqlite3.connect("file:{}?mode=ro".format(pathname2url(os.path.abspath(db_path))), uri=True)


def read_baseline(db_path):
    """{maxJobId, mergedSlots} of the canonical DB now; zeros when there is no DB yet."""
    if not os.path.exists(db_path):
        return {"maxJobId": 0, "mergedSlots": 0}
    db = open_ro(db_path)
    try:
        max_id = int(db.execute("SELECT coalesce(max(id), 0) FROM jobs").fetchone()[0])
        merged = int(db.execute("SELECT coalesce(sum(coalesced_count + held_coalesced_count), 0) FROM schedules").fetchone()[0])
        return {"maxJobId": max_id, "mergedSlots": merged}
    finally:
        db.close()


def read_queue_state(db_path, baseline):
    """What the queue left since `baseline`, read-only. `effectRows` are the succeeded extraction jobs (one per source
    version; the unique keys of the jobs table make a second open one impossible, so a count above the imported number or a
    (source, version, target) with two is a defect); `reclaimedJobs` are the succeeded jobs that needed more than one attempt (a
    killed run taken again); `mergedSlots` is the merged-slot counters of the schedules above the baseline."""
    db = open_ro(db_path)
    try:
        one = lambda sql, *a: int(db.execute(sql, a).fetchone()[0])  # noqa: E731
        after = baseline["maxJobId"]
        by_status = {s: int(n) for s, n in db.execute("SELECT status, count(*) FROM jobs WHERE id > ? GROUP BY status", (after,))}
        merged = one("SELECT coalesce(sum(coalesced_count + held_coalesced_count), 0) FROM schedules") - baseline["mergedSlots"]
        return {
            "jobsByStatus": by_status,
            "effectRows": one("SELECT count(*) FROM jobs WHERE id > ? AND kind = 'extract' AND status = 'succeeded'", after),
            "reclaimedJobs": one("SELECT count(*) FROM jobs WHERE id > ? AND status = 'succeeded' AND attempts >= 2", after),
            "mergedSlots": max(merged, 0),
            "duplicateEffects": one("SELECT count(*) FROM (SELECT 1 FROM jobs WHERE id > ? AND kind = 'extract' AND status = 'succeeded' "
                                    "GROUP BY source_id, fence_version, target HAVING count(*) > 1)", after),
            "duplicateSlotJobs": one("SELECT count(*) FROM (SELECT 1 FROM jobs WHERE id > ? AND schedule_id IS NOT NULL "
                                     "GROUP BY schedule_id, slot HAVING count(*) > 1)", after),
        }
    finally:
        db.close()


def prepare(db_path, out_dir, scenario):
    """Writes the state (start time, scenario, baseline of the DB as it is now). An existing DB is fine: the six scenarios
    run one after another on one install, and each counts only what came after its own baseline."""
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, STATE_FILE), "w", encoding="utf-8") as fh:
        json.dump({"startedAt": rr.now_iso(), "scenario": scenario, "baseline": read_baseline(db_path)}, fh)


def load_state(out_dir):
    with open(os.path.join(out_dir, STATE_FILE), encoding="utf-8") as fh:
        state = json.load(fh)
    base = state["baseline"]
    if state["scenario"] not in SCENARIOS or not all(isinstance(base.get(k), int) for k in ("maxJobId", "mergedSlots")):
        raise ConfigError("state file is not a queue-scenario state")
    return state["startedAt"], state["scenario"], {"maxJobId": base["maxJobId"], "mergedSlots": base["mergedSlots"]}


def read_sleep_record(path, scenario, started_at):
    """The operator's manual confirmation that the PC slept (or hibernated) for at least one shortest period during this
    run. Raises SleepRecordInvalid with a short reason; the runner turns that into the `배포처 후속` notice."""
    try:
        with open(path, encoding="utf-8-sig") as fh:
            rec = json.load(fh)
    except (OSError, ValueError):
        raise SleepRecordInvalid("unreadable")
    if not isinstance(rec, dict) or set(rec) != SLEEP_RECORD_KEYS or rec["schema"] != 1:
        raise SleepRecordInvalid("fields")
    if rec["scenario"] != scenario:
        raise SleepRecordInvalid("scenario")
    try:
        slept, woke, floor = rr.parse_time(rec["sleptAt"]), rr.parse_time(rec["wokeAt"]), rr.parse_time(started_at)
    except ValueError:
        raise SleepRecordInvalid("time")
    if slept < floor:
        raise SleepRecordInvalid("before-this-run")
    if (woke - slept).total_seconds() < MIN_SLEEP_SECONDS:
        raise SleepRecordInvalid("too-short")
    return rec


def judge(scenario, observed, snap, expected_effects):
    """FAIL: the effect rows are not the imported number, an extraction (or a schedule slot) left twice, or a job was given
    up. INCONCLUSIVE: work is still unfinished, the scenario's event left no trace (a kill that reclaimed nothing, a wake or
    forward jump that merged nothing), or an attestation is missing."""
    status = snap["jobsByStatus"]
    if (snap["effectRows"] != expected_effects or snap["duplicateEffects"] or snap["duplicateSlotJobs"]
            or status.get("dead_letter", 0)):
        return "FAIL"
    if sum(status.get(s, 0) for s in OPEN_STATUSES):
        return "INCONCLUSIVE"
    if (scenario == "kill" and not snap["reclaimedJobs"]) or (scenario in NEEDS_MERGE and not snap["mergedSlots"]):
        return "INCONCLUSIVE"
    if set(OBSERVATIONS[scenario]) - set(observed):
        return "INCONCLUSIVE"
    return "PASS"


def build_record(cfg, app_version, scenario, snap, verdict, observed, started_at, commit=None):
    import platform as platform_module
    u = platform_module.uname()
    open_jobs = sum(snap["jobsByStatus"].get(s, 0) for s in OPEN_STATUSES)
    return {
        "schema": rr.SCHEMA, "record": "i03-queue-scenario", "status": "passed" if verdict == "PASS" else "failed",
        "verdict": verdict, "os": " ".join(x for x in (u.system, u.release, u.version, u.machine) if x),
        "appVersion": app_version, "scenario": scenario,
        "observed": [w for w in OBSERVATIONS[scenario] if w in observed],
        "jobsByStatus": dict(snap["jobsByStatus"]), "jobsOpen": open_jobs,
        "expectedEffectRows": cfg["expectedEffectRows"], "effectRows": snap["effectRows"], "mergedSlots": snap["mergedSlots"],
        "reclaimedJobs": snap["reclaimedJobs"], "duplicateEffects": snap["duplicateEffects"],
        "duplicateSlotJobs": snap["duplicateSlotJobs"],
        "commit": commit if commit and rr.COMMIT_RE.match(commit) else "unknown",
        "startedAt": started_at, "finishedAt": rr.now_iso(),
    }


def write_results(record, verdict, observed, out_dir, literals):
    """The allowlisted pasteable pair (fails closed, writes nothing on error), then the local raw/ record."""
    from common.fingerprint import environment_fingerprint
    from common.redact import Redactor
    facts = {"scenario": record["scenario"], "app_version": results.normalize_version(record["appVersion"])[0],
             "effect_rows": record["effectRows"], "merged_slots": record["mergedSlots"],
             "reclaimed_jobs": record["reclaimedJobs"], "duplicate_effects": record["duplicateEffects"],
             "duplicate_slot_jobs": record["duplicateSlotJobs"], "jobs_open": record["jobsOpen"],
             "jobs_dead_letter": record["jobsByStatus"].get("dead_letter", 0),
             "observed": [w for w in OBSERVATIONS[record["scenario"]] if w in observed],
             "kit_commit": record["commit"][:12] if record["commit"] != "unknown" else "unknown"}
    obj = {"schema_version": results.SCHEMA_VERSION, "kit": "v02-site-flow", "mode": "real",
           "created": record["finishedAt"].split(".")[0] + "Z",
           "environment": results.project_environment(environment_fingerprint()),
           "checks": [{"id": CHECK_ID, "verdict": verdict, "facts": facts,
                       "codes": ["i03_manual_observations", "i03_effect_definition"]}],
           "metrics": {}, "notes": ["unit_tests_not_site_evidence"], "dropped_fields": 0}
    redactor = Redactor(literals={x: "<REDACTED>" for x in literals})
    paths = results.write_result_obj(obj, out_dir, redactor)
    results.write_raw_files(out_dir, {"README": ""}, redactor)
    with open(os.path.join(out_dir, "raw", "run-record.queue-scenario.{}.json".format(record["scenario"])), "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return paths
