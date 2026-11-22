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


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def config(**over):
    cfg = {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe",
           "collector": {"kind": "site-mail"}, "userDataDir": "C:\\Users\\u\\AppData\\Roaming\\pki-desktop"}
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

    def test_the_electron_user_data_folder_is_mandatory(self):
        """Chromium storage lives outside the data folder (roaming %APPDATA%), so the scan must be told where."""
        cfg = config()
        del cfg["userDataDir"]
        with self.assertRaises(site.ConfigError):
            ds.validate_config(cfg)
        for bad in ("", "relative\\dir", 3):
            with self.assertRaises(site.ConfigError, msg=repr(bad)):
                ds.validate_config(config(userDataDir=bad))

    def test_extra_scan_dirs_with_a_variable_are_expanded_before_the_absolute_check(self):
        old = os.environ.get("PKI_TEST_ENGINE_ROOT")
        os.environ["PKI_TEST_ENGINE_ROOT"] = "D:\\engine"
        try:
            ds.validate_config(config(extraScanDirs=["%PKI_TEST_ENGINE_ROOT%\\idx"]))
            self.assertEqual(ds.scan_dirs(config(extraScanDirs=["%PKI_TEST_ENGINE_ROOT%\\idx"]), "C:\\d\\pki.sqlite")[-1], "D:\\engine\\idx")
            with self.assertRaises(site.ConfigError):  # a variable that expands to a relative path is still refused
                os.environ["PKI_TEST_ENGINE_ROOT"] = "engine"
                ds.validate_config(config(extraScanDirs=["%PKI_TEST_ENGINE_ROOT%\\idx"]))
        finally:
            if old is None:
                os.environ.pop("PKI_TEST_ENGINE_ROOT", None)
            else:
                os.environ["PKI_TEST_ENGINE_ROOT"] = old

    def test_extra_scan_dirs_must_be_absolute_windows_paths(self):
        for bad in (["relative\\dir"], "D:\\engine", [3]):
            with self.assertRaises(site.ConfigError, msg=repr(bad)):
                ds.validate_config(config(extraScanDirs=bad))


class ScanDirs(unittest.TestCase):
    def test_the_user_data_folder_is_scanned_besides_the_data_folder_and_the_extras(self):
        cfg = config(extraScanDirs=["D:\\engine"])
        dirs = ds.scan_dirs(cfg, "C:\\Users\\u\\AppData\\Local\\PKI\\pki.sqlite")
        self.assertEqual(dirs, ["C:\\Users\\u\\AppData\\Local\\PKI", "C:\\Users\\u\\AppData\\Roaming\\pki-desktop", "D:\\engine"])


class CanaryScan(unittest.TestCase):
    """The scan reads every byte under the folder, like @pki/testkit findCanaries (raw, lowercased, UTF-16LE)."""

    def scan(self, files, canaries=CANARIES):
        with tempfile.TemporaryDirectory() as d:
            for rel, data in files.items():
                path = os.path.join(d, *rel.split("/"))
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "wb") as fh:
                    fh.write(data)
            return ds.scan_canaries([d], canaries)[0]

    def test_nothing_found_in_a_clean_folder(self):
        found = self.scan({"pki.sqlite": b"nothing here", "logs/app.log": b"x"})
        self.assertEqual(found, {"deleted": 0, "revoked": 0, "kept": 0})

    def test_each_canary_is_counted_by_its_own_name(self):
        found = self.scan({"pki.sqlite": b"..." + CANARIES["revoked"].encode() + b"..."})
        self.assertEqual(found, {"deleted": 0, "revoked": 1, "kept": 0})

    def test_every_file_kind_is_read_including_journal_and_nested(self):
        for rel in ("pki.sqlite-wal", "pki.sqlite-journal", "pki.sqlite-shm", "keyword.idx", "a/b/c/d.bin"):
            found = self.scan({rel: CANARIES["deleted"].encode()})
            self.assertEqual(found["deleted"], 1, rel)

    def test_case_and_utf16_forms_are_found(self):
        word = CANARIES["deleted"]
        forms = {
            "as written": word.encode(),
            "capitalised": word.capitalize().encode(),
            "upper": word.upper().encode(),
            "utf-16le": word.encode("utf-16-le"),
            "utf-16be": word.encode("utf-16-be"),
            "utf-16le upper": word.upper().encode("utf-16-le"),
        }
        for name, data in forms.items():
            self.assertEqual(self.scan({"i": b"x" + data + b"y"})["deleted"], 1, name)

    def test_only_the_tail_of_the_word_is_stored_when_a_neighbour_shares_a_prefix(self):
        """FTS5 prefix compression: the file holds a suffix of the term, never the whole word."""
        tail = CANARIES["deleted"][-ds.TAIL_LEN:]
        self.assertNotIn(CANARIES["deleted"], tail)
        self.assertEqual(self.scan({"i": b"..." + tail.encode() + b"..."})["deleted"], 1)
        shorter = CANARIES["deleted"][-(ds.TAIL_LEN - 1):]
        self.assertEqual(self.scan({"i": shorter.encode()})["deleted"], 0)  # the tail is the unit searched

    def test_a_canary_split_across_the_read_chunks_is_still_found(self):
        pad = b"x" * (ds.CHUNK - 5)
        found = self.scan({"big.bin": pad + CANARIES["deleted"].encode() + b"y" * 100})
        self.assertEqual(found["deleted"], 1)

    def test_a_second_folder_is_scanned_too(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            with open(os.path.join(b, "engine.idx"), "wb") as fh:
                fh.write(CANARIES["revoked"].encode())
            found, _unreadable = ds.scan_canaries([a, b], CANARIES)
        self.assertEqual(found["revoked"], 1)

    @unittest.skipIf(sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0), "needs POSIX permissions and a non-root user")
    def test_an_unreadable_folder_or_file_is_counted_not_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            locked = os.path.join(d, "locked")
            os.makedirs(locked)
            with open(os.path.join(locked, "x.db"), "wb") as fh:
                fh.write(CANARIES["deleted"].encode())
            with open(os.path.join(d, "kept.db"), "wb") as fh:
                fh.write(CANARIES["kept"].encode())
            with open(os.path.join(d, "secret.db"), "wb") as fh:
                fh.write(b"x")
            os.chmod(locked, 0)
            os.chmod(os.path.join(d, "secret.db"), 0)
            try:
                found, unreadable = ds.scan_canaries([d], CANARIES)
            finally:
                os.chmod(locked, 0o700)
            self.assertEqual(found, {"deleted": 0, "revoked": 0, "kept": 1})  # the locked folder hid the canary
            self.assertEqual(unreadable, 2)  # the folder and the file, counted

    @unittest.skipIf(sys.platform == "win32", "needs POSIX symlinks")
    def test_a_dangling_symlink_is_counted_unreadable_so_the_verdict_cannot_pass(self):
        with tempfile.TemporaryDirectory() as d:
            os.symlink(os.path.join(d, "no-such-target"), os.path.join(d, "dangling"))
            with open(os.path.join(d, "kept.db"), "wb") as fh:
                fh.write(CANARIES["kept"].encode())
            found, unreadable = ds.scan_canaries([d], CANARIES)
        self.assertEqual((found["kept"], unreadable), (1, 1))
        self.assertEqual(verdict(found=found, unreadable=unreadable), "INCONCLUSIVE")

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
        self.assertEqual(got, {"source-deleted": 1, "access-revoked": 2, "user-deleted": 1})

    def test_missing_kinds_count_zero(self):
        self.assertEqual(self.counts(()), {"source-deleted": 0, "access-revoked": 0, "user-deleted": 0})

    def test_the_database_is_opened_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            before = os.path.getmtime(path)
            ds.read_delete_counts(path)
            self.assertEqual(os.path.getmtime(path), before)
            self.assertEqual(sorted(os.listdir(d)), ["pki.sqlite"])


GOOD_COUNTS = {"source-deleted": 1, "access-revoked": 1, "user-deleted": 0}
NONE_FOUND = {"deleted": 0, "revoked": 0, "kept": 1}
CLEAN_INDEX = {"deleted": 0, "revoked": 0, "kept": 1}


def verdict(counts=GOOD_COUNTS, found=NONE_FOUND, observed=ALL_OBSERVED, index=CLEAN_INDEX, unreadable=0):
    return ds.judge(counts, found, observed, index, unreadable)


class Judge(unittest.TestCase):
    def test_pass_needs_every_part(self):
        self.assertEqual(verdict(), "PASS")

    def test_a_remaining_deleted_canary_fails_either_one(self):
        for key in ("deleted", "revoked"):
            self.assertEqual(verdict(found=dict(NONE_FOUND, **{key: 1})), "FAIL", key)

    def test_a_deleted_canary_left_in_the_keyword_index_fails_either_one(self):
        for key in ("deleted", "revoked"):
            self.assertEqual(verdict(index=dict(CLEAN_INDEX, **{key: 1})), "FAIL", key)

    def test_wrong_event_counts_fail_including_a_user_deletion(self):
        for counts in ({"source-deleted": 0, "access-revoked": 1, "user-deleted": 0},
                       {"source-deleted": 1, "access-revoked": 0, "user-deleted": 0},
                       {"source-deleted": 2, "access-revoked": 1, "user-deleted": 0},
                       {"source-deleted": 1, "access-revoked": 2, "user-deleted": 0},
                       {"source-deleted": 1, "access-revoked": 1, "user-deleted": 1}):
            self.assertEqual(verdict(counts=counts), "FAIL", counts)

    def test_a_scan_that_cannot_see_the_kept_canary_proves_nothing(self):
        self.assertEqual(verdict(found=dict(NONE_FOUND, kept=0)), "INCONCLUSIVE")

    def test_the_control_must_also_be_in_the_keyword_index(self):
        """The kept canary is in the content table too, so only the index shows the index was searched."""
        self.assertEqual(verdict(index=dict(CLEAN_INDEX, kept=0)), "INCONCLUSIVE")

    def test_an_unreadable_path_is_inconclusive(self):
        self.assertEqual(verdict(unreadable=1), "INCONCLUSIVE")

    def test_a_missing_observation_is_inconclusive_for_each_word(self):
        for word in ALL_OBSERVED:
            self.assertEqual(verdict(observed=[w for w in ALL_OBSERVED if w != word]), "INCONCLUSIVE", word)

    def test_fail_outranks_inconclusive(self):
        self.assertEqual(verdict(found=dict(NONE_FOUND, deleted=1, kept=0), observed=[], unreadable=3), "FAIL")


class PrepareState(unittest.TestCase):
    def test_canaries_are_distinct_letters_without_a_shared_prefix(self):
        for _ in range(50):
            c = ds.new_canaries()
            self.assertEqual(sorted(c), ["deleted", "kept", "revoked"])
            values = list(c.values())
            self.assertEqual(len({v[0] for v in values}), 3)  # no shared first letter, so no shared prefix
            for v in values:
                self.assertTrue(v.isalpha() and v.islower() and len(v) == ds.CANARY_LEN, v)

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
                                 ALL_OBSERVED, STARTED, CLEAN_INDEX, 0)
        return record, ds.write_results(record, verdict, ALL_OBSERVED, out, [])

    def test_the_record_holds_the_r19_fields(self):
        with tempfile.TemporaryDirectory() as out:
            record, _ = self.write(out=out)
            for key in ("os", "appVersion", "collectorKind", "deletedByKind", "canariesFound", "indexCanariesFound",
                        "unreadablePaths"):
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

    def test_the_runbook_lists_exactly_the_facts_the_runner_writes(self):
        """RUNBOOK 8 "붙이는 것" names the pasteable fields; they must equal the facts write_results produces."""
        import re
        runbook = read(os.path.join(_paths.VERIF_DIR, KIT, "RUNBOOK.md"))
        paragraph = runbook.split("**붙이는 것.**", 1)[1].split("\n\n", 1)[0].split("`raw", 1)[0]  # the allowlist sentence, not the never-paste list
        listed = set(re.findall(r"`([a-z]+(?:_[a-z]+)*)`", paragraph))
        with tempfile.TemporaryDirectory() as out:
            _, (json_path, _md) = self.write(out=out)
            written = set(json.loads(read(json_path))["checks"][0]["facts"])
        self.assertEqual(listed, written)

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
                record = ds.build_record(config(collector={"kind": kind}), "0.1.0", GOOD_COUNTS, NONE_FOUND, "PASS", ALL_OBSERVED,
                                         STARTED, CLEAN_INDEX, 0)
                _, md = ds.write_results(record, "PASS", ALL_OBSERVED, out, [])
                self.assertIn(kind, read(md))


PRODUCT_FTS = """
    CREATE TABLE source_versions (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);
    CREATE VIRTUAL TABLE keyword_index USING fts5 (title, body, content = 'source_versions', content_rowid = 'id');
    INSERT INTO keyword_index (keyword_index, rank) VALUES ('secure-delete', 1);
    CREATE TRIGGER source_versions_index AFTER INSERT ON source_versions BEGIN
      INSERT INTO keyword_index (rowid, title, body) VALUES (new.id, new.title, new.body);
    END;
    CREATE TRIGGER source_versions_unindex AFTER DELETE ON source_versions BEGIN
      INSERT INTO keyword_index (keyword_index, rowid, title, body) VALUES ('delete', old.id, old.title, old.body);
    END;
"""  # the product's keyword index: storage/src/migrations.ts v1 and v9 (secure-delete)


def make_fts_db(path, bodies):
    """The product's keyword_index definition in a real SQLite file, holding `bodies` (one source version each)."""
    db = sqlite3.connect(path)
    db.executescript("PRAGMA secure_delete = ON;" + PRODUCT_FTS)
    db.executemany("INSERT INTO source_versions (title, body) VALUES ('t', ?)", [(b,) for b in bodies])
    db.commit()
    return db


class FtsIndex(unittest.TestCase):
    """F1: against a real FTS5 table, a deleted term that stays in the index is found although the file does not hold the
    whole word (the term before it shares a prefix, so FTS stores a suffix)."""

    WORD = CANARIES["deleted"]
    BODIES = ["meeting qlab notes " + CANARIES["deleted"], "later zbtn notes " + CANARIES["kept"]]

    def build(self, d):
        path = os.path.join(d, "pki.sqlite")
        db = make_fts_db(path, self.BODIES)
        return path, db

    def test_the_file_holds_only_a_suffix_of_a_prefix_sharing_term_and_the_scan_still_finds_it(self):
        with tempfile.TemporaryDirectory() as d:
            path, db = self.build(d)
            # a deletion that reached the content table but not the index (the residue case), then VACUUM so
            # the content row's bytes are gone and only the index can hold the word
            db.execute("DROP TRIGGER source_versions_unindex")
            db.execute("DELETE FROM source_versions WHERE id = 1")
            db.commit()
            db.execute("VACUUM")
            db.close()
            data = read_bytes(path)
            self.assertNotIn(self.WORD.encode(), data)  # the whole word is NOT in the file: the F1 blind spot
            self.assertIn(self.WORD[-ds.TAIL_LEN:].encode(), data)  # its tail is
            found, unreadable = ds.scan_canaries([d], CANARIES)
            self.assertEqual((found["deleted"], unreadable), (1, 0))
            self.assertEqual(ds.read_index_terms(path, CANARIES)["deleted"], 1)
            self.assertEqual(verdict(found=found, index=ds.read_index_terms(path, CANARIES)), "FAIL")

    def test_index_terms_reads_the_vocabulary_read_only(self):
        with tempfile.TemporaryDirectory() as d:
            path, db = self.build(d)
            db.close()
            before = os.path.getmtime(path)
            terms = ds.read_index_terms(path, CANARIES)
            self.assertEqual(terms, {"deleted": 1, "revoked": 0, "kept": 1})
            self.assertEqual(os.path.getmtime(path), before)
            self.assertEqual(sorted(os.listdir(d)), ["pki.sqlite"])

    def test_after_the_product_deletes_the_row_the_term_is_gone_from_both_checks(self):
        with tempfile.TemporaryDirectory() as d:
            path, db = self.build(d)
            db.execute("DELETE FROM source_versions WHERE id = 1")
            db.commit()
            db.close()
            self.assertEqual(ds.read_index_terms(path, CANARIES), {"deleted": 0, "revoked": 0, "kept": 1})
            found, unreadable = ds.scan_canaries([d], CANARIES)
            self.assertEqual(found, {"deleted": 0, "revoked": 0, "kept": 1})
            self.assertEqual(verdict(found=found, index=ds.read_index_terms(path, CANARIES), unreadable=unreadable), "PASS")

    def test_a_deleted_term_still_in_the_index_makes_the_verdict_fail(self):
        with tempfile.TemporaryDirectory() as d:
            path, db = self.build(d)
            db.close()
            found, unreadable = ds.scan_canaries([d], CANARIES)
            index = ds.read_index_terms(path, CANARIES)
            self.assertEqual(verdict(found=found, index=index, unreadable=unreadable), "FAIL")


if __name__ == "__main__":
    unittest.main()

