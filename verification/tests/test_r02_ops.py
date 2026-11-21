"""Tests for R02 detect/capabilities/cancel helpers (pure logic and harmless processes only)."""
import sys
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

ops = _paths.load_kit_module("r02-cli-isolation", "cli_ops.py", "r02_ops")
profiles = _paths.load_kit_module("r02-cli-isolation", "profiles.py", "r02_profiles2")


class AuthClassificationTests(unittest.TestCase):
    # Fixture phrases are illustrative (NOT observed output): the real phrasing must be confirmed on site.
    def test_logged_in_phrases(self):
        for text in ("Logged in using ChatGPT", "Authenticated as a user", "You are signed in"):
            self.assertEqual(ops.classify_auth(text, 0), "logged_in", text)

    def test_not_logged_in_phrases_win_over_logged_in_substring(self):
        for text in ("Not logged in", "You are not logged in. Run login.", "Logged out", "not authenticated"):
            self.assertEqual(ops.classify_auth(text, 1), "not_logged_in", text)

    def test_unknown(self):
        self.assertEqual(ops.classify_auth("", 1), "unknown")
        self.assertEqual(ops.classify_auth("weird output", 0), "unknown")


class CapabilityTests(unittest.TestCase):
    HELP = "Options:\n  -p, --print\n  --output-format <f>\n  --tools <t>\n  --strict-mcp-config\n"

    def test_flag_presence_is_word_bounded(self):
        self.assertTrue(ops.flag_in_help("--tools", self.HELP))
        self.assertFalse(ops.flag_in_help("--tool", self.HELP))
        self.assertFalse(ops.flag_in_help("--json-schema", self.HELP))

    def test_profile_flags_exclude_values_and_stdin_dash(self):
        data = profiles.load_profiles()
        p = next(x for x in data["profiles"] if x["name"] == "codex-A-full")
        flags = ops.flags_of_profile(p)
        self.assertIn("--sandbox", flags)
        self.assertIn("-C", flags)
        self.assertNotIn("-", flags)
        self.assertNotIn("read-only", flags)

    def test_config_keys_are_reported_as_not_checkable(self):
        data = profiles.load_profiles()
        p = next(x for x in data["profiles"] if x["name"] == "codex-A-full")
        self.assertIn("features.shell_tool=false", ops.config_keys_of_profile(p))

    def test_matrix_marks_missing_flags(self):
        data = profiles.load_profiles()
        p = next(x for x in data["profiles"] if x["name"] == "claude-A-restricted-safe")
        row = ops.profile_flag_row(p, self.HELP)
        self.assertIn("--restricted", row["missing"])
        self.assertIn("--tools", row["present"])


class BinaryTests(unittest.TestCase):
    def test_missing_binary_found_none_with_empty_path(self):
        self.assertIsNone(ops.find_binary("claude", path_env=""))

    def test_override_must_exist(self):
        self.assertIsNone(ops.find_binary("claude", override="/definitely/not/here"))
        self.assertEqual(ops.find_binary("claude", override=sys.executable), sys.executable)

    def test_not_installed_probe_reports_not_found(self):
        res = ops.not_installed_probe("claude")
        self.assertTrue(res["reproduced"])


class TreeKillSelfTest(unittest.TestCase):
    def test_selftest_passes_with_harmless_children(self):
        res = ops.tree_kill_selftest(timeout_s=1.5)
        self.assertTrue(res["passed"], res)
        self.assertTrue(res["grandchild_found"])


if __name__ == "__main__":
    unittest.main()
