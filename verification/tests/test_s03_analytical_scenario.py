"""S03-T10 (S03-R21, S03-H2) `site-paths.refuse` (analytical semantic): the analytical scenario of the V02 site runner (S34)
refuses outside a Windows installed build with one notice starting with `배포처 후속` that names S34, a non-zero exit and
nothing written. Its counts are checked on a synthetic SQLite built with the column names of storage/src/migrations.ts (never
a database the product wrote). Nothing here is site evidence: the Windows branch and `record` were never run on Windows.

Run: python3 -m unittest verification/tests/test_s03_analytical_scenario.py -v"""
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
site = _paths.load_kit_module(KIT, "run.py", "s03_site_run")
az = site.analytical_scenario  # the module run.py imported: one set of exception classes

NOTICE = "배포처 후속"


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


class AnalyticalScenarioRefuse(unittest.TestCase):
    """S03-H2: outside the installed build the scenario gives one `배포처 후속` notice naming S34 and writes nothing."""

    def test_outside_a_windows_installer_every_action_is_refused_with_one_s34_notice_and_nothing_is_written(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as out:
            for args in (("preflight",), ("record", "--out", out)):
                res = run_cli("analytical-scenario", args[0], "--config", os.path.join(out, "no-such-config.json"), *args[1:])
                self.assertEqual(res.returncode, site.NOTICE_EXIT, res.stdout + res.stderr)
                lines = [l for l in res.stdout.splitlines() if l.startswith(NOTICE)]
                self.assertEqual(len(lines), 1, res.stdout + res.stderr)
                self.assertIn("S34", lines[0])
                self.assertIn("S03-H2", lines[0])
                self.assertIn("not-windows", lines[0])
            self.assertEqual(os.listdir(out), [])


def make_db(path):
    """The columns read_counts reads (storage/src/migrations.ts): sources, versions, tombstones, tables, items, facts, checks, jobs."""
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE source_versions (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, version INTEGER NOT NULL, blocks TEXT);
        CREATE TABLE tombstones (source_id INTEGER PRIMARY KEY, covers_version INTEGER NOT NULL);
        CREATE TABLE dataset_tables (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, source_id INTEGER NOT NULL, row_count INTEGER NOT NULL);
        CREATE TABLE items (id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE facts (id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE analytical_checks (id INTEGER PRIMARY KEY, fact_id INTEGER NOT NULL, check_name TEXT NOT NULL, passed INTEGER NOT NULL);
        CREATE TABLE jobs (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source_id INTEGER, status TEXT NOT NULL,
                           created_at INTEGER NOT NULL, finished_at INTEGER);
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    db.commit()
    db.close()


CSV = '[{"start":0,"end":1,"locator":{"format":"csv","record":1,"line":1,"field":1}}]'
TEXT = '[{"start":0,"end":1,"locator":{"format":"text"}}]'


class AnalyticalCounts(unittest.TestCase):
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
        # sources: 1 current CSV (table, 40 rows), 2 current CSV (no table), 3 a CSV tombstoned, 4 a text note;
        # source 1 has an older version 1 and a current version 2
        for sid, version, blocks in [(1, 1, CSV), (1, 2, CSV), (2, 1, CSV), (3, 1, CSV), (4, 1, TEXT)]:
            self.sql("INSERT INTO source_versions (source_id, version, blocks) VALUES (?, ?, ?)", sid, version, blocks)
        self.sql("INSERT INTO tombstones VALUES (3, 1)")
        self.sql("INSERT INTO items VALUES (1, 'Dataset', 'Zorbax orders', 'candidate')")
        self.sql("INSERT INTO items VALUES (2, 'Dataset', 'Quillon', 'rejected')")
        self.sql("INSERT INTO items VALUES (3, 'Metric', 'Mervane total', 'verified')")
        self.sql("INSERT INTO dataset_tables (item_id, source_id, row_count) VALUES (1, 1, 40)")
        self.sql("INSERT INTO dataset_tables (item_id, source_id, row_count) VALUES (2, 2, 5)")
        self.sql("INSERT INTO facts VALUES (1, 1, 'dataset.grain', 'secret grain', 'candidate')")
        self.sql("INSERT INTO facts VALUES (2, 3, 'metric.calculation', 'secret calc', 'verified')")
        self.sql("INSERT INTO facts VALUES (3, 3, 'user.made.kind', 'x', 'candidate')")
        self.sql("INSERT INTO analytical_checks (fact_id, check_name, passed) VALUES (1, 'grain', 1)")
        self.sql("INSERT INTO analytical_checks (fact_id, check_name, passed) VALUES (2, 'aggregation', 0)")
        self.sql("INSERT INTO jobs (kind, source_id, status, created_at, finished_at) VALUES ('dataset-profile', 1, 'succeeded', 1000, 1900)")
        self.sql("INSERT INTO jobs (kind, source_id, status, created_at, finished_at) VALUES ('analytical-check', 1, 'succeeded', 2000, 2300)")
        self.sql("INSERT INTO settings VALUES ('analytical.profile', 'on')")
        self.sql("INSERT INTO settings VALUES ('analytical.maxCells', '300000')")

        counts = az.read_counts(self.db)
        self.assertEqual((counts["setting"], counts["maxCells"]), ("on", 300000))
        self.assertEqual(counts["tableSources"], 2)  # sources 1 and 2: the tombstoned one and the text note are not table sources
        self.assertEqual(counts["tables"], 2)
        self.assertEqual(counts["sourcesWithoutTable"], 0)
        self.assertEqual(counts["datasetsRejected"], 1)
        self.assertEqual(counts["items"], {"Dataset": {"candidate": 1, "rejected": 1}, "Metric": {"verified": 1}})
        self.assertEqual(counts["facts"], {"dataset.grain": 1, "metric.calculation": 1, "other": 1})
        self.assertEqual(counts["checks"], {"grain": {"passed": 1, "failed": 0}, "aggregation": {"passed": 0, "failed": 1}})
        self.assertEqual(counts["largest"], {"rowCount": 40, "profileMs": 900, "checkMs": 300})
        self.assertIsNone(az.setting_warning(counts))

        path = az.write_counts(counts, self.dir.name)
        self.assertEqual(os.path.basename(path), "analytical-counts.json")
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        for seeded in ("Zorbax", "Quillon", "Mervane", "secret", "user.made.kind"):
            self.assertNotIn(seeded, text)

    def test_a_setting_that_is_not_on_is_reported_and_a_missing_db_is_not_created(self):
        counts = az.read_counts(self.db)
        self.assertEqual(counts["setting"], "unset")
        self.assertEqual(counts["maxCells"], "unset")
        self.assertEqual(counts["largest"], None)
        self.assertEqual(az.setting_warning(counts), "the stored setting analytical.profile is unset, not on")
        missing = os.path.join(self.dir.name, "none.sqlite")
        with self.assertRaises(sqlite3.OperationalError):
            az.read_counts(missing)
        self.assertFalse(os.path.exists(missing))


class AnalyticalRunbook(unittest.TestCase):
    def test_the_runbook_section_names_the_subcommand_and_every_counted_name(self):
        with open(os.path.join(_paths.VERIF_DIR, KIT, "RUNBOOK.md"), encoding="utf-8") as fh:
            text = fh.read()
        section = text[text.index("## 12. 분석 의미 실측 (S34"):]
        self.assertIn("analytical-scenario preflight", section)
        self.assertIn("analytical-scenario record", section)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "pki.sqlite")
            make_db(path)
            counts = az.read_counts(path)
        for name in counts:
            self.assertIn("`{}`".format(name), section, name)


if __name__ == "__main__":
    unittest.main()
