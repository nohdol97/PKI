"""I07-T05 (I07-R12, I07-C14, I07-H2 2) `scopes-check`: the installed-build check of the V02 site runner (site-setup S31).
Outside a Windows installed build it refuses with one notice starting with `배포처 후속` and writes nothing. The verdict and
the record are checked on a synthetic SQLite and a synthetic expected-values file (never a database the product wrote).
Nothing here is site evidence: the Windows branch was never run on Windows or against a real installed build.

Run: python3 -m unittest verification.tests.test_i07_scopes_check -v"""
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
site = _paths.load_kit_module(KIT, "run.py", "i07_site_run")

RESULT = "scopes-check-result.json"
CONFIG = {"productName": "Example Product", "installedExe": "C:\\Users\\u\\AppData\\Local\\Programs\\Example\\Example.exe"}


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def make_db(path, rows):
    """connector_instances as storage/src/migrations.ts creates it (id, kind, cursor, configured_scope)."""
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE connector_instances (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cursor TEXT, configured_scope TEXT)")
    db.executemany("INSERT INTO connector_instances (id, kind, configured_scope) VALUES (?, 'unknown', ?)", rows)
    db.commit()
    db.close()


class ScopesCheckCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.out = os.path.join(self.dir, "out")
        os.mkdir(self.out)
        self.db = os.path.join(self.dir, "pki.sqlite")
        self.config = self.write("config.json", json.dumps(CONFIG))

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        return path

    def check(self, expected_text, rows):
        make_db(self.db, rows)
        expected = self.write("expected.json", expected_text)
        with open(self.db, "rb") as fh:
            before = fh.read()
        code = site.main(["scopes-check", "--config", self.config, "--expected", expected, "--out", self.out],
                         installer_check=lambda cfg: "1.2.3", db_path=self.db)
        with open(self.db, "rb") as fh:
            self.assertEqual(fh.read(), before, "the canonical database changed")
        path = os.path.join(self.out, RESULT)
        if not os.path.exists(path):
            return code, None
        with open(path, encoding="utf-8") as fh:
            return code, json.load(fh)


class ScopesCheckRefuse(unittest.TestCase):
    """I07-H2 2: outside a Windows installed build, one `배포처 후속` notice naming S31, a non-zero exit, nothing written."""

    def test_outside_windows_it_is_refused_before_the_config_is_read_with_one_s31_notice_and_nothing_is_written(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine without the installed product")
        with tempfile.TemporaryDirectory() as out:
            res = run_cli("scopes-check", "--config", os.path.join(out, "no-such-config.json"),
                          "--expected", os.path.join(out, "no-such-expected.json"), "--out", out)
            self.assertEqual(res.returncode, site.NOTICE_EXIT, res.stdout + res.stderr)
            lines = [l for l in res.stdout.splitlines() if l.startswith("배포처 후속")]
            self.assertEqual(len(lines), 1, res.stdout + res.stderr)
            self.assertIn("S31", lines[0])
            self.assertIn("미구현, 배포처 후속", lines[0])
            self.assertIn("not-windows", lines[0])
            self.assertEqual(os.listdir(out), [])


class ScopesCheckVerdict(ScopesCheckCase):
    def test_every_expected_value_equal_passes_whatever_the_order_and_duplicates_and_the_record_holds_no_value_or_id(self):
        expected = json.dumps({"inst-alpha": ["scope-b", "scope-a", "scope-b"], "inst-beta": None, "inst-gamma": ["scope-z"]})
        rows = [("inst-alpha", '["scope-a","scope-b"]'), ("inst-beta", None), ("inst-gamma", '["scope-z"]'), ("inst-extra", None)]
        code, record = self.check(expected, rows)
        self.assertEqual(code, 0)
        self.assertEqual(record["verdict"], "PASS")
        self.assertEqual((record["compared"], record["same"], record["different"], record["missing"]), (2, 2, 0, 0))
        self.assertEqual(record["appVersion"], "1.2.3")
        self.assertIn("os", record)
        text = json.dumps(record) + "".join(open(os.path.join(self.out, f), encoding="utf-8").read() for f in os.listdir(self.out))
        for secret in ("inst-alpha", "inst-gamma", "scope-a", "scope-b", "scope-z"):
            self.assertNotIn(secret, text)

    def test_a_different_value_or_a_null_in_the_database_fails_even_when_another_expected_instance_is_missing(self):
        expected = json.dumps({"inst-a": ["scope-a"], "inst-b": ["scope-b"], "inst-c": ["scope-c"]})
        code, record = self.check(expected, [("inst-a", '["scope-a"]'), ("inst-b", None)])
        self.assertEqual(code, 1)
        self.assertEqual(record["verdict"], "FAIL")
        self.assertEqual((record["compared"], record["same"], record["different"], record["missing"]), (3, 1, 1, 1))

    def test_nothing_proved_is_inconclusive_not_a_pass(self):
        for name, expected, rows in (
                ("no scoped expected entry", json.dumps({"inst-a": None}), [("inst-a", None)]),
                ("expected instance not in the database yet", json.dumps({"inst-a": ["scope-a"]}), [("inst-other", None)])):
            with self.subTest(name):
                code, record = self.check(expected, rows)
                self.assertEqual(code, 1)
                self.assertEqual(record["verdict"], "INCONCLUSIVE")


class ScopesCheckExpectedFile(ScopesCheckCase):
    def test_an_expected_file_that_is_not_an_object_or_has_a_bad_entry_ends_as_a_config_error_with_no_verdict(self):
        for name, text in (("array", "[]"), ("bad entry", '{"a": ["x", ""]}'), ("proto key", '{"__proto__": ["x"]}'),
                           ("duplicate key", '{"a": ["x"], "\\u0061": ["y"]}')):
            with self.subTest(name):
                code, record = self.check(text, [("a", '["x"]')])
                self.assertEqual(code, site.CONFIG_EXIT)
                self.assertIsNone(record)


if __name__ == "__main__":
    unittest.main()
