"""R03 run.py real-mode code paths exercised through the actual entry point with SQLite temp files and the
fake hashing worker (no engine, no model, no CLI)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

RUN = os.path.join(_paths.VERIF_DIR, "r03-engine-comparison", "run.py")
FAKE_WORKER = os.path.join(_paths.TESTS_DIR, "fake_embed_worker.py")


def run(*args):
    return subprocess.run([sys.executable, RUN] + list(args), capture_output=True, text=True, timeout=300)


def checks(out):
    with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
        return {c["id"]: c for c in json.load(fh)["checks"]}


class RunPathTests(unittest.TestCase):
    def test_plan_lists_evidence_gaps(self):
        res = run("plan")
        self.assertEqual(res.returncode, 0, res.stderr)
        for token in ("R03-S1", "R03-S2", "R03-S3", "R03-S4", "R03-S5", "without evidence"):
            self.assertIn(token, res.stdout)

    def test_install_steps_mark_network_approval_and_pins(self):
        res = run("install-steps")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("NEEDS SITE NETWORK-INSTALL APPROVAL", res.stdout)
        for pin in ("1.5.7", "1.6.10", "v0.2.13", "v2.157.1", "01261ed135bfd2f821ff476ed2894b35288a30f8"):
            self.assertIn(pin, res.stdout)

    def test_storage_compare_sqlite_passes_all_checks(self):
        with tempfile.TemporaryDirectory() as d:
            res = run("storage-compare", "--store", "sqlite", "--workdir", os.path.join(d, "w"), "--out", os.path.join(d, "o"))
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            got = checks(os.path.join(d, "o"))
            self.assertTrue(got)
            self.assertEqual({c["verdict"] for c in got.values()}, {"PASS"})

    def test_durability_sqlite_all(self):
        with tempfile.TemporaryDirectory() as d:
            res = run("durability", "--target", "sqlite", "--check", "all", "--workdir", os.path.join(d, "w"), "--out", os.path.join(d, "o"))
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertEqual(len(checks(os.path.join(d, "o"))), 3)

    def test_embed_with_fake_worker_writes_predictions_and_result(self):
        with tempfile.TemporaryDirectory() as d:
            res = run("embed", "--model", "e5-base", "--backend", "command", "--worker-cmd", json.dumps([sys.executable, FAKE_WORKER]),
                      "--dataset", "fixtures", "--out", d)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertTrue(os.path.exists(os.path.join(d, "raw", "predictions-e5-base.jsonl")))
            self.assertEqual(checks(d)["R03-C3:embed:e5-base"]["verdict"], "PASS")

    def offline(self, *extra):
        with tempfile.TemporaryDirectory() as d:
            cache = os.path.join(d, "cache")
            os.makedirs(cache)
            with open(os.path.join(cache, "LICENSE"), "w", encoding="utf-8") as fh:
                fh.write("SECRET LICENSE TEXT 12345")
            res = run("embed-offline-check", "--model", "bge-m3", "--backend", "command",
                      "--worker-cmd", json.dumps([sys.executable, FAKE_WORKER]), "--cache-dir", cache, "--out", os.path.join(d, "o"), *extra)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            with open(os.path.join(d, "o", "result.json"), encoding="utf-8") as fh:
                text = fh.read()
            return text, checks(os.path.join(d, "o"))["R03-C3:offline:bge-m3"]

    def test_offline_check_is_inconclusive_without_an_attestation_and_records_hashes_not_contents(self):
        text, check = self.offline()
        self.assertEqual(check["verdict"], "INCONCLUSIVE")
        self.assertIn("offline_not_observed", check["codes"])
        self.assertEqual(len(check["facts"]["license_file_hashes"]), 1)
        self.assertTrue(check["facts"]["license_file_hashes"][0].startswith("h:"))
        self.assertNotIn("SECRET LICENSE TEXT", text)
        self.assertNotIn("LICENSE\"", text)

    def test_offline_check_passes_only_with_the_operator_attestation(self):
        _text, check = self.offline("--outbound-blocked-attested")
        self.assertEqual(check["verdict"], "PASS")
        self.assertIn("offline_attested_by_operator", check["codes"])

    def test_inspect_golden_shows_keys(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "labels"))
            with open(os.path.join(d, "labels", "x.jsonl"), "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"qid": "a", "text": "t"}) + "\n")
            res = run("inspect-golden", "--golden", d)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertIn("qid", res.stdout)

    def test_scenario_dry_run_executes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            res = run("scenario", "--engine", "cognee", "--dry-run", "--workdir", os.path.join(d, "w"), "--out", os.path.join(d, "o"))
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(os.listdir(d), [])

    def test_scenario_without_r02_gate_is_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            res = run("scenario", "--engine", "lightrag", "--workdir", os.path.join(d, "w"), "--out", os.path.join(d, "o"),
                      "--r02-result", os.path.join(d, "none.json"), "--profile", "codex-A-full", "--model", "m", "--cli-bin", sys.executable)
            self.assertEqual(res.returncode, 4, res.stdout + res.stderr)
            self.assertEqual(checks(os.path.join(d, "o"))["R03-C2:gate:lightrag"]["verdict"], "BLOCKED")


if __name__ == "__main__":
    unittest.main()
