"""S01-T10 (S01-R25, S01-H2) `site-paths.refuse` (Semantic): the Semantic scenario of the V02 site runner (S32) refuses
outside a Windows installed build with a real Provider, with one notice starting with `배포처 후속` on stdout and a
non-zero exit. Its counts are checked on a synthetic SQLite built with the column names of storage/src/migrations.ts
v20 (never a database the product wrote). Nothing here is site evidence: the Windows branch and `record` were never
run on Windows."""
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

KIT = "v02-site-flow"
site = _paths.load_kit_module(KIT, "run.py", "s01_site_run")
ss = site.semantic_scenario  # the module run.py imported: one set of exception classes

NOTICE = "배포처 후속"
STATUSES = ("candidate", "verified", "disputed", "rejected", "superseded")


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def config(**provider):
    p = {"kind": "real", "id": "openai-compatible", "name": "openai-compatible", "version": "gpt-5-mini"}
    p.update(provider)
    return {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe", "provider": p}


class SemanticScenarioRefuse(unittest.TestCase):
    """S01-H2 `site-paths.refuse` (Semantic): one notice starting with `배포처 후속` on stdout, a non-zero exit."""

    def run_with(self, cfg, action="preflight", *extra):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "config.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh)
            return run_cli("semantic-scenario", action, "--config", path, *extra)

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
        self.assertIn("S32", lines[0])
        self.assertIn("S01-H2", lines[0])
        self.assertIn("not-windows", lines[0])

    def test_every_action_goes_through_the_same_refusal_and_writes_nothing(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as out:
            res = self.run_with(config(), "preflight", "--out", out)
            self.assertEqual(res.returncode, site.NOTICE_EXIT)
            for phase in ("off", "on"):
                res = self.run_with(config(), "record", "--out", out, "--phase", phase)
                self.assertEqual(res.returncode, site.NOTICE_EXIT, phase)
                self.assertEqual(len(self.notice_lines(res)), 1, phase)
            self.assertEqual(os.listdir(out), [])  # a refusal writes nothing

    def test_the_refusal_comes_before_the_config_is_read(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        res = run_cli("semantic-scenario", "preflight", "--config", os.path.join(tempfile.gettempdir(), "no-such-config.json"))
        self.assertEqual(res.returncode, site.NOTICE_EXIT, res.stdout + res.stderr)
        self.assertEqual(len(self.notice_lines(res)), 1)

    def test_on_windows_a_test_double_provider_is_refused_with_the_s32_notice(self):
        for double in ({"kind": "test-double"}, {"id": "test-double"}, {"name": "openai-compatible @pki/testkit"}):
            with self.assertRaises(site.Refusal, msg=repr(double)) as ctx:
                site.semantic_gate(config(**double), platform="win32", read_uninstall=lambda: [],
                                   is_file=lambda _p: True, in_git_tree=lambda _p: False)
            self.assertTrue(ctx.exception.notice.startswith(NOTICE))
            self.assertIn("S32", ctx.exception.notice)
            self.assertEqual(ctx.exception.code, "test-double")

    def test_on_windows_the_installer_check_is_the_v02_one_with_the_s32_notice(self):
        entries = [{"DisplayName": "PKI", "InstallLocation": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI", "DisplayVersion": "0.1.0"}]
        self.assertEqual(site.semantic_gate(config(), platform="win32", read_uninstall=lambda: entries,
                                            is_file=lambda _p: True, in_git_tree=lambda _p: False), "0.1.0")
        with self.assertRaises(site.Refusal) as ctx:
            site.semantic_gate(config(), platform="win32", read_uninstall=lambda: [], is_file=lambda _p: True,
                               in_git_tree=lambda _p: False)
        self.assertTrue(ctx.exception.notice.startswith(NOTICE))
        self.assertIn("S32", ctx.exception.notice)
        self.assertEqual(ctx.exception.code, "not-installed")

    def test_a_non_windows_platform_is_refused_by_the_gate_itself(self):
        with self.assertRaises(site.Refusal) as ctx:
            site.semantic_gate(config(), platform="darwin", read_uninstall=lambda: [], is_file=lambda _p: True,
                               in_git_tree=lambda _p: False)
        self.assertEqual(ctx.exception.code, "not-windows")

    def test_a_double_with_a_real_id_claimed_is_still_refused_before_the_installer_is_looked_at(self):
        with self.assertRaises(site.Refusal) as ctx:
            site.semantic_gate(config(kind="test-double"), platform="darwin", read_uninstall=lambda: [],
                               is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertEqual(ctx.exception.code, "test-double")  # Provider first: one run prints one notice

    def test_there_is_no_command_line_way_to_swap_the_gate(self):
        res = run_cli("semantic-scenario", "preflight", "--config", "x.json", "--installer-check", "ok")
        self.assertEqual(res.returncode, 2, res.stdout + res.stderr)  # argparse: unknown argument
        self.assertEqual(self.notice_lines(res), [])


def make_db(path, with_settings=True):
    """The columns read_counts reads (storage/src/migrations.ts v20): facts, relations, their history, settings."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE facts (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE relations (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE fact_history (fact_id INTEGER NOT NULL, seq INTEGER NOT NULL, actor TEXT NOT NULL,
                                   action TEXT NOT NULL, to_status TEXT NOT NULL, PRIMARY KEY (fact_id, seq));
        CREATE TABLE relation_history (relation_id INTEGER NOT NULL, seq INTEGER NOT NULL, actor TEXT NOT NULL,
                                       action TEXT NOT NULL, to_status TEXT NOT NULL, PRIMARY KEY (relation_id, seq));
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    db.commit()
    db.close()


def add(path, table, row_id, status, lines=(), kind="alias.synonym"):
    """One fact or relation row and its history lines (actor, action, to_status), seq from 1."""
    db = sqlite3.connect(path)
    if table == "facts":
        db.execute("INSERT INTO facts (id, item_id, kind, status) VALUES (?, 1, ?, ?)", (row_id, kind, status))
        fk, history = "fact_id", "fact_history"
    else:
        db.execute("INSERT INTO relations (id, status) VALUES (?, ?)", (row_id, status))
        fk, history = "relation_id", "relation_history"
    for seq, (actor, action, to) in enumerate(lines, start=1):
        db.execute("INSERT INTO {} ({}, seq, actor, action, to_status) VALUES (?, ?, ?, ?, ?)".format(history, fk),
                   (row_id, seq, actor, action, to))
    db.commit()
    db.close()


PROMOTE = ("policy", "auto-verify", "verified")
REVERT = ("policy", "auto-verify-reverted", "candidate")
EXTRACT = ("extraction", "created", "candidate")


class SemanticCounts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "pki.sqlite")
        make_db(self.db)

    def counts(self, phase="off"):
        return ss.read_counts(self.db, phase)

    def test_forms_are_counted_per_kind_and_status_and_definitions_per_status(self):
        add(self.db, "facts", 1, "verified", [EXTRACT], kind="alias.synonym")
        add(self.db, "facts", 2, "candidate", [EXTRACT], kind="alias.synonym")
        add(self.db, "facts", 3, "candidate", [EXTRACT], kind="alias.abbreviation")
        add(self.db, "facts", 4, "rejected", [EXTRACT], kind="definition")
        add(self.db, "facts", 5, "verified", [EXTRACT], kind="owner")  # neither a form nor a definition
        c = self.counts()
        self.assertEqual(c["forms"]["alias.synonym"], {"candidate": 1, "verified": 1, "disputed": 0, "rejected": 0, "superseded": 0})
        self.assertEqual(c["forms"]["alias.abbreviation"]["candidate"], 1)
        self.assertEqual(c["definitions"], {"candidate": 0, "verified": 0, "disputed": 0, "rejected": 1, "superseded": 0})
        self.assertNotIn("owner", c["forms"])

    def test_the_counts_are_of_the_final_state_not_of_history_lines(self):
        """W1: promote, revert, promote again is one promoted row; the three lines are not three."""
        add(self.db, "facts", 1, "verified", [EXTRACT, PROMOTE, REVERT, PROMOTE])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (1, 1, 0))

    def test_a_promotion_the_policy_took_back_is_promoted_but_not_standing(self):
        add(self.db, "facts", 1, "candidate", [EXTRACT, PROMOTE, REVERT])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (1, 0, 0))

    def test_a_promoted_row_the_user_disputed_or_rejected_counts_once_as_judged_wrong(self):
        add(self.db, "facts", 1, "disputed", [EXTRACT, PROMOTE, ("user", "dispute", "disputed")])
        add(self.db, "facts", 2, "rejected", [EXTRACT, PROMOTE, ("user", "dispute", "disputed"), ("user", "reject", "rejected")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (2, 0, 2))

    def test_a_dispute_the_policy_raised_is_not_judged_wrong_but_the_users_is(self):
        add(self.db, "facts", 1, "disputed", [EXTRACT, PROMOTE, ("policy", "dispute", "disputed")])
        add(self.db, "facts", 2, "disputed", [EXTRACT, PROMOTE, ("user", "dispute", "disputed")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (2, 0, 1))

    def test_the_connection_open_ro_returns_refuses_a_write(self):
        db = ss.open_ro(self.db)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("CREATE TABLE x (a)")
        finally:
            db.close()

    def test_a_promoted_value_the_user_replaced_is_judged_wrong_but_one_propagation_superseded_is_not(self):
        add(self.db, "facts", 1, "superseded", [EXTRACT, PROMOTE, ("user", "replace", "superseded")])
        add(self.db, "facts", 2, "superseded", [EXTRACT, PROMOTE, ("propagation", "supersede", "superseded")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedJudgedWrong"]), (2, 1))

    def test_a_dispute_the_user_undid_is_not_judged_wrong(self):
        add(self.db, "facts", 1, "verified", [EXTRACT, PROMOTE, ("user", "dispute", "disputed"), ("user", "undo", "verified")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (1, 1, 0))

    def test_a_state_neutral_line_after_the_user_line_does_not_hide_it(self):
        add(self.db, "facts", 1, "superseded", [EXTRACT, PROMOTE, ("user", "replace", "superseded"), ("user", "merge", "superseded")])
        self.assertEqual(self.counts()["promotedJudgedWrong"], 1)

    def test_a_user_approved_candidate_is_not_promoted(self):
        add(self.db, "facts", 1, "verified", [EXTRACT, ("user", "approve", "verified")])
        add(self.db, "facts", 2, "verified", [("user", "created", "verified")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (0, 0, 0))

    def test_relations_are_counted_with_the_facts(self):
        add(self.db, "facts", 1, "verified", [EXTRACT, PROMOTE])
        add(self.db, "relations", 1, "disputed", [EXTRACT, PROMOTE, ("user", "dispute", "disputed")])
        c = self.counts()
        self.assertEqual((c["promoted"], c["promotedStanding"], c["promotedJudgedWrong"]), (2, 1, 1))

    def test_the_setting_is_named_by_a_code_never_by_its_stored_text(self):
        self.assertEqual(self.counts()["setting"], "unset")
        for stored, named in (("on", "on"), ("off", "off"), ("secret words", "other")):
            db = sqlite3.connect(self.db)
            db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('semantic.autoVerify', ?)", (stored,))
            db.commit()
            db.close()
            self.assertEqual(self.counts()["setting"], named, stored)

    def test_the_db_is_opened_read_only_and_a_missing_db_is_not_created(self):
        add(self.db, "facts", 1, "verified", [EXTRACT, PROMOTE])
        with open(self.db, "rb") as fh:
            before = fh.read()
        self.counts()
        with open(self.db, "rb") as fh:
            self.assertEqual(fh.read(), before)
        missing = os.path.join(self.dir.name, "none.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            ss.read_counts(missing, "off")
        self.assertFalse(os.path.exists(missing))

    def test_the_written_json_holds_numbers_and_code_names_only(self):
        add(self.db, "facts", 1, "verified", [EXTRACT, PROMOTE], kind="alias.synonym")
        add(self.db, "facts", 2, "candidate", [EXTRACT], kind="alias.x secret term")  # an odd kind is not echoed
        add(self.db, "facts", 3, "candidate", [EXTRACT], kind="alias.codename")  # a well-formed user-made kind is not echoed
        path = ss.write_counts(self.counts("on"), self.dir.name)
        self.assertEqual(os.path.basename(path), "semantic-counts.on.json")
        with open(path, encoding="utf-8") as fh:
            self.assertNotIn("alias.codename", fh.read())
        self.assertEqual(self.counts("on")["forms"]["other"]["candidate"], 2)
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        allowed = set(STATUSES) | {"on", "off", "unset", "other", "alias.synonym", "alias.abbreviation", "alias.translation",
                                   "forms", "definitions", "promoted", "promotedStanding", "promotedJudgedWrong",
                                   "setting", "phase"}

        def walk(node):
            if isinstance(node, dict):
                for key, value in node.items():
                    self.assertIn(key, allowed)
                    walk(value)
            elif isinstance(node, str):
                self.assertIn(node, allowed)
            else:
                self.assertIsInstance(node, int)

        walk(data)
        self.assertEqual(data["phase"], "on")
        self.assertEqual(data["forms"]["other"]["candidate"], 2)

    def test_a_phase_that_disagrees_with_the_stored_setting_is_reported(self):
        self.assertEqual(ss.phase_warning(self.counts("on")), "phase on, but the stored setting is unset")
        self.assertIsNone(ss.phase_warning(self.counts("off")))
        db = sqlite3.connect(self.db)
        db.execute("INSERT INTO settings (key, value) VALUES ('semantic.autoVerify', 'on')")
        db.commit()
        db.close()
        self.assertIsNone(ss.phase_warning(self.counts("on")))
        self.assertEqual(ss.phase_warning(self.counts("off")), "phase off, but the stored setting is on")


if __name__ == "__main__":
    unittest.main()
