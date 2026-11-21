"""R04 sanitize_result.py tests (spec R04-K1): second-pass masking and validation of PowerShell output."""
import json
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

san = _paths.load_kit_module("r04-windows-installer", "sanitize_result.py", "sanitize_result")


def raw_result(**over):
    obj = {"schema_version": 1, "kit": "r04-windows-installer", "mode": "real", "created": "2026-11-21T00:00:00Z",
           "environment": {"os": "Windows 11 build 26100"},
           "checks": [{"id": "R04-C1:preflight", "criterion": "clean machine", "verdict": "PASS",
                       "observed": r"checked C:\Users\alice\AppData on WORKSTATION-77 mail bob@corp.example.com ip 10.1.2.3", "note": ""}],
           "metrics": {"startup_ms": {"value": 1200, "unit": "ms"}}, "raw": {}, "notes": []}
    obj.update(over)
    return obj


def write(d, obj, bom=False):
    path = os.path.join(d, "raw.json")
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8") as fh:
        json.dump(obj, fh)
    return path


class SanitizeTests(unittest.TestCase):
    def test_identifying_values_removed_and_files_written(self):
        with tempfile.TemporaryDirectory() as d:
            raw = write(d, raw_result())
            out = os.path.join(d, "out")
            san.sanitize(raw, out, literals=["WORKSTATION-77"])
            text = ""
            for name in ("result.json", "result.md"):
                with open(os.path.join(out, name), encoding="utf-8") as fh:
                    text += fh.read()
            for bad in ("alice", "WORKSTATION-77", "bob@", "10.1.2.3"):
                self.assertNotIn(bad, text)
            self.assertEqual(sorted(os.listdir(out)), ["result.json", "result.md"])

    def test_powershell_utf8_bom_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            san.sanitize(write(d, raw_result(), bom=True), os.path.join(d, "out"), literals=[])

    def test_schema_violation_is_rejected_and_nothing_written(self):
        with tempfile.TemporaryDirectory() as d:
            bad = raw_result()
            bad["checks"][0]["verdict"] = "GREAT"
            out = os.path.join(d, "out")
            with self.assertRaises(ValueError):
                san.sanitize(write(d, bad), out, literals=[])
            self.assertFalse(os.path.exists(out))

    def test_residual_literal_inside_word_blocks_writing(self):
        with tempfile.TemporaryDirectory() as d:
            bad = raw_result()
            bad["checks"][0]["observed"] = "xWORKSTATION-77y"
            out = os.path.join(d, "out")
            with self.assertRaises(san.RedactionError):
                san.sanitize(write(d, bad), out, literals=["WORKSTATION-77"])
            self.assertFalse(os.path.exists(out))

    def test_garbage_input_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "raw.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("not json")
            with self.assertRaises(ValueError):
                san.sanitize(path, os.path.join(d, "out"), literals=[])


if __name__ == "__main__":
    unittest.main()
