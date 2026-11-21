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

    def test_every_drive_path_becomes_a_placeholder_including_program_files(self):
        out = self.r.redact_text(r"D:\work\secret-project\src and C:\Program Files\AcmeCorp SecretAgent\agent.exe")
        self.assertNotIn("secret-project", out)
        self.assertNotIn("AcmeCorp", out)

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
        out = self.r.redact_text("GET https://internal.corp.example/display/SECRET/Plan?user=kim.minsu and http://127.0.0.1:5000/x and http://localhost:1/y")
        self.assertNotIn("internal.corp.example", out)
        self.assertNotIn("SECRET", out)
        self.assertNotIn("kim.minsu", out)
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
        text = "auth=logged_in count=3 version=1.2.3 state: ok"
        self.assertEqual(self.r.redact_text(text), text)

    def test_literal_hostname_case_insensitive_and_bounded(self):
        out = self.r.redact_text("host workstation-77 failed; WORKSTATION-77.")
        self.assertNotIn("orkstation-77", out)
        self.assertEqual(out.count("<HOST>"), 2)

    def test_uuid_account_identifier(self):
        out = self.r.redact_text("account 123e4567-e89b-12d3-a456-426614174000 ok")
        self.assertNotIn("426614174000", out)

    def test_synthetic_canary_and_versions_survive(self):
        text = "canary CANARY-T1-7f3a9c ok version 2.1.330 hash h:0123456789ab 2026-11-21T10:12:00Z"
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


class ReviewerLeakCaseTests(unittest.TestCase):
    """Every leak form the independent review (R1-R6) verified against the first redactor."""

    def setUp(self):
        self.r = Redactor(literals={"WORKSTATION-77": "<HOST>"}, include_environment=False)

    def gone(self, raw, *needles):
        out = self.r.redact_text(raw)
        for n in needles:
            self.assertNotIn(n, out, (raw, out))

    def test_json_quoted_secrets(self):
        self.gone('{"api_key": "zzz-live-123456789"}', "zzz-live")
        self.gone('{"password": "p4ssw0rd-xyz"}', "p4ssw0rd")
        self.gone('{"access_token": "ya29.A0ARrdaM-abc", "refresh_token": "1//0gXYZsecretvalue"}', "ya29", "secretvalue")

    def test_key_names_that_contain_a_secret_word(self):
        self.gone("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtnFEMI")
        self.gone("client_secret=GOCSPX-abcdefghijklmnop", "GOCSPX")
        self.gone("x-api-token: abc123def456", "abc123def456")

    def test_authorization_headers_consume_the_credential(self):
        self.gone("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA")
        self.gone("Authorization: Bearer abcdef0123456789", "abcdef0123456789")
        self.gone("Proxy-Authorization: Basic Zm9vOmJhcg==", "Zm9vOmJhcg")

    def test_cookies(self):
        self.gone("Cookie: sessionid=abc123XYZ; csrftoken=qq99", "abc123XYZ", "qq99")
        self.gone("Set-Cookie: SID=topsecretvalue; Path=/", "topsecretvalue")

    def test_google_key_pem_and_long_hex(self):
        self.gone("key=AI" + "zaSyA1234567890abcdefghijklmnopqrstu", "zaSyA1234567890")
        self.gone("-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA " + "PRIVATE KEY-----", "MIIEowIBAAKCAQEAxyz")
        self.gone("secretkey " + "ab12" * 16, "ab12ab12ab12")
        self.gone("sk-short123", "short123")

    def test_aws_secret_after_akia_id(self):
        self.gone("AK" + "IA" + "ABCDEFGHIJKLMNOP" + " wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "ABCDEFGHIJKLMNOP")

    def test_bare_hosts_fqdn_hostport_and_proxies(self):
        self.gone("resolver: acme-lt-00412.corp.acme.co.kr", "acme-lt-00412", "corp.acme.co.kr")
        self.gone("proxy.corp.acme.co.kr:8080", "proxy.corp.acme.co.kr")
        self.gone('{"proxy": "proxy.corp.acme.co.kr:3128"}', "corp.acme.co.kr")
        self.gone("using proxy host:3128", "host:3128")
        self.gone("//fileserver/share/docs", "fileserver")
        self.gone("CN=Kim Minsu,OU=Staff,DC=corp,DC=acme,DC=local", "Kim", "acme")

    def test_paths_with_spaces_and_registry(self):
        self.gone(r"D:\Corp Data\ProjectFalcon\plan.docx", "Corp", "ProjectFalcon")
        self.gone(r"C:\Documents and Settings\kim.minsu\x", "kim.minsu", "Settings")
        self.gone(r"C:\ProgramData\AcmeCorp\policy.json", "AcmeCorp")
        self.gone(r"HKCU:\Software\AcmeCorp\Agent", "AcmeCorp")
        self.gone("opened /srv/acme/secret-share/plan.txt now", "secret-share")

    def test_ipv6_mac_sid_undashed_uuid_and_idn_mail(self):
        self.gone("addr 2001:db8:85a3::8a2e:370:7334 x", "2001:db8")
        self.gone("fe80::1ff:fe23:4567:890a", "fe80")
        self.gone("mac 00:1A:2B:3C:4D:5E", "00:1A:2B")
        self.gone("sid S-1-5-21-3623811015-3361044348-30300820-1013", "3623811015")
        self.gone("id 123e4567e89b12d3a456426614174000", "426614174000")
        self.gone("\ubbfc\uc218@acme.\ud55c\uad6d x".encode().decode("unicode_escape") if False else "kim@xn--acme-bz1c.example", "kim@")

    def test_bare_username_or_host_literal_is_masked_not_just_flagged(self):
        r = Redactor(literals={"kimms": "<USER>", "WIN11-VM-KIMMS": "<HOST>"}, include_environment=False)
        out = r.redact_text("hello KIMMS from win11-vm-kimms")
        self.assertNotIn("KIMMS", out.upper().replace("<USER>", "").replace("<HOST>", ""))

    def test_short_literals_whole_word_only(self):
        r = Redactor(literals={"jo": "<USER>"}, include_environment=False)
        self.assertEqual(r.redact_text("jo owns the job"), "<USER> owns the job")
        r.assert_clean("job")
        with self.assertRaises(RedactionError):
            r.assert_clean("jo")


if __name__ == "__main__":
    unittest.main()
