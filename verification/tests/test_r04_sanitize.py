"""R04 sanitize_result.py tests (spec R04-K1): allowlist projection of the raw PowerShell result."""
import json
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

from common import results

san = _paths.load_kit_module("r04-windows-installer", "sanitize_result.py", "sanitize_result")


def raw_result(**over):
    obj = {"schema_version": 1, "kit": "r04-windows-installer", "mode": "real", "created": "2026-11-21T00:00:00Z",
           "environment": {"os": "Windows", "os_release": "Microsoft Windows 11 Pro", "os_version": "26100", "powershell": "5.1.26100.1"},
           "checks": [{"id": "R04-C1:preflight", "verdict": "PASS", "codes": [],
                       "facts": {"commands_found": [], "software_found": [], "vc_redist_present": False}}],
           "metrics": {"installer_size_bytes": {"value": 123456, "unit": "bytes"}}, "notes": ["r04_not_syntax_checked"]}
    obj.update(over)
    return obj


def write(d, obj, bom=False):
    path = os.path.join(d, "raw.json")
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    return path


def sanitized(raw, literals=()):
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "out")
        san.sanitize(write(d, raw), out, list(literals))
        texts = {}
        for name in ("result.json", "result.md"):
            with open(os.path.join(out, name), encoding="utf-8") as fh:
                texts[name] = fh.read()
        listing = sorted(os.listdir(out))
        with open(os.path.join(out, "raw", "result-raw.json"), encoding="utf-8") as fh:
            raw_copy = fh.read()
    return texts, listing, raw_copy


class ProjectionTests(unittest.TestCase):
    def test_clean_raw_result_projects_to_a_valid_pasteable_file(self):
        texts, listing, _raw = sanitized(raw_result())
        obj = json.loads(texts["result.json"])
        self.assertEqual(results.validate_result(obj), [])
        self.assertEqual(obj["schema_version"], 2)
        self.assertEqual(obj["dropped_fields"], 0)
        self.assertEqual(listing, ["raw", "result.json", "result.md"])

    def test_the_reviewers_r04_leaks_cannot_reach_the_pasteable_file(self):
        leaky = raw_result()
        leaky["checks"][0]["facts"]["leftovers_added"] = ["AcmeCorp-EDR-Agent", "AcmeVPN", "AcmeMessenger"]
        leaky["checks"][0]["facts"]["host"] = "WIN11-VM-KIMMS"
        leaky["checks"][0]["facts"]["user"] = "kim.minsu"
        leaky["checks"][0]["facts"]["company"] = "ACMECORP"
        leaky["checks"][0]["observed"] = "free text WIN11-VM-KIMMS kim.minsu ACMECORP"
        leaky["checks"][0]["data"] = {"added": ["AcmeCorp-EDR-Agent"]}
        texts, _listing, raw_copy = sanitized(leaky)
        both = texts["result.json"] + texts["result.md"]
        for needle in ("AcmeCorp", "AcmeVPN", "AcmeMessenger", "WIN11-VM-KIMMS", "kim.minsu", "ACMECORP", "free text"):
            self.assertNotIn(needle, both)
        obj = json.loads(texts["result.json"])
        self.assertGreaterEqual(obj["dropped_fields"], 5)
        self.assertIn("r04_free_text_dropped", obj["notes"])
        self.assertIn("AcmeCorp-EDR-Agent", raw_copy)  # kept only in the local raw copy

    def test_unknown_verdict_never_becomes_a_pass(self):
        bad = raw_result()
        bad["checks"][0]["verdict"] = "GREAT"
        obj = json.loads(sanitized(bad)[0]["result.json"])
        self.assertEqual(obj["checks"][0]["verdict"], "INCONCLUSIVE")

    def test_missing_verdict_never_becomes_a_pass(self):
        bad = raw_result()
        del bad["checks"][0]["verdict"]
        self.assertEqual(json.loads(sanitized(bad)[0]["result.json"])["checks"][0]["verdict"], "INCONCLUSIVE")

    def test_allowlisted_words_numbers_and_flags_survive(self):
        ok = raw_result()
        ok["checks"][0]["facts"].update({"commands_found": ["node", "python"], "status_counts": {"Valid": 3, "NotSigned": 2}, "exit_code": 0})
        facts = json.loads(sanitized(ok)[0]["result.json"])["checks"][0]["facts"]
        self.assertEqual(facts["commands_found"], ["node", "python"])
        self.assertEqual(facts["status_counts"], {"Valid": 3, "NotSigned": 2})

    def test_unknown_codes_notes_and_bad_ids_are_dropped(self):
        bad = raw_result(notes=["free text note", "r04_not_syntax_checked"])
        bad["checks"][0]["codes"] = ["made_up", "r04_clean_check_failed"]
        bad["checks"].append({"id": "C:\\Users\\kim\\x", "verdict": "PASS", "facts": {}, "codes": []})
        obj = json.loads(sanitized(bad)[0]["result.json"])
        self.assertEqual([c["id"] for c in obj["checks"]], ["R04-C1:preflight"])
        self.assertEqual(obj["checks"][0]["codes"], ["r04_clean_check_failed"])
        self.assertNotIn("free text note", obj["notes"])

    def test_powershell_utf8_bom_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            san.sanitize(write(d, raw_result(), bom=True), os.path.join(d, "out"), [])

    def test_garbage_input_is_an_error_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "raw.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("not json")
            with self.assertRaises(ValueError):
                san.sanitize(path, os.path.join(d, "out"), [])
            self.assertFalse(os.path.exists(os.path.join(d, "out")))

    def test_fail_closed_when_a_redact_literal_sits_inside_an_allowlisted_word(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            with self.assertRaises(san.RedactionError):
                san.sanitize(write(d, raw_result()), out, ["mmands"])  # sits inside a harness word
            self.assertFalse(os.path.exists(os.path.join(d, "out", "result.json")))

    def test_projection_output_is_always_schema_valid(self):
        nasty = {"schema_version": "x", "kit": 7, "extra": "y", "environment": {"os": "Darwin Kernel Version 27 root:xnu"},
                 "checks": [{"id": "ok:1", "verdict": "PASS", "facts": {"a b": 1, "n": float("inf"), "s": {"deep": {"er": 1}}}, "codes": None}],
                 "metrics": {"m": {"value": "12", "unit": "furlong"}}, "notes": None}
        obj, _ = san.project_raw(nasty)
        self.assertEqual(results.validate_result(obj), [])


if __name__ == "__main__":
    unittest.main()
