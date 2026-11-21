"""End-to-end test of r02 run.py real-mode code paths against a FAKE `claude` executable (POSIX only).

Never a real CLI. Exercises detect/capabilities/positive/negative/cancel/not-installed/not-logged-in, result merging,
the allowlisted pasteable result and the local raw/ folder through the actual entry point.
"""
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

from common import results
from common.redact import Redactor

run_mod = _paths.load_kit_module("r02-cli-isolation", "run.py", "r02_run_entry")
RUN = os.path.join(_paths.VERIF_DIR, "r02-cli-isolation", "run.py")
CONTAINED_PROFILE, CONTROL_PROFILE = "claude-A-restricted-safe", "claude-X-control-read-allowed"


def fake_bin(mode):
    return os.path.join(_paths.TESTS_DIR, "fake_bin_" + mode, "claude")


def run_all(mode, out, profiles=(CONTAINED_PROFILE, CONTROL_PROFILE), extra=()):
    argv = [sys.executable, RUN, "all", "--cli", "claude", "--claude-bin", fake_bin(mode), "--model-claude", "fake-model",
            "--confirm-test-account", "--repeat", "1", "--out", out, "--cancel-timeout", "2"]
    for p in profiles:
        argv += ["--profile", p]
    return subprocess.run(argv + list(extra), capture_output=True, text=True, timeout=300)


def load(out):
    with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    return data, {c["id"]: c for c in data["checks"]}


def default_args():
    return dict(cli="both", profile=None, include_controls=False, claude_bin=None, codex_bin=None, model_claude="m", model_codex="m",
                timeout=30.0, repeat=1, user_canary_token=[], redact=[], out="x", dry_run=False, pass_env=[], cancel_timeout=2.0,
                confirm_test_account=True)


@unittest.skipIf(sys.platform == "win32", "uses a POSIX shebang script as the fake binary")
class RunAllAgainstFakeTests(unittest.TestCase):
    def test_contained_fake_without_a_hook_firing_control_is_not_proven(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("contained", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["verdict"], "INCONCLUSIVE")
            self.assertFalse(neg["facts"]["automatic_use_allowed"])
            self.assertEqual(checks["R02-C3:hook:" + CONTAINED_PROFILE]["verdict"], "INCONCLUSIVE")
            self.assertEqual(checks["R02-control:sensitivity:" + CONTROL_PROFILE]["verdict"], "INCONCLUSIVE")
            self.assertEqual(checks["R02-C1:detect:claude"]["verdict"], "PASS")
            self.assertEqual(checks["R02-C3:cancel:selftest"]["verdict"], "PASS")
            self.assertEqual(checks["R02-C1:not-installed:claude"]["verdict"], "PASS")
            self.assertEqual(checks["R02-C3:detector-selftest"]["verdict"], "PASS")
            self.assertEqual(sorted(os.listdir(out)), ["raw", "result.json", "result.md"])

    def test_contained_profile_with_a_full_same_cli_control_passes_end_to_end(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("split", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["verdict"], "PASS", neg["facts"])
            self.assertEqual(neg["facts"]["profile_verdict"], "CONTAINED_ON_OBSERVABLES")
            self.assertTrue(neg["facts"]["automatic_use_allowed"])
            self.assertEqual(neg["facts"]["control_gaps"], [])
            self.assertEqual(checks["R02-C3:hook:" + CONTAINED_PROFILE]["verdict"], "PASS")
            self.assertEqual(neg["facts"]["advisory_runs_not_counted"], 1)
            self.assertNotIn("R02-C3:negative:" + CONTROL_PROFILE, checks)

    def test_a_failing_detector_selftest_blocks_the_contained_verdict(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as out:
            args = types.SimpleNamespace(**dict(default_args(), claude_bin=fake_bin("split"), out=out, cli="claude",
                                                profile=[CONTAINED_PROFILE, CONTROL_PROFILE]))
            b = run_mod.new_builder(args)
            with mock.patch.object(run_mod.negative, "detector_selftest", return_value=(False, {"marker_detector": False})):
                run_mod.do_negative(args, b, run_mod.profiles_mod.load_profiles())
            checks = {c["id"]: c for c in b.build()["checks"]}
            self.assertEqual(checks["R02-C3:detector-selftest"]["verdict"], "FAIL")
            self.assertEqual(checks["R02-C3:negative:" + CONTAINED_PROFILE]["verdict"], "INCONCLUSIVE")
            self.assertFalse(checks["R02-C3:negative:" + CONTAINED_PROFILE]["facts"]["automatic_use_allowed"])

    def test_a_failed_positive_call_keeps_the_negative_verdict_unproven_even_with_a_full_control(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("mixed", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            _data, checks = load(out)
            self.assertEqual(checks["R02-C2:positive:" + CONTAINED_PROFILE]["verdict"], "FAIL")
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["facts"]["counts"]["CONTAINED"], len([a for a in run_mod.negative.ATTACKS if a.decisive]))
            self.assertEqual(neg["facts"]["control_gaps"], [])
            self.assertEqual(neg["verdict"], "INCONCLUSIVE")
            self.assertFalse(neg["facts"]["automatic_use_allowed"])

    def test_truncated_output_with_the_canary_past_the_cap_is_never_reported_contained(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("bigstderr", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertNotEqual(neg["verdict"], "PASS")
            self.assertFalse(neg["facts"]["automatic_use_allowed"])
            self.assertGreater(neg["facts"]["truncated_runs"], 0)
            self.assertIn("output_truncated", neg["codes"])

    def test_prerelease_cli_version_is_recorded_and_the_run_is_not_lost(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("alpha", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            data, checks = load(out)
            self.assertEqual(checks["R02-C1:detect:claude"]["facts"]["version"], "0.156.0-alpha.3")
            self.assertEqual(data["environment"]["claude_version"], "0.156.0-alpha.3")
            self.assertNotIn("result-write", checks)
            self.assertNotIn("version_unrecognized", data["notes"])

    def test_garbage_cli_version_becomes_unknown_with_a_note_and_nothing_is_lost(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("garbage", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            data, checks = load(out)
            self.assertEqual(checks["R02-C1:detect:claude"]["facts"]["version"], "unknown")
            self.assertIn("version_unrecognized", data["notes"])
            self.assertNotIn("result-write", checks)
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                self.assertNotIn("kimminsu", fh.read())
            with open(os.path.join(out, "raw", "detect_version_claude.txt"), encoding="utf-8") as fh:
                self.assertIn("kimminsu", fh.read())

    def test_an_advisory_leak_on_the_web_search_document_still_blocks_the_profile(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("splita6", out)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["verdict"], "BLOCKED")
            self.assertEqual(neg["facts"]["attack_status"]["A6-web-search"], "LEAKED")

    def test_every_c3_result_carries_the_undetected_canary_forms_caveat(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("split", out)
            _data, checks = load(out)
            c3 = [c for cid, c in checks.items() if cid.startswith("R02-C3:")]
            self.assertTrue(c3)
            for c in c3:
                self.assertIn("caveat_undetected_canary_forms", c["codes"], c["id"])
            self.assertIn("first 7 characters", results.CODES["caveat_undetected_canary_forms"])

    def test_a_failed_validation_still_keeps_the_run_and_exits_with_5(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("split", out, extra=["--redact", "etec"])  # sits inside a harness word: the redaction check refuses
            self.assertEqual(res.returncode, 5, res.stdout + res.stderr)
            data, checks = load(out)
            self.assertEqual(list(checks), ["result-write"])
            self.assertEqual(checks["result-write"]["verdict"], "INCONCLUSIVE")
            self.assertTrue(os.path.exists(os.path.join(out, "raw", "validation_failure.txt")))
            self.assertTrue(os.path.exists(os.path.join(out, "raw", "negative_" + CONTAINED_PROFILE + ".txt")))

    def test_cancel_never_picks_a_control_profile(self):
        with tempfile.TemporaryDirectory() as out:
            args = types.SimpleNamespace(**dict(default_args(), claude_bin=fake_bin("split"), out=out, cli="claude", profile=[CONTROL_PROFILE], repeat=1))
            b = run_mod.new_builder(args)
            run_mod.do_cancel(args, b, run_mod.profiles_mod.load_profiles())
            checks = {c["id"]: c for c in b.build()["checks"]}
            self.assertEqual(checks["R02-C3:cancel:claude"]["verdict"], "INCONCLUSIVE")
            self.assertIn("binary_missing_for_profile", checks["R02-C3:cancel:claude"]["codes"])

    def test_controls_never_get_c2_or_c3_verdict_rows(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("contained", out)
            _data, checks = load(out)
            for cid in checks:
                if cid.startswith("R02-C"):
                    self.assertNotIn(CONTROL_PROFILE, cid)
            self.assertIn("R02-control:positive:" + CONTROL_PROFILE, checks)
            self.assertNotIn("R02-C3:negative:" + CONTROL_PROFILE, checks)
            self.assertNotIn("R02-C3:hook:" + CONTROL_PROFILE, checks)
            self.assertNotIn("R02-C2:positive:" + CONTROL_PROFILE, checks)

    def test_leaky_fake_is_blocked_and_control_proves_sensitivity(self):
        with tempfile.TemporaryDirectory() as out:
            res = run_all("leaky", out)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["verdict"], "BLOCKED")
            self.assertEqual(neg["facts"]["profile_verdict"], "BLOCKED")
            self.assertFalse(neg["facts"]["automatic_use_allowed"])
            self.assertEqual(checks["R02-C3:hook:" + CONTAINED_PROFILE]["verdict"], "BLOCKED")  # hook leak is never mapped to PASS
            self.assertEqual(checks["R02-control:sensitivity:" + CONTROL_PROFILE]["verdict"], "PASS")

    def test_one_negative_row_per_profile_with_exactly_attacks_times_repeat_runs(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("leaky", out)
            _data, checks = load(out)
            neg = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertEqual(neg["facts"]["runs"], len(run_mod.negative.ATTACKS))
            ctl = checks["R02-control:sensitivity:" + CONTROL_PROFILE]
            self.assertEqual(ctl["facts"]["runs"], len(run_mod.negative.CONTROL_ATTACKS))

    def test_pasteable_result_is_allowlisted_and_clean(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("leaky", out)
            data, _checks = load(out)
            self.assertEqual(results.validate_result(data), [])
            for name in ("result.json", "result.md"):
                with open(os.path.join(out, name), encoding="utf-8") as fh:
                    text = fh.read()
                self.assertEqual(Redactor().residual_literals(text), [], name)
                self.assertNotIn("Logged in using a fake account", text)
                self.assertNotIn("CANARY", text)
            self.assertTrue(os.path.isdir(os.path.join(out, "raw")))

    def test_failed_positive_stdout_stderr_stay_in_raw_only(self):
        with tempfile.TemporaryDirectory() as out:
            subprocess.run([sys.executable, RUN, "positive", "--cli", "claude", "--claude-bin", fake_bin("crash"), "--profile", CONTAINED_PROFILE,
                            "--model-claude", "m", "--out", out], capture_output=True, text=True, timeout=120)
            _data, checks = load(out)
            self.assertEqual(checks["R02-C2:positive:" + CONTAINED_PROFILE]["verdict"], "FAIL")
            self.assertEqual(set(checks["R02-C2:positive:" + CONTAINED_PROFILE]["facts"]) - {"installed", "ok", "exit_code", "timed_out", "schema_error_count", "duration_s", "auth_hint"}, set())

    def test_missing_binary_for_a_contained_profile_emits_an_inconclusive_negative_row(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("contained", out, extra=["--claude-bin", "/definitely/not/here/claude"])
            _data, checks = load(out)
            self.assertEqual(checks["R02-C3:negative:" + CONTAINED_PROFILE]["verdict"], "INCONCLUSIVE")
            self.assertIn("binary_missing_for_profile", checks["R02-C3:negative:" + CONTAINED_PROFILE]["codes"])

    def test_negative_requires_test_account_confirmation(self):
        res = subprocess.run([sys.executable, RUN, "negative", "--cli", "claude", "--claude-bin", fake_bin("contained"), "--model-claude", "m"],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 2)
        self.assertIn("--confirm-test-account", res.stderr)

    def test_relative_binary_path_still_works_inside_the_temp_cwd(self):
        with tempfile.TemporaryDirectory() as out:
            rel = os.path.relpath(fake_bin("contained"))
            res = subprocess.run([sys.executable, RUN, "positive", "--cli", "claude", "--claude-bin", rel, "--profile", CONTAINED_PROFILE,
                                  "--model-claude", "m", "--out", out], capture_output=True, text=True, timeout=120)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            self.assertEqual(load(out)[1]["R02-C2:positive:" + CONTAINED_PROFILE]["verdict"], "PASS")

    def test_rerun_merges_into_one_result_file(self):
        with tempfile.TemporaryDirectory() as out:
            run_all("contained", out)
            subprocess.run([sys.executable, RUN, "detect", "--cli", "claude", "--claude-bin", fake_bin("contained"), "--out", out],
                           capture_output=True, text=True, timeout=60)
            ids = list(load(out)[1])
            self.assertEqual(len(ids), len(set(ids)))
            self.assertIn("R02-C3:negative:" + CONTAINED_PROFILE, ids)

    def test_pass_env_is_recorded_by_name_only(self):
        with tempfile.TemporaryDirectory() as out:
            env = dict(os.environ, HTTPS_PROXY="http://proxy.corp.acme.co.kr:3128")
            res = subprocess.run([sys.executable, RUN, "detect", "--cli", "claude", "--claude-bin", fake_bin("contained"), "--out", out,
                                  "--pass-env", "HTTPS_PROXY"], capture_output=True, text=True, timeout=60, env=env)
            self.assertEqual(res.returncode, 0, res.stderr)
            data, _ = load(out)
            self.assertEqual(data["environment"]["passed_env_names"], ["HTTPS_PROXY"])
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                self.assertNotIn("acme", fh.read())

    def test_pass_env_refuses_credential_names(self):
        res = subprocess.run([sys.executable, RUN, "detect", "--pass-env", "ANTHROPIC_API_KEY"], capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 2)


@unittest.skipIf(sys.platform == "win32", "POSIX only")
class RunHelperTests(unittest.TestCase):
    def args(self, **kw):
        base = dict(cli="both", profile=None, include_controls=False, claude_bin=None, codex_bin=None, model_claude="m", model_codex="m",
                    timeout=30.0, repeat=1, user_canary_token=[], redact=[], out="x", dry_run=False, pass_env=[], cancel_timeout=2.0, confirm_test_account=True)
        base.update(kw)
        return types.SimpleNamespace(**base)

    def test_controls_are_not_selected_by_default(self):
        data = run_mod.profiles_mod.load_profiles()
        names = [p["name"] for p in run_mod.selected_profiles(self.args(), data)]
        self.assertFalse(any("control" in n for n in names))
        self.assertTrue(any("control" in p["name"] for p in run_mod.selected_profiles(self.args(include_controls=True), data)))

    def test_control_verdicts_of_another_cli_never_count(self):
        by_cli = {"codex": ["codex-control-verdicts"]}
        self.assertIsNone(run_mod.controls_for(by_cli, "claude"))
        self.assertEqual(run_mod.controls_for(by_cli, "codex"), ["codex-control-verdicts"])

    def test_positive_run_rejects_schema_violations(self):
        data = run_mod.profiles_mod.load_profiles()
        profile = dict(run_mod.profiles_mod.get_profile(data, CONTAINED_PROFILE))
        for mode, expected in (("contained", True), ("extrafield", False), ("iserror", False), ("exit1-valid", False)):
            args = self.args(claude_bin=fake_bin("contained"))
            profile["env_set"] = {"FAKE_CLI_MODE": mode}
            ok, _facts, _raw = run_mod.positive_run(args, profile)
            self.assertEqual(ok, expected, mode)

    def test_a_temp_folder_that_cannot_be_deleted_is_recorded_not_fatal(self):
        import shutil
        from unittest import mock
        real_rmtree = shutil.rmtree
        left = []

        def selective(path, *a, **kw):
            if os.path.basename(path).startswith("r02neg-"):
                left.append(path)  # simulate a leaked handle: the negative work root cannot be removed
                return None
            return real_rmtree(path, *a, **kw)

        with tempfile.TemporaryDirectory() as out:
            args = self.args(claude_bin=fake_bin("leaky"), out=out, profile=[CONTAINED_PROFILE], repeat=1)
            b = run_mod.new_builder(args)
            data = run_mod.profiles_mod.load_profiles()
            with mock.patch.object(run_mod.shutil, "rmtree", selective):
                run_mod.do_negative(args, b, data)  # must not raise
            checks = {c["id"]: c for c in b.build()["checks"]}
            row = checks["R02-C3:negative:" + CONTAINED_PROFILE]
            self.assertGreaterEqual(row["facts"]["cleanup_failed"], 1)
            self.assertIn("cleanup_failed_possible_handle_leak", row["codes"])
        for path in left:
            real_rmtree(path, ignore_errors=True)

    def test_cancel_with_zero_runs_is_inconclusive_never_pass(self):
        with tempfile.TemporaryDirectory() as out:
            args = self.args(claude_bin=fake_bin("contained"), out=out, repeat=0, cli="claude")
            b = run_mod.new_builder(args)
            run_mod.do_cancel(args, b, run_mod.profiles_mod.load_profiles())
            checks = {c["id"]: c for c in b.build()["checks"]}
            self.assertEqual(checks["R02-C3:cancel:claude"]["verdict"], "INCONCLUSIVE")

    def test_worst_status_ordering(self):
        self.assertEqual(run_mod.worst(["CONTAINED", "LEAKED", "INCONCLUSIVE"]), "LEAKED")
        self.assertEqual(run_mod.worst(["CONTAINED", "INCONCLUSIVE"]), "INCONCLUSIVE")
        self.assertEqual(run_mod.worst(["CONTAINED"]), "CONTAINED")


if __name__ == "__main__":
    unittest.main()
