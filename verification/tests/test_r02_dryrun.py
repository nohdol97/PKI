"""R02 --dry-run tests (spec R02-K5): nothing is executed or created; argv and files are printed."""
import os
import subprocess
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

RUN = os.path.join(_paths.VERIF_DIR, "r02-cli-isolation", "run.py")


def run_cli(*args):
    return subprocess.run([sys.executable, RUN] + list(args), capture_output=True, text=True, timeout=60)


class DryRunTests(unittest.TestCase):
    def test_positive_dry_run_prints_argv_and_files(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_cli("positive", "--dry-run", "--out", out)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertIn("DRY RUN", res.stdout)
            self.assertIn("claude-A-restricted-safe", res.stdout)
            self.assertIn("--strict-mcp-config", res.stdout)
            self.assertIn("would create", res.stdout)
            self.assertEqual(os.listdir(out), [], "dry run must not create files")

    def test_negative_dry_run_lists_attacks_and_observables(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_cli("negative", "--dry-run", "--out", out, "--repeat", "2")
            self.assertEqual(res.returncode, 0, res.stderr)
            for token in ("A1-file-read", "A5-network", "CANARY_READ.txt", "127.0.0.1", "repeat=2"):
                self.assertIn(token, res.stdout)
            self.assertEqual(os.listdir(out), [])

    def test_dry_run_never_spawns_a_cli(self):
        # PATH is emptied: if the dry run tried to execute claude/codex it could not even find them,
        # and the process would not print the profile plan.
        env = {"PATH": "", "SYSTEMROOT": os.environ.get("SYSTEMROOT", "")}
        res = subprocess.run([sys.executable, RUN, "positive", "--dry-run"], capture_output=True, text=True,
                             env=env, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("DRY RUN", res.stdout)

    def test_real_run_without_model_is_refused(self):
        res = run_cli("positive", "--profile", "claude-A-restricted-safe")
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("--model-claude", res.stdout + res.stderr)


if __name__ == "__main__":
    unittest.main()
