"""Tests for common.results (schema v2, allowlist, raw/ separation, fail-closed redaction). Never run against real CLIs."""
import copy
import json
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

from common import results
from common.redact import RedactionError, Redactor
from common.results import ResultBuilder, validate_result


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def make_builder(out_dir, literals=None):
    return ResultBuilder("test-kit", out_dir, redactor=Redactor(literals=literals or {}, include_environment=False))


def valid_obj():
    with tempfile.TemporaryDirectory() as d:
        b = make_builder(d)
        b.add_check("R02-C1:detect:claude", "PASS", {"installed": True, "version": "1.2.3", "calls": 3, "observables_tripped": ["canary_file"]}, ["auth_from_status_surface_only"])
        b.add_metric("install_duration_ms", 1234, "ms")
        b.add_note("unit_tests_not_site_evidence")
        b.set_environment({"os": "Windows", "os_release": "Microsoft Windows 11 Pro", "os_version": "26100", "cpu_class": "<=8 cores"})
        return b.build()


class SchemaTests(unittest.TestCase):
    def test_valid_result_passes(self):
        self.assertEqual(validate_result(valid_obj()), [])

    def test_unexpected_string_fact_is_rejected(self):
        for bad in ("acme-lt-00412", "C:\\Users\\kim\\x", "CANARY-T1-deadbeef", "free text from a CLI", "kim.minsu@example.com"):
            obj = valid_obj()
            obj["checks"][0]["facts"]["auth_state"] = bad
            errors = validate_result(obj)
            self.assertTrue(any("not allowlisted" in e for e in errors), (bad, errors))

    def test_unexpected_keys_are_rejected_everywhere(self):
        for mutate in (lambda o: o.__setitem__("hostname", "x"),
                       lambda o: o["checks"][0].__setitem__("observed", "free text"),
                       lambda o: o["checks"][0].__setitem__("note", "free text"),
                       lambda o: o["environment"].__setitem__("hostname", "x"),
                       lambda o: o.__setitem__("raw", {"stdout": "x"})):
            obj = valid_obj()
            mutate(obj)
            self.assertTrue(validate_result(obj))

    def test_unknown_code_note_and_verdict_rejected(self):
        for mutate in (lambda o: o["checks"][0]["codes"].append("made_up_code"),
                       lambda o: o["notes"].append("free text note"),
                       lambda o: o["checks"][0].__setitem__("verdict", "MAYBE")):
            obj = valid_obj()
            mutate(obj)
            self.assertTrue(validate_result(obj))

    def test_non_allowlisted_environment_values_rejected_or_projected(self):
        obj = valid_obj()
        obj["environment"]["os_version"] = "Darwin Kernel Version 27.0.0: root:xnu-1/RELEASE"
        self.assertTrue(validate_result(obj))
        self.assertEqual(results.project_environment({"os_version": "Darwin Kernel Version 27.0.0: root:xnu"})["os_version"], "unknown")

    def test_nested_dict_depth_and_key_rules(self):
        obj = valid_obj()
        obj["checks"][0]["facts"]["by_purpose"] = {"generate": 2, "structured": 1}
        self.assertEqual(validate_result(obj), [])
        obj["checks"][0]["facts"]["by_purpose"] = {"acme-host-1": 2}
        self.assertTrue(validate_result(obj))
        obj["checks"][0]["facts"]["by_purpose"] = {"generate": {"too": {"deep": 1}}}
        self.assertTrue(validate_result(obj))

    def test_profile_names_attack_ids_and_flags_are_in_the_fixed_vocabulary(self):
        obj = valid_obj()
        obj["checks"][0]["facts"]["missing_flags"] = ["--restricted", "-c"]
        obj["checks"][0]["facts"]["attack_status"] = {"A1-file-read": "LEAKED"}
        obj["checks"][0]["facts"]["profile"] = "claude-A-restricted-safe"
        self.assertEqual(validate_result(obj), [])

    def test_hash_and_version_values_are_typed_by_key(self):
        obj = valid_obj()
        obj["checks"][0]["facts"]["license_file_hashes"] = ["h:0123456789ab"]
        self.assertEqual(validate_result(obj), [])
        obj["checks"][0]["facts"]["license_file_hashes"] = ["0123456789abcdef0123456789abcdef"]
        self.assertTrue(validate_result(obj))

    def test_passed_env_names_must_be_known_variable_names(self):
        obj = valid_obj()
        obj["environment"]["passed_env_names"] = ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"]
        self.assertEqual(validate_result(obj), [])
        obj["environment"]["passed_env_names"] = ["HTTPS_PROXY", "ACME_INTERNAL_VAR"]
        self.assertTrue(validate_result(obj))

    def test_cli_version_environment_values_are_validated(self):
        obj = valid_obj()
        obj["environment"]["claude_version"] = "2.1.330"
        self.assertEqual(validate_result(obj), [])
        obj["environment"]["claude_version"] = "kim.minsu"
        self.assertTrue(validate_result(obj))

    def test_metric_names_are_validated(self):
        obj = valid_obj()
        obj["metrics"]["startup_ms"] = {"value": 1, "unit": "ms"}
        self.assertTrue(validate_result(obj))

    def test_check_ids_are_validated(self):
        obj = valid_obj()
        obj["checks"][0]["id"] = "R02-C1:detect:kimminsu"
        self.assertTrue(validate_result(obj))

    def test_nonfinite_and_bad_metric_rejected(self):
        obj = valid_obj()
        obj["metrics"]["install_duration_ms"] = {"value": float("inf"), "unit": "ms"}
        self.assertTrue(validate_result(obj))
        obj["metrics"]["install_duration_ms"] = {"value": 1, "unit": "furlongs"}
        self.assertTrue(validate_result(obj))
        obj["metrics"]["install_duration_ms"] = {"value": "12", "unit": "ms"}
        self.assertTrue(validate_result(obj))

    def test_verdict_vocabulary(self):
        for v in ("PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_RUN", "NOT_APPLICABLE"):
            self.assertIn(v, results.VERDICTS)

    def test_builder_rejects_bad_verdict(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                make_builder(d).add_check("R02-C1:detect:claude", "MAYBE")


class WriterTests(unittest.TestCase):
    def test_pasteable_pair_plus_local_raw_folder(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_check("R02-C2:positive:claude-A-restricted-safe", "PASS", {"installed": True})
            b.add_raw("stdout_tail", "CLI said hello from /Users/bob/project")
            jpath, mpath = b.write()
            self.assertEqual(sorted(os.listdir(d)), ["raw", "result.json", "result.md"])
            obj = json.loads(read(jpath))
            self.assertEqual(obj["schema_version"], 2)
            self.assertNotIn("hello", read(jpath) + read(mpath))
            self.assertIn("NEVER", read(os.path.join(d, "raw", "README_NEVER_PASTE.txt")))
            self.assertNotIn("bob", read(os.path.join(d, "raw", "stdout_tail.txt")))

    def test_a_non_allowlisted_fact_never_reaches_the_pasteable_file_and_the_run_is_kept(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_check("R02-C1:detect:claude", "PASS", {"leftover": "AcmeCorp-EDR-Agent"})
            b.add_raw("stdout_tail", "kept")
            jpath, mpath = b.write()
            self.assertTrue(b.degraded)
            obj = json.loads(read(jpath))
            self.assertEqual(validate_result(obj), [])
            self.assertEqual([c["id"] for c in obj["checks"]], ["result-write"])
            self.assertEqual(obj["checks"][0]["verdict"], "INCONCLUSIVE")
            self.assertEqual(obj["notes"], ["result_write_failed"])
            self.assertNotIn("AcmeCorp", read(jpath) + read(mpath))
            self.assertEqual(read(os.path.join(d, "raw", "stdout_tail.txt")), "kept")
            self.assertIn("AcmeCorp", read(os.path.join(d, "raw", "validation_failure.txt")))

    def test_second_layer_masks_environment_literals_in_the_pasteable_file(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d, {"detect": "<USER>"})  # a user account named like a harness word
            b.add_check("R02-C1:detect:claude", "PASS", {"installed": True})
            b.write()
            text = read(os.path.join(d, "result.json"))
            self.assertIn("R02-C1:<USER>:claude", text)
            self.assertNotIn("detect", text)

    def test_fail_closed_replaced_by_a_minimal_result_when_a_literal_sits_inside_a_harness_word(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d, {"etec": "<USER>"})  # a user account name that sits inside a harness word
            b.add_check("R02-C1:detect:claude", "PASS", {"installed": True})
            jpath, _ = b.write()
            self.assertTrue(b.degraded)
            self.assertEqual([c["id"] for c in json.loads(read(jpath))["checks"]], ["result-write"])

    def test_dry_run_mode_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            b = ResultBuilder("test-kit", d, redactor=Redactor(include_environment=False), mode="dry-run")
            self.assertIsNone(b.write())
            self.assertEqual(os.listdir(d), [])

    def test_no_code_path_copies_free_text_into_the_pasteable_files(self):
        with tempfile.TemporaryDirectory() as d:
            b = make_builder(d)
            b.add_check("R02-C2:positive:claude-A-restricted-safe", "FAIL", {"exit_code": 1})
            b.add_raw("stderr", "SECRET-LOOKING stderr line proxy.corp.acme.co.kr")
            jpath, mpath = b.write()
            self.assertNotIn("acme", read(jpath) + read(mpath))


class MergeTests(unittest.TestCase):
    def test_second_run_accumulates_into_same_file(self):
        with tempfile.TemporaryDirectory() as d:
            b1 = make_builder(d)
            b1.add_check("R02-C1:detect:claude", "PASS")
            jpath, _ = b1.write()
            b2 = make_builder(d)
            b2.add_check("R02-C2:positive:claude-A-restricted-safe", "FAIL")
            self.assertTrue(b2.merge_from(jpath))
            b2.write()
            self.assertEqual([c["id"] for c in json.loads(read(jpath))["checks"]], ["R02-C1:detect:claude", "R02-C2:positive:claude-A-restricted-safe"])

    def test_same_id_is_replaced_not_duplicated(self):
        with tempfile.TemporaryDirectory() as d:
            b1 = make_builder(d)
            b1.add_check("R02-C1:detect:claude", "FAIL")
            jpath, _ = b1.write()
            b2 = make_builder(d)
            b2.add_check("R02-C1:detect:claude", "PASS")
            b2.merge_from(jpath)
            self.assertEqual([c["verdict"] for c in b2.build()["checks"]], ["PASS"])

    def test_stale_pass_is_dropped_when_the_cli_version_changed(self):
        with tempfile.TemporaryDirectory() as d:
            b1 = make_builder(d)
            b1.set_environment({"claude_version": "1.0.0"})
            b1.add_check("R02-C3:negative:claude-A-restricted-safe", "PASS")
            jpath, _ = b1.write()
            b2 = make_builder(d)
            b2.set_environment({"claude_version": "2.0.0"})
            b2.add_check("R02-C1:detect:claude", "PASS")
            self.assertFalse(b2.merge_from(jpath))
            self.assertEqual([c["id"] for c in b2.build()["checks"]], ["R02-C1:detect:claude"])
            self.assertIn("merge_dropped_version_change", b2.build()["notes"])

    def test_merge_ignores_garbage_and_old_schema(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "result.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("not json")
            self.assertFalse(make_builder(d).merge_from(path))
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"schema_version": 1, "kit": "test-kit", "checks": []}, fh)
            self.assertFalse(make_builder(d).merge_from(path))


if __name__ == "__main__":
    unittest.main()
