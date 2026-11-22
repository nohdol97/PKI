"""I04-T11 (I04-R19, I04-H2 ②) `site-paths.refuse` ②: the deletion scenario of the V02 site runner refuses outside the
Windows installer, and its judge and canary scan are checked on synthetic data. Nothing here is site evidence: the Windows
branch was never run."""
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
site = _paths.load_kit_module(KIT, "run.py", "i04_site_run")
ds = site.delete_scenario  # the module run.py imported: one set of exception classes

NOTICE = "배포처 후속"
STARTED = "2026-11-22T01:00:00.000Z"
CANARIES = {"deleted": "qlxhvmtrawbkcn", "revoked": "wgdzpyfjsuoeai", "kept": "zbtnkqrhvlxmcd"}
ALL_OBSERVED = list(ds.OBSERVATIONS)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def config(**over):
    cfg = {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe",
           "collector": {"kind": "site-mail"}}
    cfg.update(over)
    return cfg


def make_db(path, kinds=("source-deleted", "access-revoked")):
    """The column read_delete_counts reads (storage/src/migrations.ts v10), as rows of invalidations."""
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE invalidations (id INTEGER PRIMARY KEY, change_kind TEXT NOT NULL)")
    db.executemany("INSERT INTO invalidations (change_kind) VALUES (?)", [(k,) for k in kinds])
    db.commit()
    db.close()


class DeleteScenarioRefuse(unittest.TestCase):
    """I04-H2 ② `site-paths.refuse` ②: one notice starting with `배포처 후속` on stdout, a non-zero exit."""

    def run_with(self, cfg, action="preflight", *extra):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "config.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh)
            return run_cli("delete-scenario", action, "--config", path, *extra)

    def notice_lines(self, res):
        self.assertEqual([l for l in res.stderr.splitlines() if NOTICE in l], [], res.stderr)
        return [l for l in res.stdout.splitlines() if l.startswith(NOTICE)]

    def test_outside_a_windows_installer_is_refused_with_one_notice(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        res = self.run_with(config())
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.returncode, site.NOTICE_EXIT)
        lines = self.notice_lines(res)
        self.assertEqual(len(lines), 1, res.stdout + res.stderr)
        self.assertIn("S22", lines[0])
        self.assertIn("not-windows", lines[0])

    def test_every_action_goes_through_the_same_refusal(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as out:
            for action in ("prepare", "record"):
                res = self.run_with(config(), action, "--out", out)
                self.assertEqual(res.returncode, site.NOTICE_EXIT, action)
                self.assertEqual(len(self.notice_lines(res)), 1, action)
            self.assertEqual(os.listdir(out), [])  # a refusal writes nothing

    def test_the_refusal_comes_before_the_config_is_read(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        res = run_cli("delete-scenario", "preflight", "--config", os.path.join(tempfile.gettempdir(), "no-such-config.json"))
        self.assertEqual(res.returncode, site.NOTICE_EXIT, res.stdout + res.stderr)
        self.assertEqual(len(self.notice_lines(res)), 1)

    def test_on_windows_the_installer_check_is_the_v02_one(self):
        entries = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI", "DisplayVersion": "0.1.0"}]
        self.assertEqual(site.delete_gate(config(), platform="win32", read_uninstall=lambda: entries, is_file=lambda _p: True,
                                 in_git_tree=lambda _p: False), "0.1.0")
        with self.assertRaises(site.Refusal) as ctx:
            site.delete_gate(config(), platform="win32", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertTrue(ctx.exception.notice.startswith(NOTICE))
        self.assertIn("S22", ctx.exception.notice)
        self.assertEqual(ctx.exception.code, "not-installed")

    def test_a_non_windows_platform_is_refused_by_the_gate_itself(self):
        with self.assertRaises(site.Refusal) as ctx:
            site.delete_gate(config(), platform="darwin", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertEqual(ctx.exception.code, "not-windows")


class DeleteConfig(unittest.TestCase):
    def test_a_valid_config(self):
        cfg = ds.validate_config(config(extraScanDirs=["D:\\engine"]))
        self.assertEqual(cfg["collector"]["kind"], "site-mail")

    def test_collector_kind_is_one_of_the_three(self):
        for bad in ("real", "site-chat", "", None):
            with self.assertRaises(site.ConfigError, msg=repr(bad)):
                ds.validate_config(config(collector={"kind": bad}))
        with self.assertRaises(site.ConfigError):
            ds.validate_config({"productName": "PKI", "installedExe": "C:\\x.exe"})

    def test_extra_scan_dirs_must_be_absolute_windows_paths(self):
        for bad in (["relative\\dir"], "D:\\engine", [3]):
            with self.assertRaises(site.ConfigError, msg=repr(bad)):
                ds.validate_config(config(extraScanDirs=bad))


class CanaryScan(unittest.TestCase):
    """The scan reads every byte under the folder, like @pki/testkit findCanaries (raw, lowercased, UTF-16LE)."""

    def scan(self, files, canaries=CANARIES):
        with tempfile.TemporaryDirectory() as d:
            for rel, data in files.items():
                path = os.path.join(d, *rel.split("/"))
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(data)
            return ds.scan_canaries([d], canaries)

    def test_nothing_found_in_a_clean_folder(self):
        found = self.scan({"pki.sqlite": b"nothing here", "logs/app.log": b"x"})
        self.assertEqual(found, {"deleted": 0, "revoked": 0, "kept": 0})

    def test_each_canary_is_counted_by_its_own_name(self):
        found = self.scan({"pki.sqlite": b"..." + CANARIES["revoked"].encode() + b"..."})
        self.assertEqual(found, {"deleted": 0, "revoked": 1, "kept": 0})

    def test_every_file_kind_is_read_including_journal_and_nested(self):
        for rel in ("pki.sqlite-wal", "pki.sqlite-journal", "pki.sqlite-shm", "Local Storage/leveldb/000003.log", "a/b/c/d.bin"):
            found = self.scan({rel: CANARIES["deleted"].encode()})
            self.assertEqual(found["deleted"], 1, rel)

    def test_the_lowercased_and_the_utf16_forms_are_found(self):
        upper = {k: v.upper() for k, v in CANARIES.items()}
        self.assertEqual(self.scan({"i": CANARIES["deleted"].upper().encode()}, upper)["deleted"], 1)  # as written
        self.assertEqual(self.scan({"i": upper["deleted"].lower().encode()}, upper)["deleted"], 1)  # lowercased by an index
        self.assertEqual(self.scan({"i": CANARIES["deleted"].encode("utf-16-le")})["deleted"], 1)

    def test_a_canary_split_across_the_read_chunks_is_still_found(self):
        pad = b"x" * (ds.CHUNK - 5)
        found = self.scan({"big.bin": pad + CANARIES["deleted"].encode() + b"y" * 100})
        self.assertEqual(found["deleted"], 1)

    def test_a_second_folder_is_scanned_too(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            with open(os.path.join(b, "engine.idx"), "wb") as fh:
                fh.write(CANARIES["revoked"].encode())
            found = ds.scan_canaries([a, b], CANARIES)
        self.assertEqual(found["revoked"], 1)

    def test_a_missing_folder_is_an_error_not_a_clean_result(self):
        with self.assertRaises(site.ConfigError):
            ds.scan_canaries([os.path.join(tempfile.gettempdir(), "no-such-data-folder-xyz")], CANARIES)


class Counts(unittest.TestCase):
    def counts(self, kinds):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path, kinds)
            return ds.read_delete_counts(path)

    def test_counts_by_kind_and_ignores_other_kinds(self):
        got = self.counts(("source-deleted", "access-revoked", "access-revoked", "new-version", "user-deleted"))
        self.assertEqual(got, {"source-deleted": 1, "access-revoked": 2})

    def test_missing_kinds_count_zero(self):
        self.assertEqual(self.counts(()), {"source-deleted": 0, "access-revoked": 0})

    def test_the_database_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            before = os.path.getmtime(path)
            ds.read_delete_counts(path)
            self.assertEqual(os.path.getmtime(path), before)
            self.assertEqual(sorted(os.listdir(d)), ["pki.sqlite"])


GOOD_COUNTS = {"source-deleted": 1, "access-revoked": 1}
NONE_FOUND = {"deleted": 0, "revoked": 0, "kept": 1}


class Judge(unittest.TestCase):
    def test_pass_needs_every_part(self):
        self.assertEqual(ds.judge(GOOD_COUNTS, NONE_FOUND, ALL_OBSERVED), "PASS")

    def test_a_remaining_deleted_canary_fails_either_one(self):
        for key in ("deleted", "revoked"):
            self.assertEqual(ds.judge(GOOD_COUNTS, dict(NONE_FOUND, **{key: 1}), ALL_OBSERVED), "FAIL", key)

    def test_wrong_event_counts_fail(self):
        for counts in ({"source-deleted": 0, "access-revoked": 1}, {"source-deleted": 1, "access-revoked": 0},
                       {"source-deleted": 2, "access-revoked": 1}, {"source-deleted": 1, "access-revoked": 2}):
            self.assertEqual(ds.judge(counts, NONE_FOUND, ALL_OBSERVED), "FAIL", counts)

    def test_a_scan_that_cannot_see_the_kept_canary_proves_nothing(self):
        self.assertEqual(ds.judge(GOOD_COUNTS, dict(NONE_FOUND, kept=0), ALL_OBSERVED), "INCONCLUSIVE")

    def test_a_missing_observation_is_inconclusive_for_each_word(self):
        for word in ALL_OBSERVED:
            self.assertEqual(ds.judge(GOOD_COUNTS, NONE_FOUND, [w for w in ALL_OBSERVED if w != word]), "INCONCLUSIVE", word)

    def test_fail_outranks_inconclusive(self):
        self.assertEqual(ds.judge(GOOD_COUNTS, dict(NONE_FOUND, deleted=1, kept=0), []), "FAIL")


class PrepareState(unittest.TestCase):
    def test_canaries_are_distinct_letters_without_a_shared_prefix(self):
        for _ in range(50):
            c = ds.new_canaries()
            self.assertEqual(sorted(c), ["deleted", "kept", "revoked"])
            values = list(c.values())
            self.assertEqual(len({v[0] for v in values}), 3)  # no shared first letter, so no shared prefix
            for v in values:
                self.assertTrue(v.isalpha() and v.islower() and len(v) >= 12, v)

    def test_prepare_refuses_an_existing_database_and_writes_state(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out:
            db_path = os.path.join(d, "pki.sqlite")
            ds.prepare(db_path, out)
            state = json.loads(read(os.path.join(out, ds.STATE_FILE)))
            self.assertEqual(sorted(state["canaries"]), ["deleted", "kept", "revoked"])
            make_db(db_path)
            with self.assertRaises(site.StaleData):
                ds.prepare(db_path, out)


class RecordWriting(unittest.TestCase):
    def write(self, verdict="PASS", counts=None, found=None, out=None):
        record = ds.build_record(config(), "0.1.0", counts or GOOD_COUNTS, found or NONE_FOUND, verdict,
                                 ALL_OBSERVED, STARTED)
        return record, ds.write_results(record, verdict, ALL_OBSERVED, out, [])

    def test_the_record_holds_the_r19_fields(self):
        with tempfile.TemporaryDirectory() as out:
            record, _ = self.write(out=out)
            for key in ("os", "appVersion", "collectorKind", "deletedByKind", "canariesFound"):
                self.assertIn(key, record)
            self.assertEqual(record["collectorKind"], "site-mail")
            self.assertEqual(record["deletedByKind"], GOOD_COUNTS)
            self.assertEqual(record["canariesFound"], 0)
            self.assertEqual(record["appVersion"], "0.1.0")

    def test_the_pasteable_result_validates_and_says_which_check(self):
        with tempfile.TemporaryDirectory() as out:
            _, (json_path, md_path) = self.write(out=out)
            obj = json.loads(read(json_path))
            self.assertEqual(results.validate_result(obj), [])
            check = obj["checks"][0]
            self.assertEqual(check["id"], "I04-C3:delete-scenario")
            self.assertEqual(check["verdict"], "PASS")
            facts = check["facts"]
            self.assertEqual((facts["collector_kind"], facts["deleted_source_deleted"], facts["deleted_access_revoked"],
                              facts["canaries_found"], facts["control_canary_found"]), ("site-mail", 1, 1, 0, True))
            self.assertIn("unit_tests_not_site_evidence", obj["notes"])
            self.assertTrue(os.path.exists(os.path.join(out, "raw", "run-record.delete-scenario.json")))
            text = read(md_path)
            for secret in CANARIES.values():
                self.assertNotIn(secret, text)

    def test_a_failed_run_is_recorded_as_failed_with_the_count(self):
        with tempfile.TemporaryDirectory() as out:
            record, (json_path, _) = self.write(verdict="FAIL", found={"deleted": 1, "revoked": 1, "kept": 1}, out=out)
            self.assertEqual(record["canariesFound"], 2)
            obj = json.loads(read(json_path))
            self.assertEqual(obj["checks"][0]["verdict"], "FAIL")
            self.assertEqual(obj["checks"][0]["facts"]["canaries_found"], 2)

    def test_the_collector_kind_is_an_allowlisted_word(self):
        for kind in ("site-mail", "site-messenger", "site-wiki"):
            with tempfile.TemporaryDirectory() as out:
                record = ds.build_record(config(collector={"kind": kind}), "0.1.0", GOOD_COUNTS, NONE_FOUND, "PASS", ALL_OBSERVED, STARTED)
                _, md = ds.write_results(record, "PASS", ALL_OBSERVED, out, [])
                self.assertIn(kind, read(md))


if __name__ == "__main__":
    unittest.main()
