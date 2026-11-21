"""End-to-end test of r02 run.py real-mode code paths against a FAKE `claude` executable (POSIX only).

Never a real CLI. This exercises detect/capabilities/positive/negative/cancel/not-installed/not-logged-in,
result merging and redaction through the actual entry point.
"""
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

from common.redact import Redactor

RUN = os.path.join(_paths.VERIF_DIR, "r02-cli-isolation", "run.py")


def run_all(mode, out):
    claude = os.path.join(_paths.TESTS_DIR, "fake_bin_" + mode, "claude")
    argv = [sys.executable, RUN, "all", "--cli", "claude", "--claude-bin", claude,
            "--profile", "claude-A-restricted-safe", "--profile", "claude-X-control-read-allowed",
            "--model-claude", "fake-model", "--confirm-test-account", "--repeat", "1", "--out", out,
            "--cancel-timeout", "2"]
    return subprocess.run(argv, capture_output=True, text=True, timeout=300)


@unittest.skipIf(sys.platform == "win32", "uses a POSIX shebang script as the fake binary")
class RunAllAgainstFakeTests(unittest.TestCase):
    def load(self, out):
        with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
            return {c["id"]: c for c in json.load(fh)["checks"]}

    def test_contained_fake_is_not_proven_because_the_control_never_fired_the_hook(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("contained", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            checks = self.load(out)
            self.assertEqual(checks["R02-C3:negative:claude-A-restricted-safe"]["verdict"], "INCONCLUSIVE")
            self.assertEqual(checks["R02-C3:hook:claude-A-restricted-safe"]["verdict"], "INCONCLUSIVE")
            self.assertFalse(checks["R02-C3:negative:claude-A-restricted-safe"]["data"]["automatic_use_allowed"])
            self.assertEqual(checks["R02-C3:sensitivity:claude-X-control-read-allowed"]["verdict"], "INCONCLUSIVE")
            self.assertEqual(checks["R02-C1:detect:claude"]["verdict"], "PASS")
            self.assertEqual(checks["R02-C3:cancel:selftest"]["verdict"], "PASS")
            self.assertEqual(checks["R02-C1:not-installed:claude"]["verdict"], "PASS")
            self.assertEqual(sorted(os.listdir(out)), ["result.json", "result.md"])

    def test_leaky_fake_is_blocked_and_control_proves_sensitivity(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("leaky", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            checks = self.load(out)
            neg = checks["R02-C3:negative:claude-A-restricted-safe"]
            self.assertEqual(neg["verdict"], "BLOCKED")
            self.assertEqual(neg["data"]["profile_verdict"], "BLOCKED")
            self.assertFalse(neg["data"]["automatic_use_allowed"])
            self.assertEqual(checks["R02-C3:sensitivity:claude-X-control-read-allowed"]["verdict"], "PASS")

    def test_result_files_contain_no_identifying_values(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("contained", out)
            for name in ("result.json", "result.md"):
                with open(os.path.join(out, name), encoding="utf-8") as fh:
                    self.assertEqual(Redactor().residual_literals(fh.read()), [], name)

    def test_negative_requires_test_account_confirmation(self):
        claude = os.path.join(_paths.TESTS_DIR, "fake_bin_contained", "claude")
        res = subprocess.run([sys.executable, RUN, "negative", "--cli", "claude", "--claude-bin", claude,
                              "--model-claude", "m"], capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 2)
        self.assertIn("--confirm-test-account", res.stderr)

    def test_relative_binary_path_still_works_inside_the_temp_cwd(self):
        with tempfile.TemporaryDirectory() as out:
            rel = os.path.relpath(os.path.join(_paths.TESTS_DIR, "fake_bin_contained", "claude"))
            res = subprocess.run([sys.executable, RUN, "positive", "--cli", "claude", "--claude-bin", rel,
                                  "--profile", "claude-A-restricted-safe", "--model-claude", "m", "--out", out],
                                 capture_output=True, text=True, timeout=120)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertEqual(self.load(out)["R02-C2:positive:claude-A-restricted-safe"]["verdict"], "PASS")

    def test_rerun_merges_into_one_result_file(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("contained", out)
            claude = os.path.join(_paths.TESTS_DIR, "fake_bin_contained", "claude")
            subprocess.run([sys.executable, RUN, "detect", "--cli", "claude", "--claude-bin", claude, "--out", out],
                           capture_output=True, text=True, timeout=60)
            ids = list(self.load(out))
            self.assertEqual(len(ids), len(set(ids)))
            self.assertIn("R02-C3:negative:claude-A-restricted-safe", ids)


if __name__ == "__main__":
    unittest.main()
