"""Tests for common.runner. Never executed against a real CLI/engine.

Uses only harmless child processes: python3 -c "import time; time.sleep(60)" and a
parent/grandchild pair to prove whole-tree termination.
"""
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

try:
    from . import _paths  # noqa: F401
except ImportError:  # run directly from the tests directory
    import _paths  # noqa: F401
from common import runner

SLEEP_ARGV = [sys.executable, "-c", "import time; time.sleep(60)"]

TREE_PARENT = (
    "import subprocess, sys, time\n"
    "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "open(sys.argv[1], 'w').write(str(child.pid))\n"
    "time.sleep(60)\n"
)


def wait_dead(pid, seconds=5.0):
    end = time.time() + seconds
    while time.time() < end:
        if not runner.pid_alive(pid):
            return True
        time.sleep(0.05)
    return not runner.pid_alive(pid)


class ArgvValidationTests(unittest.TestCase):
    def test_string_argv_rejected(self):
        with self.assertRaises(TypeError):
            runner.run_process("python3 -c 'print(1)'", timeout_s=5)

    def test_non_string_element_rejected(self):
        with self.assertRaises(TypeError):
            runner.run_process([sys.executable, 3], timeout_s=5)

    def test_empty_argv_rejected(self):
        with self.assertRaises(ValueError):
            runner.run_process([], timeout_s=5)

    def test_shell_metacharacters_are_passed_literally(self):
        arg = "a; touch SHOULD_NOT_EXIST && echo $HOME `id`"
        with tempfile.TemporaryDirectory() as d:
            res = runner.run_process(
                [sys.executable, "-c", "import sys; print(sys.argv[1])", arg], cwd=d, timeout_s=15)
            self.assertEqual(res.stdout.strip(), arg)
            self.assertFalse(os.path.exists(os.path.join(d, "SHOULD_NOT_EXIST")))

    def test_empty_string_element_preserved(self):
        res = runner.run_process(
            [sys.executable, "-c", "import sys; print(repr(sys.argv[1:]))", "--tools", ""], timeout_s=15)
        self.assertEqual(res.stdout.strip(), "['--tools', '']")


class RunTests(unittest.TestCase):
    def test_stdout_stderr_exit_code_and_stdin(self):
        code = "import sys; d=sys.stdin.read(); print('in:'+d); print('err', file=sys.stderr); sys.exit(3)"
        res = runner.run_process([sys.executable, "-c", code], stdin_text="hello", timeout_s=15)
        self.assertEqual(res.returncode, 3)
        self.assertIn("in:hello", res.stdout)
        self.assertIn("err", res.stderr)
        self.assertFalse(res.timed_out)

    def test_missing_binary_reported_not_raised(self):
        res = runner.run_process(["definitely-not-a-real-binary-xyz"], timeout_s=5)
        self.assertEqual(res.error, "not_found")
        self.assertIsNone(res.returncode)

    def test_output_cap(self):
        res = runner.run_process(
            [sys.executable, "-c", "print('x'*100000)"], timeout_s=15, max_output_bytes=1000)
        self.assertLessEqual(len(res.stdout), 1100)
        self.assertTrue(res.output_truncated)


class TimeoutAndTreeKillTests(unittest.TestCase):
    def test_timeout_kills_harmless_sleeper(self):
        started = time.time()
        res = runner.run_process(SLEEP_ARGV, timeout_s=1.0)
        self.assertTrue(res.timed_out)
        self.assertLess(time.time() - started, 15)
        self.assertIsNotNone(res.pid)
        self.assertTrue(wait_dead(res.pid))

    def test_timeout_kills_grandchild_too(self):
        with tempfile.TemporaryDirectory() as d:
            pidfile = os.path.join(d, "grandchild.pid")
            res = runner.run_process([sys.executable, "-c", TREE_PARENT, pidfile], cwd=d, timeout_s=2.0)
            self.assertTrue(res.timed_out)
            with open(pidfile) as fh:
                grandchild = int(fh.read())
            self.assertTrue(wait_dead(res.pid), "parent still alive")
            self.assertTrue(wait_dead(grandchild), "grandchild survived tree kill (orphan)")

    def test_kill_tree_function_on_running_process(self):
        import subprocess
        proc = subprocess.Popen(SLEEP_ARGV, **runner.popen_group_kwargs())
        try:
            self.assertTrue(runner.pid_alive(proc.pid))
            runner.kill_tree(proc)
            proc.wait(timeout=10)
        finally:
            if proc.poll() is None:
                proc.kill()
        self.assertTrue(wait_dead(proc.pid))

    def test_taskkill_argv_for_windows_branch(self):
        self.assertEqual(runner.taskkill_argv(1234), ["taskkill", "/PID", "1234", "/T", "/F"])

    def test_descendants_listed_for_live_tree(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            pidfile = os.path.join(d, "g.pid")
            proc = subprocess.Popen([sys.executable, "-c", TREE_PARENT, pidfile], **runner.popen_group_kwargs())
            try:
                end = time.time() + 10
                while not os.path.exists(pidfile) and time.time() < end:
                    time.sleep(0.05)
                time.sleep(0.2)
                with open(pidfile) as fh:
                    grandchild = int(fh.read())
                self.assertIn(grandchild, runner.list_descendants(proc.pid))
            finally:
                runner.kill_tree(proc)
                proc.wait(timeout=10)


class SamplingTests(unittest.TestCase):
    def test_peak_rss_sampled_for_child(self):
        code = "import time; x = bytearray(40 * 1024 * 1024); time.sleep(1.2)"
        res = runner.run_process([sys.executable, "-c", code], timeout_s=20, sample_interval_s=0.2)
        self.assertEqual(res.returncode, 0)
        self.assertGreater(res.peak_rss_bytes, 20 * 1024 * 1024)
        self.assertGreaterEqual(res.peak_process_count, 1)

    def test_no_sampling_by_default(self):
        res = runner.run_process([sys.executable, "-c", "print(1)"], timeout_s=20)
        self.assertEqual(res.peak_rss_bytes, 0)


class EnvTests(unittest.TestCase):
    def test_scrubbed_env_drops_secrets_and_keeps_path(self):
        fake = {"PATH": "/usr/bin", "HOME": "/h", "ANTHROPIC_API_KEY": "x", "OPENAI_API_KEY": "y",
                "CODEX_API_KEY": "z", "AWS_SECRET_ACCESS_KEY": "q", "HTTPS_PROXY": "http://p:1", "RANDOM_VAR": "r"}
        with mock.patch.dict(os.environ, fake, clear=True):
            env = runner.build_env()
        self.assertEqual(env.get("PATH"), "/usr/bin")
        for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "AWS_SECRET_ACCESS_KEY",
                     "HTTPS_PROXY", "RANDOM_VAR"):
            self.assertNotIn(name, env)

    def test_proxy_and_ca_variables_are_dropped_by_default_and_passed_only_by_opt_in(self):
        fake = {"PATH": "/usr/bin", "HTTPS_PROXY": "http://p:1", "NODE_EXTRA_CA_CERTS": "/ca.pem"}
        try:
            with mock.patch.dict(os.environ, fake, clear=True):
                self.assertNotIn("HTTPS_PROXY", runner.build_env())
                runner.set_passthrough(["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"])
                env = runner.build_env()
            self.assertEqual(env["HTTPS_PROXY"], "http://p:1")
            self.assertEqual(runner.passthrough_names(), ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"])
        finally:
            runner.set_passthrough([])

    def test_passthrough_refuses_credential_variables(self):
        for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "HF_TOKEN", "PATHEXT2"):
            with self.assertRaises(ValueError):
                runner.set_passthrough([name])

    def test_extra_env_added(self):
        with mock.patch.dict(os.environ, {"PATH": "/usr/bin"}, clear=True):
            env = runner.build_env({"CLAUDE_CODE_SUBPROCESS_ENV_SCRUB": "1", "PKI_CANARY_ENV": "tok"})
        self.assertEqual(env["CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"], "1")

    def test_extra_env_with_forbidden_prefix_rejected(self):
        for name in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"):
            with self.assertRaises(ValueError, msg=name):
                runner.build_env({name: "v"})

    def test_env_passed_to_child_is_exactly_scrubbed(self):
        with mock.patch.dict(os.environ, {"PATH": os.environ.get("PATH", ""), "SECRET_THING": "s"}, clear=False):
            res = runner.run_process(
                [sys.executable, "-c", "import os; print('SECRET_THING' in os.environ)"], timeout_s=15)
        self.assertEqual(res.stdout.strip(), "False")


class CmdShimGuardTests(unittest.TestCase):
    def test_exe_is_fine(self):
        self.assertIsNone(runner.cmd_shim_problem(r"C:\tools\claude.exe", ["--json-schema", '{"a":1}']))

    def test_cmd_shim_with_quotes_flagged(self):
        self.assertIsNotNone(runner.cmd_shim_problem(r"C:\npm\codex.cmd", ["-c", 'web_search="disabled"']))

    def test_cmd_shim_with_plain_args_ok(self):
        self.assertIsNone(runner.cmd_shim_problem(r"C:\npm\codex.cmd", ["exec", "--ephemeral"]))


if __name__ == "__main__":
    unittest.main()
