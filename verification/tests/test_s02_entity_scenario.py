"""S02-T10 (S02-R27, S02-R28, S02-H2) `site-paths.refuse` (entity resolution): the entity scenario of the V02 site runner
(S33) refuses outside a Windows installed build with a real Provider, with one notice starting with `배포처 후속` that
names S33, a non-zero exit and nothing written. Its counts are checked on a synthetic SQLite built with the column names of
storage/src/migrations.ts (never a database the product wrote). Nothing here is site evidence: the Windows branch and
`record` were never run on Windows."""
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
site = _paths.load_kit_module(KIT, "run.py", "s02_site_run")
es = site.entity_scenario  # the module run.py imported: one set of exception classes

NOTICE = "배포처 후속"


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


class EntityScenarioRefuse(unittest.TestCase):
    """S02-H2: outside the installed build the scenario gives one `배포처 후속` notice naming S33 and writes nothing."""

    def test_outside_a_windows_installer_every_action_is_refused_with_one_s33_notice_and_nothing_is_written(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as out:
            for args in (("preflight",), ("record", "--out", out, "--phase", "off"), ("record", "--out", out, "--phase", "on")):
                res = run_cli("entity-scenario", args[0], "--config", os.path.join(out, "no-such-config.json"), *args[1:])
                self.assertEqual(res.returncode, site.NOTICE_EXIT, res.stdout + res.stderr)
                lines = [l for l in res.stdout.splitlines() if l.startswith(NOTICE)]
                self.assertEqual(len(lines), 1, res.stdout + res.stderr)
                self.assertIn("S33", lines[0])
                self.assertIn("S02-H2", lines[0])
                self.assertIn("not-windows", lines[0])
            self.assertEqual(os.listdir(out), [])

    def test_on_windows_a_test_double_provider_and_a_missing_installer_are_refused_with_the_s33_notice(self):
        cfg = {"productName": "PKI", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\PKI\\PKI.exe",
               "provider": {"kind": "test-double", "id": "openai-compatible", "name": "openai-compatible", "version": "x"}}
        with self.assertRaises(site.Refusal) as ctx:
            site.entity_gate(cfg, platform="win32", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertTrue(ctx.exception.notice.startswith(NOTICE))
        self.assertIn("S33", ctx.exception.notice)
        self.assertEqual(ctx.exception.code, "test-double")
        real = dict(cfg, provider=dict(cfg["provider"], kind="real"))
        with self.assertRaises(site.Refusal) as ctx:
            site.entity_gate(real, platform="win32", read_uninstall=lambda: [], is_file=lambda _p: True, in_git_tree=lambda _p: False)
        self.assertIn("S33", ctx.exception.notice)
        self.assertEqual(ctx.exception.code, "not-installed")


def make_db(path):
    """The columns read_counts reads (storage/src/migrations.ts): items, merges, marks, candidates, intervals, history, settings."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE items (id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE item_merges (id INTEGER PRIMARY KEY, member_id INTEGER NOT NULL, representative_id INTEGER NOT NULL, active INTEGER NOT NULL);
        CREATE TABLE item_distinct (item_a INTEGER NOT NULL, item_b INTEGER NOT NULL, by TEXT NOT NULL, PRIMARY KEY (item_a, item_b));
        CREATE TABLE merge_candidates (item_a INTEGER NOT NULL, item_b INTEGER NOT NULL, signals TEXT NOT NULL, PRIMARY KEY (item_a, item_b));
        CREATE TABLE facts (id INTEGER PRIMARY KEY, valid_at TEXT, valid_until TEXT);
        CREATE TABLE fact_history (fact_id INTEGER NOT NULL, seq INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
                                   reason TEXT, PRIMARY KEY (fact_id, seq));
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    db.commit()
    db.close()


class EntityCounts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "pki.sqlite")
        make_db(self.db)

    def sql(self, statement, *params):
        db = sqlite3.connect(self.db)
        db.execute(statement, params)
        db.commit()
        db.close()

    def test_record_counts_the_final_state_and_writes_numbers_and_code_names_only(self):
        for i, (kind, name) in enumerate([("Person", "Zorbax Quillon"), ("Person", "Mervane"), ("Project", "p"), ("Codename", "secret term")], 1):
            self.sql("INSERT INTO items (id, type, name) VALUES (?, ?, ?)", i, kind, name)
        self.sql("INSERT INTO merge_candidates VALUES (1, 2, '[\"same-type\"]')")
        self.sql("INSERT INTO item_merges (member_id, representative_id, active) VALUES (2, 1, 1)")
        self.sql("INSERT INTO item_merges (member_id, representative_id, active) VALUES (4, 3, 0)")
        self.sql("INSERT INTO item_distinct VALUES (1, 3, 'user')")
        self.sql("INSERT INTO item_distinct VALUES (1, 4, 'link-check')")
        self.sql("INSERT INTO item_distinct VALUES (2, 4, 'link-check')")
        self.sql("INSERT INTO facts (id, valid_at, valid_until) VALUES (1, '2026-01-01', NULL)")
        self.sql("INSERT INTO facts (id, valid_at, valid_until) VALUES (2, NULL, NULL)")
        # a fix, a second fix of the same row, and the policy's dispute: rows, not lines
        for seq, (actor, action, reason) in enumerate([("user", "set-validity", None), ("user", "set-validity", None)], 1):
            self.sql("INSERT INTO fact_history VALUES (1, ?, ?, ?, ?)", seq, actor, action, reason)
        self.sql("INSERT INTO fact_history VALUES (2, 1, 'policy', 'dispute', 'contradiction')")
        self.sql("INSERT INTO fact_history VALUES (2, 2, 'user', 'dispute', 'contradiction')")
        self.sql("INSERT INTO settings VALUES ('semantic.autoDispute', 'on')")

        counts = es.read_counts(self.db, "on")
        self.assertEqual(counts["items"], {"Person": 2, "Project": 1, "other": 1})
        self.assertEqual(counts["candidates"], 1)
        self.assertEqual(counts["merges"], {"active": 1, "resting": 1})
        self.assertEqual(counts["distinctBy"], {"user": 1, "link-check": 2})
        self.assertEqual(counts["factsWithValidity"], 1)
        self.assertEqual(counts["validityFixedByUser"], 1)
        self.assertEqual(counts["autoDisputes"], 1)
        self.assertEqual((counts["setting"], counts["phase"]), ("on", "on"))
        self.assertIsNone(es.phase_warning(counts))

        path = es.write_counts(counts, self.dir.name)
        self.assertEqual(os.path.basename(path), "entity-counts.on.json")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for seeded in ("Zorbax", "Quillon", "Mervane", "secret term", "Codename", "same-type"):
            self.assertNotIn(seeded, text)

    def test_a_phase_that_disagrees_with_the_stored_setting_is_reported_and_a_missing_db_is_not_created(self):
        self.assertEqual(es.read_counts(self.db, "on")["setting"], "unset")
        self.assertEqual(es.phase_warning(es.read_counts(self.db, "on")), "phase on, but the stored setting is unset")
        missing = os.path.join(self.dir.name, "none.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            es.read_counts(missing, "off")
        self.assertFalse(os.path.exists(missing))


class EntityRunbook(unittest.TestCase):
    def test_the_runbook_section_names_the_subcommand_and_every_counted_name(self):
        with open(os.path.join(_paths.VERIF_DIR, KIT, "RUNBOOK.md"), encoding="utf-8") as fh:
            text = fh.read()
        section = text[text.index("## 11. 개체 해소 실측 (S33"):]
        self.assertIn("entity-scenario preflight", section)
        self.assertIn("entity-scenario record", section)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            counts = es.read_counts(path, "off")
        for name in counts:
            self.assertIn("`{}`".format(name), section, name)


if __name__ == "__main__":
    unittest.main()
