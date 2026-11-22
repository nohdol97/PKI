"""I03-T13 (I03-R25, I03-H2) `site-verify.refuse`: the queue and scheduler recovery scenarios of the V02 site runner
refuse outside the Windows installer (case 1) and, with the installer check swapped for a stand-in, without the operator's
manual sleep-scenario confirmation record (case 2). The judge and the record form are checked on synthetic data. Nothing
here is site evidence: the Windows branch was never run."""
import contextlib
import datetime
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

try:
    from . import _paths
except ImportError:
    import _paths

from common import results

KIT = "v02-site-flow"
site = _paths.load_kit_module(KIT, "run.py", "i03_site_run")
qs = site.queue_scenario  # the module run.py imported: one set of exception classes

NOTICE = "배포처 후속"
STARTED = "2026-11-22T01:00:00.000Z"
SLEPT = "2026-11-22T01:10:00.000Z"
WOKE = "2026-11-22T01:40:00.000Z"
INSTALLED = lambda _cfg: "0.1.0"  # noqa: E731 - the stand-in for "this is the Windows installed build"


def setUpModule():
    """The fixtures are dated 2023: pin the clock `prepare` reads to just before their first due slot."""
    global _CLOCK
    _CLOCK = unittest.mock.patch.object(qs, "now_ms", lambda: T0)
    _CLOCK.start()


def tearDownModule():
    _CLOCK.stop()


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(obj, fh)


def config(**over):
    cfg = {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe", "expectedEffectRows": 3}
    cfg.update(over)
    return cfg


TEN = 600_000
T0 = 1_700_000_000_000 // TEN * TEN  # a slot boundary
EVERY_10 = json.dumps({"kind": "every-10-minutes"})
DAILY = json.dumps({"kind": "daily", "at": {"hour": 3, "minute": 0}})
BASE1 = {"nextDue": T0 + TEN, "lengthMs": TEN}


def make_db(path, jobs=(), schedules=((T0 + TEN, EVERY_10),)):
    """The columns read_queue_state reads, in the shape of the real tables (storage/src/migrations.ts v14-v15, with the jobs
    table's UNIQUE keys). jobs: (kind, status, attempts, source_id, fence_version, schedule_id, slot);
    schedules: (next_due, period JSON)."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                           attempts INTEGER NOT NULL, source_id INTEGER, fence_version INTEGER, schedule_id INTEGER, slot INTEGER,
                           CHECK ((source_id IS NULL) = (fence_version IS NULL)), CHECK ((schedule_id IS NULL) = (slot IS NULL)),
                           UNIQUE (kind, target, source_id, fence_version), UNIQUE (schedule_id, slot));
        CREATE TABLE schedules (id INTEGER PRIMARY KEY, period TEXT NOT NULL, next_due INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
                                coalesced_count INTEGER NOT NULL DEFAULT 0, held_coalesced_count INTEGER NOT NULL DEFAULT 0);
    """)
    db.executemany("INSERT INTO jobs (kind, status, attempts, source_id, fence_version, schedule_id, slot) VALUES (?,?,?,?,?,?,?)", jobs)
    db.executemany("INSERT INTO schedules (next_due, period) VALUES (?,?)", schedules)
    db.commit()
    db.close()


def good_jobs(n=3):
    """n succeeded extraction jobs, the first needing a second attempt (a killed run taken again)."""
    return [("extract", "succeeded", 2 if i == 0 else 1, i + 1, 1, None, None) for i in range(n)]


def sleep_job(gap_periods):
    """The shape of backend/src/scheduler.test.ts `coalesce.sleep`: next due T0+10min, the machine sleeps, ONE job is
    registered for the latest slot, `coalesced_count` stays 0. gap_periods=48 is the 8-hour sleep (48 due slots)."""
    return ("connector-sync", "succeeded", 1, None, None, 1, T0 + TEN * gap_periods)


def iso(ms):
    return datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def restart_at(out, started_at):
    """Pins the state's start time, so a sleep record dated in 2026-11-22 is compared with a fixed start, not the clock."""
    path = os.path.join(out, qs.STATE_FILE)
    state = json.loads(read(path))
    state["startedAt"] = started_at
    write_json(path, state)


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def run_main(argv, **kw):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = site.main(argv, **kw)
    return code, out.getvalue(), err.getvalue()


class SiteVerifyRefuse(unittest.TestCase):
    """I03-H2 `site-verify.refuse`: one notice starting with `배포처 후속` on stdout, a non-zero exit, per case."""

    def notice_lines(self, stdout):
        return [l for l in stdout.splitlines() if l.startswith(NOTICE)]

    def test_case_1_outside_a_windows_installer_is_refused_with_one_notice(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        for scenario in qs.SCENARIOS:
            res = run_cli("queue-scenario", "record", "--scenario", scenario, "--config",
                          os.path.join(tempfile.gettempdir(), "no-such-config.json"), "--out", tempfile.gettempdir())
            self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertEqual(res.returncode, site.NOTICE_EXIT, scenario)
            lines = self.notice_lines(res.stdout)
            self.assertEqual(len(lines), 1, res.stdout + res.stderr)
            self.assertIn("S19", lines[0])
            self.assertIn("not-windows", lines[0])
            self.assertEqual([l for l in res.stderr.splitlines() if NOTICE in l], [])

    def test_case_1_every_action_goes_through_the_same_refusal_and_writes_nothing(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            path = os.path.join(d, "config.json")
            write_json(path, config())
            for action in ("preflight", "prepare", "record"):
                res = run_cli("queue-scenario", action, "--scenario", "kill", "--config", path, "--out", out)
                self.assertEqual(res.returncode, site.NOTICE_EXIT, action)
                self.assertEqual(len(self.notice_lines(res.stdout)), 1, action)
            self.assertEqual(os.listdir(out), [])

    def test_case_2_installed_build_without_the_manual_sleep_record_is_refused_with_one_notice(self):
        for scenario in qs.SLEEP_SCENARIOS:
            with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
                path = os.path.join(d, "config.json")
                write_json(path, config())
                code, stdout, stderr = run_main(["queue-scenario", "record", "--scenario", scenario, "--config", path, "--out", out],
                                                installer_check=INSTALLED, db_path=os.path.join(d, "pki.sqlite"))
                self.assertNotEqual(code, 0, stdout + stderr)
                self.assertEqual(code, site.NOTICE_EXIT, scenario)
                lines = self.notice_lines(stdout)
                self.assertEqual(len(lines), 1, stdout + stderr)
                self.assertIn("S19", lines[0])
                self.assertIn("sleep-record-missing", lines[0])
                self.assertEqual(os.listdir(out), [])  # a refusal writes nothing

    def test_case_2_a_record_that_does_not_fit_this_run_is_refused_too(self):
        bad = {
            "wrong-scenario": dict(scenario="hibernate", sleptAt=SLEPT, wokeAt=WOKE),
            "too-short": dict(scenario="sleep", sleptAt=SLEPT, wokeAt="2026-11-22T01:15:00.000Z"),
            "before-this-run": dict(scenario="sleep", sleptAt="2026-11-22T00:00:00.000Z", wokeAt="2026-11-22T00:30:00.000Z"),
            "not-a-time": dict(scenario="sleep", sleptAt="yesterday", wokeAt=WOKE),
            "extra-key": dict(scenario="sleep", sleptAt=SLEPT, wokeAt=WOKE, note="free text"),
        }
        for name, body in bad.items():
            with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
                path = os.path.join(d, "config.json")
                write_json(path, config())
                db = os.path.join(d, "pki.sqlite")
                make_db(db)
                qs.prepare(db, out, "sleep")
                restart_at(out, STARTED)
                write_json(os.path.join(out, qs.SLEEP_RECORD_FILE), dict(schema=1, **body))
                code, stdout, _err = run_main(["queue-scenario", "record", "--scenario", "sleep", "--config", path, "--out", out],
                                              installer_check=INSTALLED, db_path=db)
                self.assertEqual(code, site.NOTICE_EXIT, name)
                self.assertEqual(len(self.notice_lines(stdout)), 1, name)
                self.assertIn("sleep-record-invalid", stdout, name)

    def test_the_other_scenarios_do_not_need_the_sleep_record(self):
        for scenario in set(qs.SCENARIOS) - set(qs.SLEEP_SCENARIOS):
            with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
                path = os.path.join(d, "config.json")
                write_json(path, config())
                db = os.path.join(d, "pki.sqlite")
                make_db(db)
                qs.prepare(db, out, scenario)
                code, stdout, _err = run_main(["queue-scenario", "record", "--scenario", scenario, "--config", path, "--out", out],
                                              installer_check=INSTALLED, db_path=db)
                self.assertNotEqual(code, site.NOTICE_EXIT, scenario + stdout)  # judged INCONCLUSIVE, not refused
                self.assertEqual(self.notice_lines(stdout), [], scenario)

    def test_on_windows_the_installer_check_is_the_v02_one_with_the_s19_notice(self):
        entries = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI", "DisplayVersion": "0.1.0"}]
        self.assertEqual(site.queue_gate(config(), platform="win32", read_uninstall=lambda: entries, is_file=lambda _p: True,
                                         in_git_tree=lambda _p: False), "0.1.0")
        with self.assertRaises(site.Refusal) as ctx:
            site.queue_gate(config(), platform="win32", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertTrue(ctx.exception.notice.startswith(NOTICE))
        self.assertIn("S19", ctx.exception.notice)
        self.assertEqual(ctx.exception.code, "not-installed")
        with self.assertRaises(site.Refusal) as ctx:
            site.queue_gate(config(), platform="darwin", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertEqual(ctx.exception.code, "not-windows")

    def test_there_is_no_command_line_way_to_swap_the_installer_check(self):
        res = run_cli("queue-scenario", "preflight", "--scenario", "kill", "--config", "x.json", "--installer-check", "ok")
        self.assertEqual(res.returncode, 2, res.stdout + res.stderr)  # argparse: unknown argument
        self.assertEqual(self.notice_lines(res.stdout), [])


class QueueConfig(unittest.TestCase):
    def test_a_valid_config(self):
        self.assertEqual(qs.validate_config(config())["expectedEffectRows"], 3)

    def test_bad_configs_are_refused(self):
        for bad in (config(expectedEffectRows=0), config(expectedEffectRows="3"), config(expectedEffectRows=True),
                    config(expectedEffectRows=None), {"productName": "PKI"}, [], config(productName=1)):
            with self.assertRaises(site.ConfigError, msg=repr(bad)):
                qs.validate_config(bad)


class ReadState(unittest.TestCase):
    def snap(self, jobs, schedules=((T0 + TEN, EVERY_10),), baseline=None):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, jobs, schedules)
            return qs.read_queue_state(path, baseline or {"maxJobId": 0, "schedules": {"1": BASE1}})

    def test_counts_effects_and_retries(self):
        s = self.snap(good_jobs(3))
        self.assertEqual((s["effectRows"], s["retriedJobs"]), (3, 1))
        self.assertEqual(s["jobsByStatus"], {"succeeded": 3})

    def test_one_job_for_a_48_slot_sleep_counts_47_merged_slots_though_the_counter_stays_zero(self):
        """F1: the designed sleep path writes one job and leaves coalesced_count at 0; the merge is in the slot gap."""
        s = self.snap([sleep_job(48)])
        self.assertEqual(s["mergedSlots"], 47)

    def test_no_gap_means_no_merged_slot(self):
        self.assertEqual(self.snap([sleep_job(1)])["mergedSlots"], 0)  # the first due slot ran on time
        self.assertEqual(self.snap([])["mergedSlots"], 0)

    def test_the_next_slot_after_a_job_starts_from_that_slot_plus_one_period(self):
        jobs = [sleep_job(1), sleep_job(2)]  # the second job's slot is the very next one: nothing missed
        self.assertEqual(self.snap(jobs)["mergedSlots"], 0)
        self.assertEqual(self.snap([sleep_job(1), sleep_job(10)])["mergedSlots"], 8)

    def test_only_jobs_after_the_baseline_count(self):
        s = self.snap([sleep_job(48)], baseline={"maxJobId": 1, "schedules": {"1": BASE1}})
        self.assertEqual((s["effectRows"], s["mergedSlots"]), (0, 0))

    def test_a_schedule_that_did_not_exist_at_the_baseline_adds_nothing(self):
        self.assertEqual(self.snap([sleep_job(48)], baseline={"maxJobId": 0, "schedules": {}})["mergedSlots"], 0)

    def test_the_baseline_period_is_used_even_if_the_period_is_changed_to_daily_before_record(self):
        """D1: the runbook restores the cleanup schedule to daily before `record`; the 8-hour sleep still counts 47."""
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, [sleep_job(48)], schedules=((T0 + TEN, DAILY),))  # the stored period is daily at record time
            s = qs.read_queue_state(path, {"maxJobId": 0, "schedules": {"1": BASE1}})
            self.assertEqual(s["mergedSlots"], 47)

    def test_downtime_merged_by_a_startup_check_is_not_sleep_evidence(self):
        """D2: app closed 40 minutes, no sleep: the startup check registers one job for the downtime, then normal runs."""
        jobs = [sleep_job(5), sleep_job(6), sleep_job(7)]  # slots T0+50, +60, +70 min; baseline next due T0+10 min
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, jobs)
            base = {"maxJobId": 0, "schedules": {"1": BASE1}}
            self.assertEqual(qs.read_queue_state(path, base)["mergedSlots"], 4)  # without a window the downtime would count
            elsewhere = (T0 + TEN * 12, T0 + TEN * 15)  # a sleep record whose window the downtime does not span
            self.assertEqual(qs.read_queue_state(path, base, elsewhere)["mergedSlots"], 0)

    def test_a_gap_that_began_long_after_the_sleep_started_is_not_that_sleep(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, [sleep_job(48)])
            late = {"maxJobId": 0, "schedules": {"1": {"nextDue": T0 + 40 * TEN, "lengthMs": TEN}}}
            window = (T0 + 2 * TEN, T0 + 48 * TEN)
            self.assertEqual(qs.read_queue_state(path, late)["mergedSlots"], 8)
            self.assertEqual(qs.read_queue_state(path, late, window)["mergedSlots"], 0)

    def test_a_gap_that_spans_the_sleep_record_counts(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, [sleep_job(48)])
            # Slept 5 minutes in, while the next due (T0 + 10 min) was still ahead, as on a running app; woke at the job's slot.
            # Only the one period of slack after sleptAt lets this count: with `next_due <= sleptAt` it would be 0.
            window = (T0 + TEN // 2, T0 + 48 * TEN)
            self.assertEqual(qs.read_queue_state(path, {"maxJobId": 0, "schedules": {"1": BASE1}}, window)["mergedSlots"], 47)

    def test_the_database_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, good_jobs())
            before = os.path.getmtime(path)
            qs.read_queue_state(path, {"maxJobId": 0, "schedules": {}})
            self.assertEqual(os.path.getmtime(path), before)
            self.assertEqual(sorted(os.listdir(d)), ["pki.sqlite"])


def snapshot(**over):
    base = {"jobsByStatus": {"succeeded": 3}, "effectRows": 3, "retriedJobs": 1, "mergedSlots": 5}
    base.update(over)
    return base


def verdict(scenario="kill", snap=None, observed=None, expected=3):
    return qs.judge(scenario, list(qs.OBSERVATIONS[scenario] if observed is None else observed), snap or snapshot(), expected)


class Judge(unittest.TestCase):
    def test_every_scenario_can_pass(self):
        for scenario in qs.SCENARIOS:
            self.assertEqual(verdict(scenario), "PASS", scenario)

    def test_a_wrong_effect_count_or_a_given_up_job_fails(self):
        for scenario in qs.SCENARIOS:
            for snap in (snapshot(effectRows=4), snapshot(effectRows=2),
                         snapshot(jobsByStatus={"succeeded": 2, "dead_letter": 1})):
                self.assertEqual(verdict(scenario, snap), "FAIL", (scenario, snap))

    def test_unfinished_jobs_are_inconclusive(self):
        for status in ("queued", "running", "retry", "held"):
            self.assertEqual(verdict(snap=snapshot(jobsByStatus={"succeeded": 3, status: 1})), "INCONCLUSIVE", status)

    def test_a_kill_with_no_retried_job_proves_nothing(self):
        self.assertEqual(verdict("kill", snapshot(retriedJobs=0)), "INCONCLUSIVE")

    def test_a_wake_or_clock_jump_that_merged_nothing_proves_nothing(self):
        for scenario in ("sleep", "hibernate", "clock-forward"):
            self.assertEqual(verdict(scenario, snapshot(mergedSlots=0)), "INCONCLUSIVE", scenario)

    def test_a_missing_observation_is_inconclusive_for_each_word_of_each_scenario(self):
        for scenario in qs.SCENARIOS:
            words = list(qs.OBSERVATIONS[scenario])
            self.assertIn("launched-installed", words)
            for word in words:
                self.assertEqual(verdict(scenario, observed=[w for w in words if w != word]), "INCONCLUSIVE", (scenario, word))

    def test_fail_outranks_inconclusive(self):
        self.assertEqual(verdict("kill", snapshot(effectRows=4, retriedJobs=0), observed=[]), "FAIL")

    def test_each_scenario_has_its_own_words_and_the_listed_scenarios_are_the_six(self):
        self.assertEqual(qs.SCENARIOS, ("kill", "sleep", "hibernate", "clock-forward", "clock-back", "timezone"))
        self.assertEqual(qs.SLEEP_SCENARIOS, ("sleep", "hibernate"))


class PrepareState(unittest.TestCase):
    def test_prepare_writes_the_baseline_and_a_second_prepare_overwrites_it(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db, good_jobs(2))
            qs.prepare(db, out, "sleep")
            started, scenario, baseline = qs.load_state(out)
            self.assertEqual((scenario, baseline), ("sleep", {"maxJobId": 2, "schedules": {"1": BASE1}}))
            self.assertTrue(started.endswith("Z"))

    def test_prepare_without_a_database_baselines_zero(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            qs.prepare(os.path.join(d, "none.sqlite"), out, "kill")
            self.assertEqual(qs.load_state(out)[2], {"maxJobId": 0, "schedules": {}})

    def test_a_baseline_whose_next_due_is_already_past_is_refused_and_writes_nothing(self):
        """D2: the app was closed at prepare, its startup check would merge the downtime."""
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db)  # next due T0 + 10 min
            path = os.path.join(d, "config.json")
            write_json(path, config())
            with unittest.mock.patch.object(qs, "now_ms", lambda: T0 + 3 * TEN):
                code, stdout, err = run_main(["queue-scenario", "prepare", "--scenario", "clock-forward", "--config", path, "--out", out],
                                             installer_check=INSTALLED, db_path=db)
            self.assertEqual(code, site.STALE_EXIT, stdout + err)
            self.assertIn("stale-data", err)
            self.assertEqual(os.listdir(out), [])
            with self.assertRaises(qs.StaleBaseline), unittest.mock.patch.object(qs, "now_ms", lambda: T0 + 3 * TEN):
                qs.prepare(db, out, "kill")

    def test_a_disabled_schedule_does_not_make_the_baseline_stale(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db)
            conn = sqlite3.connect(db)
            conn.execute("UPDATE schedules SET enabled = 0")
            conn.commit()
            conn.close()
            with unittest.mock.patch.object(qs, "now_ms", lambda: T0 + 3 * TEN):
                qs.prepare(db, out, "kill")
            self.assertEqual(qs.load_state(out)[2]["schedules"], {})

    def test_a_state_of_another_scenario_is_refused_at_record_time(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db)
            qs.prepare(db, out, "kill")
            path = os.path.join(d, "config.json")
            write_json(path, config())
            code, _o, err = run_main(["queue-scenario", "record", "--scenario", "clock-back", "--config", path, "--out", out],
                                     installer_check=INSTALLED, db_path=db)
            self.assertEqual(code, site.CONFIG_EXIT, err)


class RecordWriting(unittest.TestCase):
    def write(self, verdict_="PASS", snap=None, out=None, scenario="kill"):
        words = list(qs.OBSERVATIONS[scenario])
        record = qs.build_record(config(), "0.1.0", scenario, snap or snapshot(), verdict_, words, STARTED)
        return record, qs.write_results(record, verdict_, words, out, [])

    def test_the_record_holds_the_r25_fields(self):
        with tempfile.TemporaryDirectory() as out:
            record, _ = self.write(out=out)
            for key in ("os", "appVersion", "scenario", "observed", "effectRows", "mergedSlots"):
                self.assertIn(key, record)
            self.assertEqual((record["scenario"], record["effectRows"], record["mergedSlots"], record["appVersion"]),
                             ("kill", 3, 5, "0.1.0"))
            self.assertEqual(record["observed"], list(qs.OBSERVATIONS["kill"]))

    def test_the_pasteable_result_validates_and_says_which_check(self):
        for scenario in qs.SCENARIOS:
            with tempfile.TemporaryDirectory() as out:
                _, (json_path, md_path) = self.write(out=out, scenario=scenario)
                obj = json.loads(read(json_path))
                self.assertEqual(results.validate_result(obj), [], scenario)
                check = obj["checks"][0]
                self.assertEqual(check["id"], "I03-C2:queue-scenario")
                self.assertEqual(check["verdict"], "PASS")
                self.assertEqual(check["facts"]["scenario"], scenario)
                self.assertEqual(check["facts"]["effect_rows"], 3)
                self.assertIn("unit_tests_not_site_evidence", obj["notes"])
                self.assertTrue(os.path.exists(os.path.join(out, "raw", "run-record.queue-scenario.{}.json".format(scenario))))
                self.assertIn(scenario, read(md_path))

    def test_the_runbook_lists_exactly_the_facts_the_runner_writes(self):
        import re
        runbook = read(os.path.join(_paths.VERIF_DIR, KIT, "RUNBOOK.md"))
        section = runbook.split("## 9.", 1)[1]
        paragraph = section.split("**붙이는 것.**", 1)[1].split("\n\n", 1)[0].split("`raw", 1)[0]
        listed = set(re.findall(r"`([a-z]+(?:_[a-z]+)*)`", paragraph))
        with tempfile.TemporaryDirectory() as out:
            _, (json_path, _md) = self.write(out=out)
            written = set(json.loads(read(json_path))["checks"][0]["facts"])
        self.assertEqual(listed, written)

    def test_a_failed_run_is_recorded_as_failed(self):
        with tempfile.TemporaryDirectory() as out:
            record, (json_path, _) = self.write("FAIL", snapshot(effectRows=4), out)
            self.assertEqual(record["status"], "failed")
            self.assertEqual(json.loads(read(json_path))["checks"][0]["verdict"], "FAIL")


class WholeRun(unittest.TestCase):
    """prepare, then record with the installer stand-in: the pieces line up end to end."""

    def test_a_passing_kill_run(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db)
            path = os.path.join(d, "config.json")
            write_json(path, config())
            code, stdout, err = run_main(["queue-scenario", "prepare", "--scenario", "kill", "--config", path, "--out", out],
                                         installer_check=INSTALLED, db_path=db)
            self.assertEqual(code, 0, stdout + err)
            conn = sqlite3.connect(db)
            conn.executemany("INSERT INTO jobs (kind, status, attempts, source_id, fence_version) VALUES ('extract', 'succeeded', ?, ?, 1)",
                             [(2, 1), (1, 2), (1, 3)])
            conn.commit()
            conn.close()
            argv = ["queue-scenario", "record", "--scenario", "kill", "--config", path, "--out", out]
            for word in qs.OBSERVATIONS["kill"]:
                argv += ["--observed", word]
            code, stdout, err = run_main(argv, installer_check=INSTALLED, db_path=db)
            self.assertEqual(code, 0, stdout + err)
            self.assertIn("I03-C2:queue-scenario PASS", stdout)
            obj = json.loads(read(os.path.join(out, "result.json")))
            self.assertEqual(obj["checks"][0]["verdict"], "PASS")

    def sleep_run(self, gap_periods):
        """prepare, an import's three extractions and one scheduled job registered after a sleep of `gap_periods` periods
        (coalesced_count stays 0, as the designed path leaves it), the manual record, then record."""
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db = os.path.join(d, "pki.sqlite")
            make_db(db)
            path = os.path.join(d, "config.json")
            write_json(path, config())
            run_main(["queue-scenario", "prepare", "--scenario", "sleep", "--config", path, "--out", out],
                     installer_check=INSTALLED, db_path=db)
            conn = sqlite3.connect(db)
            conn.executemany("INSERT INTO jobs (kind, status, attempts, source_id, fence_version) VALUES ('extract', 'succeeded', 1, ?, 1)",
                             [(1,), (2,), (3,)])
            conn.execute("INSERT INTO jobs (kind, status, attempts, schedule_id, slot) VALUES ('connector-sync', 'succeeded', 1, 1, ?)",
                         (T0 + TEN * gap_periods,))
            conn.commit()
            conn.close()
            write_json(os.path.join(out, qs.SLEEP_RECORD_FILE),
                       {"schema": 1, "scenario": "sleep", "sleptAt": iso(T0 + 2 * TEN), "wokeAt": iso(T0 + max(gap_periods, 3) * TEN)})
            restart_at(out, iso(T0))  # the run started before the sleep: the record is "after prepare"
            argv = ["queue-scenario", "record", "--scenario", "sleep", "--config", path, "--out", out]
            for word in qs.OBSERVATIONS["sleep"]:
                argv += ["--observed", word]
            return run_main(argv, installer_check=INSTALLED, db_path=db)

    def test_a_passing_sleep_run_shaped_like_coalesce_sleep(self):
        code, stdout, err = self.sleep_run(48)
        self.assertEqual(code, 0, stdout + err)
        self.assertIn("PASS", stdout)

    def test_a_sleep_run_with_no_slot_gap_is_inconclusive(self):
        code, stdout, err = self.sleep_run(1)
        self.assertEqual(code, 1, stdout + err)
        self.assertIn("INCONCLUSIVE", stdout)


if __name__ == "__main__":
    unittest.main()
