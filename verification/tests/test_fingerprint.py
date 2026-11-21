"""Tests for common.fingerprint and common.jsonschema_lite and common.procinfo. Never run against real CLIs."""
import json
import os
import sys
import unittest

try:
    from . import _paths  # noqa: F401
except ImportError:  # run directly from the tests directory
    import _paths  # noqa: F401
from common import fingerprint, jsonschema_lite, procinfo
from common.redact import Redactor


class FingerprintTests(unittest.TestCase):
    def test_buckets(self):
        self.assertEqual(fingerprint.bucket_cpu(2), "<=2 cores")
        self.assertEqual(fingerprint.bucket_cpu(6), "<=8 cores")
        self.assertEqual(fingerprint.bucket_cpu(64), ">16 cores")
        gb = 1024 ** 3
        self.assertEqual(fingerprint.bucket_ram(7.6 * gb), "<=8 GB")
        self.assertEqual(fingerprint.bucket_ram(15.9 * gb), "<=16 GB")
        self.assertEqual(fingerprint.bucket_ram(200 * gb), ">64 GB")
        self.assertEqual(fingerprint.bucket_ram(None), "unknown")

    def test_parse_version(self):
        self.assertEqual(fingerprint.parse_version("2.1.330 (Claude Code)"), "2.1.330")
        self.assertEqual(fingerprint.parse_version("codex-cli 0.155.1\n"), "0.155.1")
        self.assertIsNone(fingerprint.parse_version("no digits here"))

    def test_classify_binary_location_never_returns_path(self):
        cases = {
            r"C:\Users\alice\AppData\Local\Programs\claude\claude.exe": "user-profile",
            r"C:\Program Files\Codex\codex.exe": "program-files",
            "/Users/bob/.local/bin/claude": "user-profile",
            "/usr/local/bin/codex": "system-bin",
            r"D:\tools\x.exe": "other",
        }
        for path, kind in cases.items():
            self.assertEqual(fingerprint.classify_binary_location(path), kind, path)

    def test_fingerprint_has_only_allowed_keys_and_is_not_identifying(self):
        fp = fingerprint.environment_fingerprint()
        self.assertEqual(set(fp), {"os", "os_release", "os_version", "machine", "python", "cpu_class", "ram_class"})
        dumped = json.dumps(fp)
        r = Redactor()
        self.assertEqual(r.residual_literals(dumped), [])


class JsonSchemaLiteTests(unittest.TestCase):
    SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}, "count": {"type": "integer"},
                                               "tags": {"type": "array", "items": {"type": "string"}}},
              "required": ["answer", "count"], "additionalProperties": False}

    def test_valid(self):
        self.assertEqual(jsonschema_lite.validate({"answer": "ok", "count": 3, "tags": ["a"]}, self.SCHEMA), [])

    def test_missing_required(self):
        self.assertTrue(jsonschema_lite.validate({"answer": "ok"}, self.SCHEMA))

    def test_additional_property_rejected(self):
        errs = jsonschema_lite.validate({"answer": "ok", "count": 1, "leak": "CANARY"}, self.SCHEMA)
        self.assertTrue(any("leak" in e for e in errs))

    def test_wrong_types(self):
        self.assertTrue(jsonschema_lite.validate({"answer": 1, "count": 1}, self.SCHEMA))
        self.assertTrue(jsonschema_lite.validate({"answer": "a", "count": True}, self.SCHEMA))
        self.assertTrue(jsonschema_lite.validate({"answer": "a", "count": 1, "tags": [1]}, self.SCHEMA))

    def test_enum(self):
        self.assertTrue(jsonschema_lite.validate("c", {"enum": ["a", "b"]}))
        self.assertEqual(jsonschema_lite.validate("a", {"enum": ["a", "b"]}), [])


class ProcinfoTests(unittest.TestCase):
    def test_parse_ps_table(self):
        text = "  1     0  1024  0:01.50\n 200     1  2048  1-02:03:04\n"
        rows = procinfo.parse_ps_table(text)
        self.assertEqual(rows[0], procinfo.ProcRow(1, 0, 1024 * 1024, 1.5))
        self.assertEqual(rows[1].pid, 200)
        self.assertAlmostEqual(rows[1].cpu_seconds, 86400 + 2 * 3600 + 3 * 60 + 4)

    def test_parse_windows_table(self):
        text = "4,0,1000000,50000000\r\n812,4,2000000,10000000\r\n"
        rows = procinfo.parse_windows_table(text)
        self.assertEqual(rows[1], procinfo.ProcRow(812, 4, 2000000, 1.0))

    def test_windows_table_with_creation_time(self):
        rows = procinfo.parse_windows_table("812,4,2000000,10000000,133500000000000000\r\n")
        self.assertEqual(rows[0].created, 133500000000000000)

    def test_recycled_parent_pid_is_not_a_parent(self):
        # pid 7 was created long before its recorded "child" 9 -> pid 9's parent id 7 is a recycled/ stale id
        rows = [procinfo.ProcRow(1, 0, 0, 0, 100), procinfo.ProcRow(7, 1, 0, 0, 500), procinfo.ProcRow(9, 7, 0, 0, 200)]
        self.assertEqual(procinfo.descendants_of(rows, 1), [7])
        self.assertEqual(procinfo.descendants_of(rows, 7), [])

    def test_descendants_from_rows(self):
        rows = [procinfo.ProcRow(1, 0, 0, 0), procinfo.ProcRow(2, 1, 0, 0), procinfo.ProcRow(3, 2, 0, 0), procinfo.ProcRow(9, 8, 0, 0)]
        self.assertEqual(sorted(procinfo.descendants_of(rows, 1)), [2, 3])

    def test_live_table_contains_own_pid(self):
        rows = procinfo.list_process_table()
        self.assertIn(os.getpid(), [r.pid for r in rows])

    def test_self_rss_positive(self):
        self.assertGreater(procinfo.current_rss_bytes(), 1024 * 1024)
        self.assertGreaterEqual(procinfo.peak_rss_bytes(), procinfo.current_rss_bytes() // 2)


if __name__ == "__main__":
    unittest.main()
