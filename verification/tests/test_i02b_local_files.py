"""I02B-T06 (I02B-R44, I02B-H2 ①) `site-paths.refuse` for the local-files runner (S23): outside a Windows installed app the
runner prints one notice that starts with `배포처 후속` and ends with exit value 3, writing nothing; `prepare` makes the W1~W12
scenario files from synthetic text only, and what `record` writes names no file and carries no marker of their text. Nothing
here is site evidence: the Windows branch was never run on Windows.

Run: python3 -m unittest discover -s verification"""
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

KIT = "local-files"
run = _paths.load_kit_module(KIT, "run.py", "i02b_local_files_run")

NOTICE = "배포처 후속"
SCHEMA = """
CREATE TABLE sources (id INTEGER PRIMARY KEY, connector_instance_id TEXT NOT NULL, namespace TEXT NOT NULL DEFAULT '',
  external_id TEXT NOT NULL);
CREATE TABLE source_versions (id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL, version INTEGER NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL);
CREATE TABLE tombstones (source_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL);
CREATE TABLE local_file_entries (external_id TEXT PRIMARY KEY, location_id TEXT NOT NULL, state TEXT NOT NULL,
  skip_reason TEXT);
"""


def run_cli(*args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, KIT, "run.py")] + list(args),
                          capture_output=True, text=True, timeout=60)


def names_under(folder):
    return sorted(name for _, dirs, files in os.walk(folder) for name in dirs + files)


class Refusals(unittest.TestCase):
    """I02B-H2 ①: not Windows, or `--app` not an installed app: the notice and 3, nothing written."""

    def test_outside_windows_every_action_is_refused_with_the_notice_and_exit_3_and_nothing_is_written(self):
        if sys.platform == "win32":
            self.skipTest("this case needs a machine that is not Windows")
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "empty")
            os.mkdir(folder)
            for action, extra in (("prepare", []), ("record", ["--data-dir", tmp, "--out", os.path.join(tmp, "r.json")])):
                res = run_cli(action, "--app", tmp, "--folder", folder, *extra)
                self.assertEqual(res.returncode, 3, res.stderr)
                self.assertTrue((res.stdout + res.stderr).lstrip().startswith(NOTICE), res.stdout + res.stderr)
            self.assertEqual(os.listdir(folder), [])
            self.assertFalse(os.path.exists(os.path.join(tmp, "r.json")))
            self.assertFalse(os.path.exists(folder + ".local-files-state.json"))

    def test_on_windows_a_folder_with_no_installed_executable_is_refused_too(self):
        with tempfile.TemporaryDirectory() as app:
            with self.assertRaises(run.Refusal) as caught:
                run.gate(app, platform="win32")
            self.assertTrue(str(caught.exception).startswith(NOTICE))
            open(os.path.join(app, "Uninstall PKI.exe"), "w").close()  # the uninstaller is no app
            with self.assertRaises(run.Refusal):
                run.gate(app, platform="win32")
            open(os.path.join(app, "PKI.exe"), "w").close()
            run.gate(app, platform="win32")  # an installed executable: no refusal


class CommandLine(unittest.TestCase):
    def test_on_an_installed_app_prepare_and_record_run_end_to_end_and_print_no_file_name(self):
        import contextlib
        import io
        with tempfile.TemporaryDirectory() as tmp:
            app = os.path.join(tmp, "app")
            os.mkdir(app)
            open(os.path.join(app, "PKI.exe"), "w").close()
            folder = os.path.join(tmp, "docs")
            data = os.path.join(tmp, "data")
            os.mkdir(data)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(run.main(["prepare", "--app", app, "--folder", folder], platform="win32"), 0)
            self.assertTrue(os.path.isfile(folder + ".local-files-state.json"))
            for name in names_under(folder):
                self.assertNotIn(name, out.getvalue())
            con = sqlite3.connect(os.path.join(data, "pki.sqlite"))
            con.executescript(SCHEMA)
            con.close()
            result = os.path.join(tmp, "result.json")
            with contextlib.redirect_stdout(out):
                self.assertEqual(run.main(["record", "--app", app, "--folder", folder, "--data-dir", data, "--out", result], platform="win32"), 0)
            with open(result, encoding="utf-8") as handle:
                self.assertEqual(set(json.load(handle)["items"]), {"W%d" % n for n in range(1, 13)})


class PrepareAndRecord(unittest.TestCase):
    def test_prepare_makes_every_scenario_and_the_record_names_no_file_and_carries_no_marker(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "docs")
            os.mkdir(folder)
            state = run.prepare(folder)
            created = names_under(folder)
            self.assertTrue(created)
            self.assertEqual(set(state["scenarios"]), {"W%d" % n for n in range(1, 13)})

            db = os.path.join(tmp, "pki.sqlite")
            con = sqlite3.connect(db)
            con.executescript(SCHEMA)
            con.execute("INSERT INTO sources (id, connector_instance_id, external_id) VALUES (1, 'local-files', 'a')")
            con.execute("INSERT INTO source_versions (source_id, version, title, body) VALUES (1, 1, 't', ?)",
                        ("body " + state["scenarios"]["W1"]["marker"],))
            con.commit()
            con.close()

            result = run.record(state, db, answers={}, environment={"os": "Windows 11 (test)", "appVersion": "0.0.0", "fileSystem": "NTFS"})
            text = json.dumps(result, ensure_ascii=False)
            for item in ("W%d" % n for n in range(1, 13)):
                self.assertIn(result["items"][item], ("pass", "fail", "inconclusive"))
            self.assertEqual(result["os"], "Windows 11 (test)")
            self.assertEqual(result["fileSystem"], "NTFS")
            for name in created:
                self.assertNotIn(name, text)
            for scenario in state["scenarios"].values():
                self.assertNotIn(scenario["marker"], text)
                self.assertNotIn(scenario.get("outsideMarker", "\0"), text)

    def test_a_file_outside_the_location_that_became_a_source_fails_w2_and_the_database_is_only_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "docs")
            os.mkdir(folder)
            state = run.prepare(folder)
            db = os.path.join(tmp, "pki.sqlite")
            con = sqlite3.connect(db)
            con.executescript(SCHEMA)
            for sid, marker in enumerate((state["scenarios"]["W2"]["marker"], state["scenarios"]["W2"]["outsideMarker"]), 1):
                con.execute("INSERT INTO sources (id, connector_instance_id, external_id) VALUES (?, 'local-files', ?)", (sid, str(sid)))
                con.execute("INSERT INTO source_versions (source_id, version, title, body) VALUES (?, 1, 't', ?)", (sid, marker))
            con.commit()
            con.close()
            before = os.stat(db).st_mtime_ns
            self.assertEqual(run.record(state, db, answers={}, environment={})["items"]["W2"], "fail")
            self.assertEqual(os.stat(db).st_mtime_ns, before)
            self.assertEqual(run.record(state, db, answers={"W2": "pass"}, environment={})["items"]["W2"], "fail")

    def test_record_opens_a_database_whose_path_holds_uri_special_characters(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = os.path.join(tmp, "docs")
            os.mkdir(folder)
            state = run.prepare(folder)
            odd = os.path.join(tmp, "a?b#c%d")
            os.mkdir(odd)
            db = os.path.join(odd, "pki.sqlite")
            con = sqlite3.connect(db)
            con.executescript(SCHEMA)
            con.commit()
            con.close()
            result = run.record(state, db, answers={}, environment={})
            self.assertIn(result["items"]["W1"], ("pass", "fail", "inconclusive"))


if __name__ == "__main__":
    unittest.main()
