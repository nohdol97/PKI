"""Tests for common.redact. Written before the implementation (TDD).

Never executed against a real CLI/engine: pure string tests only.
"""
import getpass
import json
import unittest

try:
    from . import _paths  # noqa: F401
except ImportError:  # run directly from the tests directory
    import _paths  # noqa: F401
from common.redact import RedactionError, Redactor, environment_literals


class RedactTextTests(unittest.TestCase):
    def setUp(self):
        self.r = Redactor(literals={"WORKSTATION-77": "<HOST>"}, include_environment=False)

    def test_windows_user_path_hides_username(self):
        out = self.r.redact_text(r"opened C:\Users\alice.kim\AppData\Local\Temp\x1\out.json")
        self.assertNotIn("alice", out)
        self.assertIn("<HOME>", out)

    def test_windows_user_path_forward_slashes(self):
        out = self.r.redact_text("C:/Users/alice/Documents/a.txt")
        self.assertNotIn("alice", out)

    def test_posix_home_paths(self):
        for raw in ("/Users/bob/project/a", "/home/carol/.config/x", "/root/.cache"):
            out = self.r.redact_text("path " + raw)
            self.assertNotIn("bob", out)
            self.assertNotIn("carol", out)
            self.assertNotIn("/root/", out)

    def test_other_drive_paths_become_placeholder_but_system_dirs_stay(self):
        out = self.r.redact_text(r"D:\work\secret-project\src and C:\Program Files\Tool\t.exe")
        self.assertNotIn("secret-project", out)
        self.assertIn(r"C:\Program Files\Tool\t.exe", out)

    def test_unc_path(self):
        out = self.r.redact_text(r"copy \\fileserver01\share\docs\a.txt now")
        self.assertNotIn("fileserver01", out)

    def test_email(self):
        out = self.r.redact_text("login as alice@corp.example.com ok")
        self.assertNotIn("alice@", out)
        self.assertNotIn("corp.example.com", out)

    def test_ip_addresses_loopback_kept(self):
        out = self.r.redact_text("proxy 10.20.30.40 and 8.8.8.8 but 127.0.0.1:8080 stays")
        self.assertNotIn("10.20.30.40", out)
        self.assertNotIn("8.8.8.8", out)
        self.assertIn("127.0.0.1:8080", out)

    def test_url_hosts_redacted_but_loopback_kept(self):
        out = self.r.redact_text("GET https://internal.corp.example/path?q=1 and http://127.0.0.1:5000/x and http://localhost:1/y")
        self.assertNotIn("internal.corp.example", out)
        self.assertIn("http://127.0.0.1:5000/x", out)
        self.assertIn("http://localhost:1/y", out)

    def test_proxy_assignment(self):
        out = self.r.redact_text("HTTPS_PROXY=http://proxy.corp.example:8080 set")
        self.assertNotIn("proxy.corp.example", out)

    def test_secret_tokens(self):
        samples = [
            "sk-ant-api03-" + "A1b2C3d4" * 6,
            "ghp_" + "a1B2c3D4e5" * 4,
            "AKIA" + "ABCDEFGHIJKLMNOP",
            "xox" + "b-123456789012-abcdefABCDEF",
            "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTYifQ" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
            "Bear" + "er abcdefghijklmnop12345678",
        ]
        for s in samples:
            out = self.r.redact_text("tok " + s + " end")
            self.assertNotIn(s.split()[-1][:16], out, s)

    def test_key_value_secrets(self):
        out = self.r.redact_text("password=hunter2 api_key: abcd1234 token = zzz")
        self.assertNotIn("hunter2", out)
        self.assertNotIn("abcd1234", out)
        self.assertNotIn("zzz", out)

    def test_harmless_key_value_pairs_are_not_over_redacted(self):
        text = "auth=logged_in max_tokens=3 version=1.2.3 state: ok"
        self.assertEqual(self.r.redact_text(text), text)

    def test_literal_hostname_case_insensitive_and_bounded(self):
        out = self.r.redact_text("host workstation-77 failed; WORKSTATION-77.")
        self.assertNotIn("orkstation-77", out)
        self.assertEqual(out.count("<HOST>"), 2)

    def test_uuid_account_identifier(self):
        out = self.r.redact_text("account 123e4567-e89b-12d3-a456-426614174000 ok")
        self.assertNotIn("426614174000", out)

    def test_synthetic_canary_and_versions_survive(self):
        text = "canary CANARY-T1-7f3a9c ok version 2.1.330 sha " + "ab" * 32
        self.assertEqual(self.r.redact_text(text), text)

    def test_idempotent(self):
        raw = r"C:\Users\alice\x alice@corp.example.com 10.1.2.3 password=pw"
        once = self.r.redact_text(raw)
        self.assertEqual(self.r.redact_text(once), once)

    def test_redact_obj_nested_keeps_structure(self):
        obj = {"a": [r"C:\Users\alice\x", 3, None, True], "b": {"mail": "alice@corp.example.com"}}
        out = self.r.redact_obj(obj)
        dumped = json.dumps(out)
        self.assertNotIn("alice", dumped)
        self.assertEqual(out["a"][1:], [3, None, True])


class EnvironmentLiteralTests(unittest.TestCase):
    def test_real_username_is_masked_by_default(self):
        user = getpass.getuser()
        if len(user) < 3:
            self.skipTest("username too short to be a safe literal")
        out = Redactor().redact_text("hello from {} ok".format(user))
        self.assertNotIn(user, out)

    def test_environment_literals_have_placeholders(self):
        lits = environment_literals()
        self.assertTrue(all(isinstance(k, str) and isinstance(v, str) for k, v in lits.items()))
        self.assertTrue(all(len(k) >= 3 for k in lits))

    def test_assert_clean_raises_on_residual(self):
        r = Redactor(literals={"WORKSTATION-77": "<HOST>"}, include_environment=False)
        with self.assertRaises(RedactionError):
            r.assert_clean("prefixXWORKSTATION-77suffix")
        r.assert_clean("nothing here")

    def test_residual_found_even_inside_longer_word(self):
        r = Redactor(literals={"WORKSTATION-77": "<HOST>"}, include_environment=False)
        out = r.redact_text("xWORKSTATION-77y")
        self.assertEqual(r.residual_literals(out), ["WORKSTATION-77"])


if __name__ == "__main__":
    unittest.main()
