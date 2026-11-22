"""V02-T12 site runner (spec V02 "T12가 넘기는 것"): V02-H2 `site-verify.refuse`, V02-C4 `run-record`, stale records,
and the allowlisted pasteable result. All inputs are synthetic; nothing here is site evidence."""
import contextlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

from common import results

KIT = "v02-site-flow"
rr = _paths.load_kit_module(KIT, "run_record.py", "v02_run_record")
site = _paths.load_kit_module(KIT, "run.py", "v02_site_run")

NOTICE = "배포처 후속"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
STARTED = "2026-11-22T01:00:00.000Z"
FINISHED = "2026-11-22T01:30:00.000Z"
COUNTS = {"sourceVersions": 3, "insights": 1, "activeInsights": 1, "jobsNotSucceeded": 0,
          "providerCalls": 3, "droppedQuotes": 0, "droppedOther": 0}
ALL_OBSERVED = ["launched-installed", "insight-inference", "evidence-opened", "reimport-no-new", "restart-kept"]


def e2e_record(**over):
    """The shape apps/web/e2e/v02-flow.e2e.ts writes (T11 + the T12 fields)."""
    obj = {"schema": 1, "record": "v02-flow.e2e", "status": "passed",
           "provider": {"kind": "test-double", "id": "local-model", "name": "@pki/testkit FakeProvider + fixtureExtraction",
                        "version": "workspace"},
           "target": "browser", "os": "darwin 25.0.0 arm64", "appVersion": "source", "node": "24.11.0", "electron": None,
           "commit": COMMIT, "worktreeDirty": False, "startedAt": STARTED, "finishedAt": FINISHED,
           "steps": ["import", "insight", "evidence", "re-import", "restart", "evidence-after-restart"], "counts": dict(COUNTS)}
    obj.update(over)
    return obj


def site_record(**over):
    obj = e2e_record(record="v02-site-flow", target="windows-installer", appVersion="0.1.0", node=None,
                     os="Windows 10.0.26100 AMD64",
                     provider={"kind": "real", "id": "openai-compatible", "name": "openai-compatible", "version": "gpt-5-mini"})
    obj.update(over)
    return obj


def config(**provider):
    p = {"kind": "real", "id": "openai-compatible", "name": "openai-compatible", "version": "gpt-5-mini"}
    p.update(provider)
    return {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe", "provider": p}


def read_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def notice_lines(res):
    """Notice lines on stdout (the spec's channel); a notice on stderr is a failure of its own."""
    assert not [line for line in res.stderr.splitlines() if NOTICE in line], res.stderr
    return [line for line in res.stdout.splitlines() if line.startswith(NOTICE)]


def make_db(path, providers=("openai-compatible",) * 3, created=STARTED, versions=3, insights=(("active",),),
            jobs=(("succeeded", 0, 0),) * 3, connection_tests=()):
    """The columns read_site_db reads, as in storage/src/migrations.ts. `providers`: ok `extract` calls;
    `connection_tests`: ok `connection-test` calls (the settings screen's test, RUNBOOK step 3)."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE source_versions (id INTEGER PRIMARY KEY);
        CREATE TABLE insights (id INTEGER PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL, dropped_quotes INTEGER, dropped_other INTEGER);
        CREATE TABLE provider_calls (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, task_kind TEXT NOT NULL,
                                     outcome TEXT NOT NULL, created_at TEXT NOT NULL);
    """)
    db.executemany("INSERT INTO source_versions DEFAULT VALUES", [()] * versions)
    db.executemany("INSERT INTO insights (state) VALUES (?)", list(insights))
    db.executemany("INSERT INTO jobs (status, dropped_quotes, dropped_other) VALUES (?, ?, ?)", list(jobs))
    db.executemany("INSERT INTO provider_calls (provider, task_kind, outcome, created_at) VALUES (?, ?, 'ok', ?)",
                   [(p, "extract", created) for p in providers] + [(p, "connection-test", created) for p in connection_tests])
    db.commit()
    db.close()


class SiteVerifyRefuse(unittest.TestCase):
    """V02-H2 `site-verify.refuse`: each case prints exactly one notice starting with `배포처 후속` and exits non-zero."""

    def run_with(self, cfg, *extra):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "config.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh)
            return run_cli(*(extra or ("preflight",)), "--config", path)

    def test_case_1_test_double_provider_is_refused(self):
        res = self.run_with(config(kind="test-double", id="local-model", name="@pki/testkit FakeProvider"))
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.returncode, site.NOTICE_EXIT)
        lines = notice_lines(res)
        self.assertEqual(len(lines), 1, res.stdout + res.stderr)
        self.assertIn("test double", lines[0])

    def test_case_2_outside_a_windows_installer_is_refused(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        res = self.run_with(config())
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.returncode, site.NOTICE_EXIT)
        lines = notice_lines(res)
        self.assertEqual(len(lines), 1, res.stdout + res.stderr)
        self.assertIn("Windows 설치본", lines[0])
        self.assertIn("not-windows", lines[0])

    def test_a_double_id_claimed_as_real_is_still_case_1(self):
        lines = notice_lines(self.run_with(config(kind="real", id="local-model")))
        self.assertEqual(len(lines), 1)
        self.assertIn("test double", lines[0])

    def test_a_testkit_name_under_a_real_id_is_case_1(self):
        res = self.run_with(config(kind="real", id="codex", name="@pki/testkit FakeProvider", version="0.98.0"))
        self.assertEqual(res.returncode, site.NOTICE_EXIT)
        lines = notice_lines(res)
        self.assertEqual(len(lines), 1, res.stdout + res.stderr)
        self.assertIn("test double", lines[0])

    def test_prepare_and_record_go_through_the_same_gate(self):
        with tempfile.TemporaryDirectory() as out:
            for cmd in (("prepare", "--out", out), ("record", "--out", out)):
                res = self.run_with(config(kind="test-double", id="local-model"), *cmd)
                self.assertEqual(res.returncode, site.NOTICE_EXIT, cmd)
                self.assertEqual(len(notice_lines(res)), 1, cmd)
            self.assertEqual(os.listdir(out), [])

    def test_bad_config_is_an_error_not_a_notice(self):
        res = self.run_with({"provider": {"id": "openai-compatible"}})
        self.assertEqual(res.returncode, site.CONFIG_EXIT)
        self.assertEqual(notice_lines(res), [])


class InstallerCheck(unittest.TestCase):
    """Case ② logic with an injected platform and uninstall list (the CLI reads the real ones and has no override)."""
    EXE = "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe"

    def check(self, platform="win32", entries=None, exe=EXE, exists=True, in_git=False):
        entries = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI",
                    "DisplayVersion": "0.1.0"}] if entries is None else entries
        cfg = config()
        cfg["installedExe"] = exe
        return site.check_installer(cfg, platform=platform, read_uninstall=lambda: entries,
                                    is_file=lambda _p: exists, in_git_tree=lambda _p: in_git)

    def code(self, **kw):
        with self.assertRaises(site.Refusal) as ctx:
            self.check(**kw)
        self.assertTrue(ctx.exception.notice.startswith(NOTICE))
        return ctx.exception.code

    def test_installed_app_passes_with_its_version(self):
        self.assertEqual(self.check(), "0.1.0")

    def test_not_windows(self):
        self.assertEqual(self.code(platform="darwin"), "not-windows")

    def test_missing_exe(self):
        self.assertEqual(self.code(exists=False), "exe-missing")

    def test_build_output_is_not_an_installer(self):
        self.assertEqual(self.code(exe="C:\\src\\PKI\\apps\\desktop\\dist\\app\\PKI.exe"), "build-output")
        self.assertEqual(self.code(in_git=True), "build-output")

    def test_no_uninstall_entry(self):
        self.assertEqual(self.code(entries=[]), "not-installed")
        other = [{"DisplayName": "PKI", "InstallLocation": "C:\\Elsewhere", "DisplayVersion": "0.1.0"}]
        self.assertEqual(self.code(entries=other), "not-installed")
        prefix = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PK", "DisplayVersion": "0.1.0"}]
        self.assertEqual(self.code(entries=prefix), "not-installed")

    def test_another_products_entry_is_not_this_install(self):
        other = [{"DisplayName": "Other Product", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI",
                  "DisplayVersion": "0.1.0"}]
        self.assertEqual(self.code(entries=other), "not-installed")

    def test_exe_path_must_be_an_absolute_exe(self):
        self.assertEqual(self.code(exe="PKI\\PKI.exe"), "exe-missing")
        self.assertEqual(self.code(exe="C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.cmd"), "exe-missing")

    def test_bad_display_version(self):
        bad = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI", "DisplayVersion": "dev build"}]
        self.assertEqual(self.code(entries=bad), "app-version")


class GitTree(unittest.TestCase):
    """The real in_git_tree (case ② build-output): a `.git` folder, a worktree's `.git` file, and neither."""

    def test_git_folder_file_and_none(self):
        with tempfile.TemporaryDirectory() as d:
            for name, make in (("repo", os.mkdir), ("worktree", lambda p: open(p, "w").close())):
                root = os.path.join(d, name)
                os.makedirs(os.path.join(root, "apps", "x"))
                make(os.path.join(root, ".git"))
                self.assertTrue(site.in_git_tree(os.path.join(root, "apps", "x", "PKI.exe")), name)
            plain = os.path.join(d, "plain", "PKI")
            os.makedirs(plain)
            self.assertFalse(site.in_git_tree(os.path.join(plain, "PKI.exe")))


class RunRecord(unittest.TestCase):
    """V02-C4 `run-record`: a record without a Provider kind is rejected; a test double cannot be recorded as `real`."""

    def test_both_record_kinds_are_valid(self):
        self.assertEqual(rr.validate_record(e2e_record()), [])
        self.assertEqual(rr.validate_record(e2e_record(target="electron", electron="45.4.1")), [])
        self.assertEqual(rr.validate_record(site_record()), [])

    def test_missing_kind_is_rejected(self):
        rec = e2e_record()
        del rec["provider"]["kind"]
        self.assertTrue(rr.validate_record(rec))
        rec = e2e_record()
        del rec["provider"]
        self.assertTrue(rr.validate_record(rec))
        self.assertTrue(rr.validate_record(e2e_record(provider={"kind": "mock", "id": "local-model", "name": "x", "version": "y"})))

    def test_a_double_cannot_be_recorded_as_real(self):
        double_as_real = e2e_record()
        double_as_real["provider"] = dict(double_as_real["provider"], kind="real")
        self.assertTrue(rr.validate_record(double_as_real))  # E2E target, double id and testkit name
        on_site = site_record()
        on_site["provider"] = dict(on_site["provider"], id="local-model")
        self.assertTrue(rr.validate_record(on_site))
        named = site_record()
        named["provider"] = dict(named["provider"], name="@pki/testkit FakeProvider")
        self.assertTrue(rr.validate_record(named))
        self.assertTrue(rr.validate_record(site_record(target="electron")))

    def test_real_is_only_the_site_runners_on_the_installer(self):
        rec = e2e_record(target="electron", electron="45.4.1",
                         provider={"kind": "real", "id": "codex", "name": "codex", "version": "0.98.0"})
        self.assertEqual(rr.validate_record(rec), ["real is recorded only by the site runner on the Windows installer"])

    def test_a_testkit_version_cannot_be_real(self):
        rec = site_record()
        rec["provider"] = dict(rec["provider"], version="@pki/testkit 1.0.0")
        self.assertEqual(rr.validate_record(rec), ["a testkit Provider cannot be real"])

    def test_the_site_target_needs_a_real_provider(self):
        rec = site_record()
        rec["provider"] = dict(e2e_record()["provider"])
        problems = rr.validate_record(rec)  # each rule pinned by its own message (they overlap on this record)
        self.assertIn("the Windows installer record needs a real provider", problems)
        self.assertIn("a test double runs only in the E2E targets", problems)

    def test_r18_fields_are_required(self):
        for key in ("os", "appVersion", "commit", "finishedAt"):
            rec = site_record()
            del rec[key]
            self.assertTrue(rr.validate_record(rec), key)
        for key in ("name", "version"):
            rec = site_record()
            rec["provider"] = dict(rec["provider"], **{key: ""})
            self.assertTrue(rr.validate_record(rec), key)
        rec = site_record()
        del rec["counts"]["droppedQuotes"]
        self.assertTrue(rr.validate_record(rec))
        self.assertTrue(rr.validate_record(site_record(appVersion="source")))
        self.assertTrue(rr.validate_record(site_record(schema=2)))


class StaleRecords(unittest.TestCase):
    """Records older than the current run (or of another commit, or malformed) are counted and ignored."""

    def write(self, d, name, obj):
        with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
            fh.write(obj if isinstance(obj, str) else json.dumps(obj))

    def test_only_current_records_are_kept(self):
        with tempfile.TemporaryDirectory() as d:
            self.write(d, "run-record.browser.json", e2e_record())
            self.write(d, "run-record.electron.json", e2e_record(target="electron", startedAt="2026-11-21T22:00:00.000Z", finishedAt="2026-11-21T23:00:00.000Z"))
            self.write(d, "run-record.windows-installer.json", site_record(commit="f" * 40))
            self.write(d, "run-record.garbage.json", "{not json")
            self.write(d, "other.json", e2e_record())
            kept, ignored = rr.load_current_records(d, since="2026-11-22T00:00:00.000Z", commit=COMMIT)
        self.assertEqual(sorted(kept), ["browser"])
        self.assertEqual(ignored, {"stale": 1, "other-commit": 1, "invalid": 1})

    def test_without_a_commit_only_the_time_filters(self):
        with tempfile.TemporaryDirectory() as d:
            self.write(d, "run-record.windows-installer.json", site_record(commit="unknown"))
            kept, ignored = rr.load_current_records(d, since=STARTED)
        self.assertEqual(sorted(kept), ["windows-installer"])
        self.assertEqual(ignored, {})


class SummarizeCommit(unittest.TestCase):
    def test_head_resolves_to_the_full_sha(self):
        head = subprocess.run(["git", "-C", _paths.REPO_DIR, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        with tempfile.TemporaryDirectory() as d:
            for target, commit in (("browser", head), ("electron", "f" * 40)):
                with open(os.path.join(d, "run-record.{}.json".format(target)), "w", encoding="utf-8") as fh:
                    json.dump(e2e_record(target=target, commit=commit), fh)
            res = run_cli("summarize", "--records", d, "--since", STARTED, "--commit", "HEAD")
            bad = run_cli("summarize", "--records", d, "--since", STARTED, "--commit", "no-such-ref-xyz")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual([l.split()[0] for l in res.stdout.splitlines()[:-1]], ["browser"])
        self.assertIn('"other-commit": 1', res.stdout)
        self.assertEqual(bad.returncode, site.CONFIG_EXIT)

    def test_unknown_commit_pairs_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "run-record.browser.json"), "w", encoding="utf-8") as fh:
                json.dump(e2e_record(commit="unknown"), fh)
            res = run_cli("summarize", "--records", d, "--since", STARTED, "--commit", "unknown")
        self.assertEqual(res.returncode, site.CONFIG_EXIT)
        self.assertEqual(res.stdout, "")
        self.assertIn("미검증", res.stderr)


class SiteDatabase(unittest.TestCase):
    """`record` counts the canonical DB like `v02-flow.e2e` and derives the Provider kind from the calls it shows."""

    def counts(self, **db):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, **db)
            return site.read_site_db(path, config(), started_at=STARTED)

    def test_counts_match_the_e2e_queries(self):
        jobs = (("succeeded", 1, 0), ("succeeded", 0, 2), ("dead_letter", 0, 0))
        got = self.counts(jobs=jobs, insights=(("active",), ("resolved",)))
        self.assertEqual(got, {"sourceVersions": 3, "insights": 2, "activeInsights": 1, "jobsNotSucceeded": 1,
                               "providerCalls": 3, "droppedQuotes": 1, "droppedOther": 2})

    def test_calls_by_a_double_are_case_1(self):
        with self.assertRaises(site.Refusal) as ctx:
            self.counts(providers=("openai-compatible", "local-model"))
        self.assertIn("test double", ctx.exception.notice)

    def test_calls_by_another_provider_than_configured_are_case_1(self):
        with self.assertRaises(site.Refusal):
            self.counts(providers=("codex",) * 3)

    def test_connection_tests_neither_count_nor_refuse(self):
        got = self.counts(connection_tests=("openai-compatible", "codex"))
        self.assertEqual(got["providerCalls"], 3)

    def test_an_unreadable_call_time_is_stale(self):
        with self.assertRaises(site.StaleData):
            self.counts(created="yesterday")

    def test_rows_older_than_the_run_are_stale(self):
        with self.assertRaises(site.StaleData):
            self.counts(created="2026-11-21T00:00:00.000Z")

    def test_the_db_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            before = os.path.getmtime(path), os.path.getsize(path)
            site.read_site_db(path, config(), started_at=STARTED)
            self.assertEqual((os.path.getmtime(path), os.path.getsize(path)), before)
            self.assertEqual(sorted(os.listdir(d)), ["pki.sqlite"])

    def test_the_connection_cannot_write(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            db = site.open_ro(path)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    db.execute("INSERT INTO insights (state) VALUES ('active')")
            finally:
                db.close()

    def test_a_missing_db_is_not_created(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(sqlite3.Error):
                site.read_site_db(os.path.join(d, "pki.sqlite"), config(), started_at=STARTED)
            self.assertEqual(os.listdir(d), [])


class RecordLockedDb(unittest.TestCase):
    """`record` on a locked DB tells the operator to close the app (exit 1); gate and DB path are patched."""

    def test_lock_hint(self):
        def locked(*_a, **_k):
            raise sqlite3.OperationalError("database is locked")

        with tempfile.TemporaryDirectory() as d:
            cfg_path = os.path.join(d, "config.json")
            with open(cfg_path, "w", encoding="utf-8") as fh:
                json.dump(config(), fh)
            with open(os.path.join(d, "run-state.json"), "w", encoding="utf-8") as fh:
                json.dump({"startedAt": STARTED}, fh)
            saved = site.gate, site.site_db_path, site.read_site_db
            site.gate, site.site_db_path, site.read_site_db = (lambda _c: "0.1.0"), (lambda: os.path.join(d, "x")), locked
            err = io.StringIO()
            try:
                with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                    code = site.main(["record", "--config", cfg_path, "--out", d])
            finally:
                site.gate, site.site_db_path, site.read_site_db = saved
        self.assertEqual(code, 1)
        self.assertIn(site.DB_BUSY_HINT, err.getvalue())


class Judge(unittest.TestCase):
    def test_pass_needs_the_counts_and_all_observations(self):
        self.assertEqual(site.judge(COUNTS, ALL_OBSERVED), "PASS")
        self.assertEqual(site.judge(dict(COUNTS, providerCalls=4, droppedQuotes=2), ALL_OBSERVED), "PASS")
        self.assertEqual(site.judge(COUNTS, ALL_OBSERVED[:3]), "INCONCLUSIVE")
        self.assertEqual(site.judge(COUNTS, ALL_OBSERVED[1:]), "INCONCLUSIVE")  # launched-installed missing
        self.assertEqual(site.judge(dict(COUNTS, insights=2), ALL_OBSERVED), "FAIL")
        self.assertEqual(site.judge(dict(COUNTS, providerCalls=2), ALL_OBSERVED), "FAIL")
        self.assertEqual(site.judge(dict(COUNTS, jobsNotSucceeded=1), ALL_OBSERVED), "FAIL")


class SiteRecordForm(unittest.TestCase):
    """The record the runner builds passes the form; a record that does not is never written."""

    def test_the_runners_record_is_valid(self):
        for verdict in ("PASS", "FAIL"):
            self.assertEqual(rr.validate_record(site.build_site_record(config(), "0.1.0", dict(COUNTS), verdict, STARTED)), [])

    def test_an_invalid_record_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            with self.assertRaises(site.RecordInvalid):
                site.write_results(site_record(appVersion="source"), "PASS", ALL_OBSERVED, out, [])
            self.assertFalse(os.path.exists(out))


class PasteableResult(unittest.TestCase):
    """The pasteable pair holds allowlisted values only, like the R02~R04 kits; the run record stays under raw/."""

    def write(self, record, literals=()):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        site.write_results(record, "PASS", ALL_OBSERVED, d, list(literals))
        return d

    def test_result_is_schema_valid_and_keeps_the_r18_facts(self):
        d = self.write(site_record())
        with open(os.path.join(d, "result.json"), encoding="utf-8") as fh:
            obj = json.load(fh)
        self.assertEqual(results.validate_result(obj), [])
        self.assertEqual(obj["kit"], KIT)
        facts = obj["checks"][0]["facts"]
        self.assertEqual(obj["checks"][0]["id"], "V02-C4:site-flow")
        self.assertEqual(facts["provider_kind"], "real")
        self.assertEqual(facts["provider_id"], "openai-compatible")
        self.assertEqual(facts["model"], "gpt-5-mini")
        self.assertEqual(facts["app_version"], "0.1.0")
        self.assertEqual(facts["dropped_quotes"], 0)
        self.assertEqual(facts["kit_commit"], COMMIT[:12])
        self.assertEqual(sorted(os.listdir(d)), ["raw", "result.json", "result.md"])
        with open(os.path.join(d, "raw", "run-record.windows-installer.json"), encoding="utf-8") as fh:
            self.assertEqual(rr.validate_record(json.load(fh)), [])

    def test_operator_and_environment_text_cannot_reach_the_pasteable_files(self):
        rec = site_record(os="Windows WIN11-KIMMS kim.minsu ACMECORP")
        rec["provider"] = dict(rec["provider"], version="acmecorp-internal-llm-v3")
        d = self.write(rec)
        text = ""
        for name in ("result.json", "result.md"):
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                text += fh.read()
        for needle in ("acmecorp", "ACMECORP", "WIN11-KIMMS", "kim.minsu"):
            self.assertNotIn(needle, text)
        facts = read_json(os.path.join(d, "result.json"))["checks"][0]["facts"]
        self.assertRegex(facts["model"], r"^h:[0-9a-f]{12}$")

    def test_kit_commit_allows_only_a_12_hex_prefix_or_unknown(self):
        self.assertTrue(results.string_allowed(COMMIT[:12], "kit_commit"))
        self.assertTrue(results.string_allowed("unknown", "kit_commit"))
        for bad in (COMMIT, "acmecorp-kim", "0123456789AB", COMMIT[:11]):
            self.assertFalse(results.string_allowed(bad, "kit_commit"), bad)

    def test_a_cli_provider_version_is_kept_as_a_version(self):
        rec = site_record(provider={"kind": "real", "id": "codex", "name": "codex", "version": "0.98.0"})
        d = self.write(rec)
        facts = read_json(os.path.join(d, "result.json"))["checks"][0]["facts"]
        self.assertEqual(facts["provider_id"], "codex")
        self.assertEqual(facts["version"], "0.98.0")

    def test_fail_closed_when_a_redact_literal_remains(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        with self.assertRaises(site.RedactionError):
            site.write_results(site_record(), "PASS", ALL_OBSERVED, d, ["compatib"])  # sits inside an allowlisted word
        self.assertFalse(os.path.exists(os.path.join(d, "result.json")))


class Prepare(unittest.TestCase):
    def test_fixture_is_the_plain_golden_set(self):
        text = site.fixture_text()
        with open(os.path.join(_paths.REPO_DIR, "fixtures", "v02-expected.json"), encoding="utf-8") as fh:
            files = json.load(fh)["sets"]["plain"]["files"]
        parts = []
        for name in files:
            with open(os.path.join(_paths.REPO_DIR, "fixtures", name), encoding="utf-8") as fh:
                parts.append(fh.read().strip())
        self.assertEqual(text, "\n".join(parts))
        self.assertEqual(len(text.splitlines()), 3)

    def test_an_existing_db_refuses_prepare(self):
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "pki.sqlite")
            open(db, "w").close()
            with self.assertRaises(site.StaleData):
                site.prepare(db, os.path.join(d, "out"))
            self.assertFalse(os.path.exists(os.path.join(d, "out")))

    def test_prepare_writes_the_fixture_and_the_start_time(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            site.prepare(os.path.join(d, "pki.sqlite"), out)
            self.assertEqual(sorted(os.listdir(out)), ["run-state.json", "v02-plain.jsonl"])
            with open(os.path.join(out, "run-state.json"), encoding="utf-8") as fh:
                self.assertRegex(json.load(fh)["startedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


if __name__ == "__main__":
    unittest.main()
