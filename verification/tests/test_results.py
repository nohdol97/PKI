"""Tests for common.results (schema, writer, fail-closed redaction). Never run against real CLIs."""
import json
import os
import tempfile
import unittest

try:
    from . import _paths  # noqa: F401
except ImportError:  # run directly from the tests directory
    import _paths  # noqa: F401
from common.redact import RedactionError, Redactor
from common.results import ResultBuilder, validate_result, VERDICTS


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def make_builder(out_dir, literals=None):
    red = Redactor(literals=literals or {}, include_environment=False)
    return ResultBuilder("r02-test", out_dir, redactor=red)


class SchemaTests(unittest.TestCase):
    def test_valid_result_passes(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_check("R02-C1", "capabilities table", "PASS", "version 1.2.3 found")
            b.add_metric("startup_ms", 1234, "ms")
            self.assertEqual(validate_result(b.build()), [])

    def test_bad_verdict_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            with self.assertRaises(ValueError):
                b.add_check("X", "c", "MAYBE", "o")

    def test_validate_catches_missing_keys_and_types(self):
        errors = validate_result({"schema_version": 1, "kit": "x", "checks": [{"id": 1}]})
        self.assertTrue(errors)
        self.assertTrue(any("checks[0]" in e for e in errors))

    def test_verdict_vocabulary(self):
        for v in ("PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_RUN", "NOT_APPLICABLE"):
            self.assertIn(v, VERDICTS)


class WriterTests(unittest.TestCase):
    def test_writes_exactly_two_files_json_and_md(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_check("R02-C2", "argv array", "PASS", "ok")
            jpath, mpath = b.write()
            self.assertEqual(sorted(os.listdir(d)), ["result.json", "result.md"])
            obj = json.loads(read(jpath))
            self.assertEqual(obj["schema_version"], 1)
            self.assertIn("R02-C2", read(mpath))

    def test_identifying_values_are_redacted_in_both_files(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d, {"WORKSTATION-77": "<HOST>"})
            b.add_check("R02-C1", "c", "PASS", r"binary at C:\Users\alice\bin\claude.exe on WORKSTATION-77 mail a@corp.example.com")
            b.add_raw("stdout", "HOME=/Users/bob proxy 10.9.8.7")
            jpath, mpath = b.write()
            for p in (jpath, mpath):
                text = read(p)
                for bad in ("alice", "WORKSTATION-77", "a@corp.example.com", "bob", "10.9.8.7"):
                    self.assertNotIn(bad, text, (p, bad))

    def test_refuses_to_write_when_residual_identifier_remains(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d, {"WORKSTATION-77": "<HOST>"})
            b.add_check("R02-C1", "c", "PASS", "xWORKSTATION-77y")
            with self.assertRaises(RedactionError):
                b.write()
            self.assertEqual(os.listdir(d), [])

    def test_raw_text_truncated(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_raw("big", "x" * 100000, max_chars=500)
            self.assertLess(len(b.build()["raw"]["big"]), 700)

    def test_dry_run_mode_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            b = ResultBuilder("r02-test", d, redactor=Redactor(include_environment=False), mode="dry-run")
            self.assertIsNone(b.write())
            self.assertEqual(os.listdir(d), [])



class MergeTests(unittest.TestCase):
    def test_second_run_accumulates_into_same_file(self):
        with tempfile.TemporaryDirectory() as d:
            b1 = make_builder(d)
            b1.add_check("R02-C1:detect", "c", "PASS", "one")
            jpath, _ = b1.write()
            b2 = make_builder(d)
            b2.add_check("R02-C2:positive", "c", "FAIL", "two")
            self.assertTrue(b2.merge_from(jpath))
            b2.write()
            obj = json.loads(read(jpath))
            self.assertEqual([c["id"] for c in obj["checks"]], ["R02-C1:detect", "R02-C2:positive"])
            self.assertEqual(sorted(os.listdir(d)), ["result.json", "result.md"])

    def test_same_id_is_replaced_not_duplicated(self):
        with tempfile.TemporaryDirectory() as d:
            b1 = make_builder(d)
            b1.add_check("X", "c", "FAIL", "old")
            jpath, _ = b1.write()
            b2 = make_builder(d)
            b2.add_check("X", "c", "PASS", "new")
            b2.merge_from(jpath)
            self.assertEqual([c["observed"] for c in b2.build()["checks"]], ["new"])

    def test_merge_ignores_other_kit_or_garbage(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "result.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("not json")
            self.assertFalse(make_builder(d).merge_from(path))


if __name__ == "__main__":
    unittest.main()
