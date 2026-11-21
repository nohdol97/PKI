"""Tests for R02 profile loading and linting (spec R02-K1). Never run against a real CLI."""
import copy
import json
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

profiles = _paths.load_kit_module("r02-cli-isolation", "profiles.py", "r02_profiles")

FORBIDDEN_FLAGS = (
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions",
    "--dangerously-bypass-hook-trust", "--approve-for-me", "danger-full-access", "--search",
    "--add-dir", "--bare",
)


class ProfileFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = profiles.load_profiles()

    def test_every_argv_is_a_list_of_strings_starting_with_the_cli(self):
        for p in self.data["profiles"]:
            self.assertIsInstance(p["argv"], list, p["name"])
            self.assertTrue(all(isinstance(a, str) for a in p["argv"]), p["name"])
            self.assertEqual(p["argv"][0], p["cli"], p["name"])
            self.assertNotIn(p["argv"][0], ("sh", "bash", "cmd", "cmd.exe", "powershell", "pwsh"))

    def test_value_flags_are_always_followed_by_a_value(self):
        value_flags = self.data["value_flags"]
        all_flags = set(value_flags["claude"]) | set(value_flags["codex"]) | set(self.data["valueless_flags"])
        for p in self.data["profiles"]:
            argv = p["argv"]
            for i, token in enumerate(argv):
                if token in value_flags[p["cli"]]:
                    self.assertLess(i + 1, len(argv), "{}: {} has no value".format(p["name"], token))
                    nxt = argv[i + 1]
                    self.assertNotIn(nxt, all_flags, "{}: {} followed by flag {}".format(p["name"], token, nxt))
                    if nxt == "":
                        self.assertIn(token, self.data["empty_value_ok"], "{}: empty value for {}".format(p["name"], token))

    def test_placeholders_are_known(self):
        for p in self.data["profiles"]:
            rendered = profiles.render_argv(p, {k: "X" for k in profiles.PLACEHOLDERS})
            self.assertEqual(len(rendered), len(p["argv"]))
            self.assertFalse(any("{" in a and "}" in a and a.strip("{}") in profiles.PLACEHOLDERS for a in rendered))

    def test_no_dangerous_flags_anywhere_including_controls(self):
        for p in self.data["profiles"]:
            for token in p["argv"]:
                for bad in FORBIDDEN_FLAGS:
                    self.assertNotIn(bad, token, "{} contains {}".format(p["name"], bad))

    def test_contained_profiles_carry_the_isolation_flags(self):
        for p in self.data["profiles"]:
            if p["kind"] != "contained":
                continue
            argv = p["argv"]
            self.assertIn("--no-session-persistence" if p["cli"] == "claude" else "--ephemeral", argv, p["name"])
            if p["cli"] == "claude":
                self.assertEqual(argv[argv.index("--tools") + 1], "", p["name"])
                self.assertIn("--strict-mcp-config", argv, p["name"])
                self.assertIn("--disallowedTools", argv, p["name"])
                self.assertEqual(argv[argv.index("--output-format") + 1], "json", p["name"])
            else:
                self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only", p["name"])
                self.assertIn("--ignore-user-config", argv, p["name"])
                self.assertIn('web_search="disabled"', argv, p["name"])
                self.assertIn("features.shell_tool=false", argv, p["name"])
                self.assertIn("-C", argv, p["name"])

    def test_every_research_variant_is_a_named_profile_with_source_and_risks(self):
        names = {p["name"] for p in self.data["profiles"]}
        self.assertIn("claude-A-restricted-safe", names)
        self.assertIn("codex-A-full", names)
        for p in self.data["profiles"]:
            self.assertTrue(p["source"], p["name"])
            self.assertIn(p["kind"], ("contained", "control"))
        self.assertTrue(self.data["deferred"])

    def test_hook_planted_flag_matches_what_negative_py_plants(self):
        for p in self.data["profiles"]:
            self.assertEqual(p["hook_planted"], p["cli"] == "claude", p["name"])

    def test_results_allowlist_knows_every_profile_and_attack(self):
        from common import results
        negative = _paths.load_kit_module("r02-cli-isolation", "negative.py", "r02_negative_p")
        self.assertEqual(set(p["name"] for p in self.data["profiles"]), set(results.PROFILE_NAMES))
        self.assertEqual({a.id for a in negative.ATTACKS}, set(results.ATTACK_IDS))

    def test_every_profile_flag_is_in_the_results_allowlist(self):
        from common import results
        for p in self.data["profiles"]:
            for token in p["argv"][1:]:
                if token.startswith("-") and len(token) > 1:
                    self.assertIn(token, results.FLAG_WORDS, p["name"])

    def test_profile_names_unique(self):
        names = [p["name"] for p in self.data["profiles"]]
        self.assertEqual(len(names), len(set(names)))


class LintTests(unittest.TestCase):
    def setUp(self):
        self.good = profiles.load_profiles()

    def test_string_argv_rejected(self):
        bad = copy.deepcopy(self.good)
        bad["profiles"][0]["argv"] = "claude -p --tools ''"
        self.assertTrue(any("list" in e for e in profiles.lint_profiles(bad)))

    def test_flag_without_value_rejected(self):
        bad = copy.deepcopy(self.good)
        p = next(x for x in bad["profiles"] if x["cli"] == "claude")
        p["argv"] = p["argv"][:-1]  # drops the model value
        self.assertTrue(any("no value" in e for e in profiles.lint_profiles(bad)))

    def test_flag_followed_by_flag_rejected(self):
        bad = copy.deepcopy(self.good)
        p = next(x for x in bad["profiles"] if x["cli"] == "claude")
        i = p["argv"].index("--max-turns")
        p["argv"].pop(i + 1)
        self.assertTrue(profiles.lint_profiles(bad))

    def test_shell_interpreter_rejected(self):
        bad = copy.deepcopy(self.good)
        bad["profiles"][0]["argv"] = ["bash", "-c", "claude -p"]
        bad["profiles"][0]["cli"] = "bash"
        self.assertTrue(profiles.lint_profiles(bad))

    def test_unknown_placeholder_rejected(self):
        bad = copy.deepcopy(self.good)
        bad["profiles"][0]["argv"].append("{surprise}")
        self.assertTrue(any("placeholder" in e for e in profiles.lint_profiles(bad)))

    def test_load_raises_on_bad_file(self):
        import os
        import tempfile
        bad = copy.deepcopy(self.good)
        bad["profiles"][0]["argv"] = "claude -p"
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "p.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(bad, fh)
            with self.assertRaises(profiles.ProfileError):
                profiles.load_profiles(path)

    def test_render_is_element_wise_not_string_joined(self):
        p = {"name": "t", "cli": "claude", "kind": "contained", "source": "s", "argv": ["claude", "--json-schema", "{schema_json}"]}
        rendered = profiles.render_argv(p, {"schema_json": '{"a": "b c"}'})
        self.assertEqual(rendered, ["claude", "--json-schema", '{"a": "b c"}'])


if __name__ == "__main__":
    unittest.main()
