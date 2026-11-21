"""N1: every string slot of the pasteable result comes from a fixed registry declared in code.

The leak strings below are the delta reviewer's exact probes. A new check id, metric name or fact key needs a code change.
"""
import json
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

from common import results
from common.redact import Redactor

san = _paths.load_kit_module("r04-windows-installer", "sanitize_result.py", "sanitize_result")


def base():
    return {"schema_version": 2, "kit": "r04-windows-installer", "mode": "real", "created": "2026-11-21T00:00:00Z",
            "environment": {}, "checks": [{"id": "R04-C1:preflight", "verdict": "PASS", "facts": {"installed": True}, "codes": []}],
            "metrics": {}, "notes": [], "dropped_fields": 0}


def errors_for(mutate):
    obj = base()
    mutate(obj)
    return results.validate_result(obj)


class LeakStringsAreRejected(unittest.TestCase):
    def test_check_ids_come_from_the_registry(self):
        for bad in ("kim.minsu_10.20.30.40", "R04-C1:acmecorp", "R04-C1:preflight:kim", "random-id"):
            self.assertTrue(errors_for(lambda o: o["checks"][0].__setitem__("id", bad)), bad)
        for good in ("R04-C1:preflight", "R02-C3:negative:claude-A-restricted-safe", "R03-C1:lightrag:import", "R02-control:sensitivity:codex-X-control-readonly-default"):
            self.assertEqual(errors_for(lambda o: o["checks"][0].__setitem__("id", good)), [], good)

    def test_metric_names_come_from_the_registry(self):
        for bad in ("kim.minsu_startup", "acmecorp_metric"):
            self.assertTrue(errors_for(lambda o: o["metrics"].__setitem__(bad, {"value": 1, "unit": "ms"})), bad)
        self.assertEqual(errors_for(lambda o: o["metrics"].__setitem__("installer_size_bytes", {"value": 1, "unit": "bytes"})), [])

    def test_fact_keys_come_from_the_registry(self):
        for bad in ("kim_minsu_acmecorp", "acmecorp_edr_agent", "claude-kim.minsu"):
            self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__(bad, True)), bad)

    def test_nested_count_keys_come_from_the_registry(self):
        self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("status_counts", {"acmecorp_vpn": 3, "codex-acmecorp": 1})))
        self.assertEqual(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("status_counts", {"Valid": 3})), [])

    def test_fact_string_values_only_from_the_fixed_vocabulary(self):
        for bad in ("o1acme-lt-00412.corp.acme.co.kr", "claude-kim.minsu", "gpt-acmecorp", "1.2.3-ACMELT00412", "kim.minsu"):
            self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("auth_state", bad)), bad)
            self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("commands_found", [bad])), bad)

    def test_model_pattern_only_for_the_model_fact_and_only_known_families(self):
        ok = lambda v: errors_for(lambda o: o["checks"][0]["facts"].__setitem__("model", v))
        for good in ("gpt-5-codex", "claude-sonnet-4-5", "claude-opus-4-20250514", "o3"):
            self.assertEqual(ok(good), [], good)
        for bad in ("gpt-4o-acmecorp-eastus", "claude-kim.minsu", "gpt-acmecorp", "acme-model"):
            self.assertTrue(ok(bad), bad)
        self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("auth_state", "claude-sonnet-4-5")))
        self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("commands_found", ["claude-sonnet-4-5"])))

    def test_versions_are_semver_with_only_known_prerelease_words(self):
        ok = lambda v: errors_for(lambda o: o["checks"][0]["facts"].__setitem__("cli_version", v))
        for good in ("1.2.3", "0.156.0-alpha.3", "2.1.330", "1.0.0-rc1", "5.1.26100.1", "1.0.0-beta.2"):
            self.assertEqual(ok(good), [], good)
        for bad in ("1.0.0-kimminsu", "1.2.3-ACMELT00412", "1.0", "v1.2.3", "1.0.0-alpha.kim"):
            self.assertTrue(ok(bad), bad)

    def test_environment_values_are_strict(self):
        for key, bad in (("powershell", "5.1.22621-ACMELT00412"), ("codex_version", "1.0.0-kimminsu"), ("claude_version", "2.0.0-acme")):
            self.assertTrue(errors_for(lambda o: o["environment"].__setitem__(key, bad)), (key, bad))
        self.assertEqual(errors_for(lambda o: o["environment"].__setitem__("codex_version", "0.156.0-alpha.3")), [])

    def test_hashes_only_where_a_hash_is_expected(self):
        self.assertEqual(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("license_file_hashes", ["h:0123456789ab"])), [])
        self.assertTrue(errors_for(lambda o: o["checks"][0]["facts"].__setitem__("commands_found", ["h:0123456789ab"])))

    def test_version_normaliser(self):
        self.assertEqual(results.normalize_version("0.156.0-alpha.3"), ("0.156.0-alpha.3", True))
        self.assertEqual(results.normalize_version("1.0.0-kimminsu"), ("unknown", False))
        self.assertEqual(results.normalize_version(None), ("unknown", False))

    def test_the_old_open_slots_are_gone(self):
        self.assertFalse(hasattr(results, "register_known_strings"))


class ProjectionUsesTheSameRegistries(unittest.TestCase):
    def project(self, raw):
        obj, dropped = san.project_raw(raw)
        self.assertEqual(results.validate_result(obj), [])
        return obj, dropped

    def test_the_reviewers_hostile_raw_file_is_fully_dropped_and_counted(self):
        raw = {"schema_version": 1, "kit": "r04-windows-installer", "environment": {"powershell": "5.1.22621-ACMELT00412"},
               "checks": [{"id": "R04-C1:preflight", "verdict": "PASS", "codes": [], "facts": {
                   "kim_minsu": True, "added": ["claude-AcmeCorp-EDR-Agent", "o9AcmeCorp.EDR", "1.0-ACMELT00412"],
                   "status_counts": {"acmecorp_vpn": 3, "codex-acmecorp": 1, "Valid": 2}, "commands_found": ["node", "AcmeVPN"]}}],
               "metrics": {"kim.minsu_startup": {"value": 5, "unit": "ms"}, "installer_size_bytes": {"value": 9, "unit": "bytes"}}}
        obj, dropped = self.project(raw)
        text = json.dumps(obj)
        for needle in ("kim", "Acme", "acme", "ACMELT"):
            self.assertNotIn(needle, text)
        facts = obj["checks"][0]["facts"]
        self.assertEqual(facts["status_counts"], {"Valid": 2})
        self.assertEqual(facts["commands_found"], ["node"])
        self.assertEqual(list(obj["metrics"]), ["installer_size_bytes"])
        self.assertEqual(dropped, 7)  # powershell env value, kim_minsu, added, 2 count keys, AcmeVPN, metric name
        self.assertEqual(obj["dropped_fields"], dropped)

    def test_sanitize_end_to_end_exit_ok_and_pasteable_clean(self):
        raw = {"checks": [{"id": "R04-C1:preflight", "verdict": "PASS", "facts": {"kim_minsu": True, "installed": True}, "codes": []}]}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "raw.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(raw, fh)
            self.assertEqual(san.main(["--raw", path, "--out", os.path.join(d, "out")]), 0)
            with open(os.path.join(d, "out", "result.json"), encoding="utf-8") as fh:
                self.assertNotIn("kim", fh.read())


if __name__ == "__main__":
    unittest.main()
