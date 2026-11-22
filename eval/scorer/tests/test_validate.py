import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest

from fixture import GOLDEN_DIR, SCORER_DIR, make_dataset, sha, write_jsonl
import validate


def load(path):
    with open(path, encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


class ValidateBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = make_dataset(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def mutate(self, rel, fn):
        path = os.path.join(self.root, rel)
        if rel.endswith(".json"):
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            fn(data)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False)
        else:
            rows = load(path)
            fn(rows)
            write_jsonl(path, rows)

    def errors(self):
        return validate.validate_dataset(self.root, required_scenarios={})

    def assertHasError(self, needle):
        errs = self.errors()
        self.assertTrue(any(needle in e for e in errs), "expected %r in %r" % (needle, errs))


class TestValidFixture(ValidateBase):
    def test_valid_fixture_has_no_errors(self):
        self.assertEqual(self.errors(), [])


class TestEvidence(ValidateBase):
    def test_quote_span_mismatch_is_reported(self):
        def fn(rows):
            rows[0]["evidence"][0]["quote"] = "한서준"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("quote does not match span")

    def test_shifted_span_is_reported(self):
        def fn(rows):
            s, e = rows[0]["evidence"][0]["span"]
            rows[0]["evidence"][0]["span"] = [s + 1, e + 1]
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("quote does not match span")

    def test_span_out_of_range(self):
        def fn(rows):
            rows[0]["evidence"][0]["span"] = [0, 9999]
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("span out of range")

    def test_empty_span_rejected(self):
        def fn(rows):
            rows[0]["evidence"][0]["span"] = [3, 3]
            rows[0]["evidence"][0]["quote"] = ""
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("span")

    def test_unknown_record_in_evidence(self):
        def fn(rows):
            rows[0]["evidence"][0]["record_id"] = "mai-9999"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("unknown record")

    def test_unknown_version_in_evidence(self):
        def fn(rows):
            rows[0]["evidence"][0]["version"] = 7
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("unknown record")

    def test_missing_evidence(self):
        def fn(rows):
            rows[0]["evidence"] = []
        self.mutate("labels/relations.jsonl", fn)
        self.assertHasError("evidence")

    def test_evidence_from_other_instance(self):
        def fn(rows):
            rows[0]["evidence"][0]["record_id"] = "mes-0003"
            rows[0]["evidence"][0]["span"] = [0, 2]
            rows[0]["evidence"][0]["quote"] = "정산"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("outside instance")


class TestSchema(ValidateBase):
    def test_content_hash_mismatch(self):
        def fn(rows):
            rows[0]["content_hash"] = sha("something else")
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("content_hash")

    def test_bad_operation(self):
        def fn(rows):
            rows[0]["operation"] = "purge"
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("operation")

    def test_access_revoked_operation_is_accepted(self):
        # I01-R22: the operation vocabulary equals the import schema's (ImportRecordSchema)
        def fn(rows):
            rows[0]["operation"] = "access-revoked"
        self.mutate("sources/mail.jsonl", fn)
        self.assertFalse(any("operation" in e for e in self.errors()), self.errors())

    def test_operations_are_the_import_schemas(self):
        self.assertEqual(validate.OPERATIONS, {"upsert", "delete", "revoke", "access-revoked"})

    def test_missing_record_field(self):
        def fn(rows):
            del rows[0]["connector_instance_id"]
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("connector_instance_id")

    def test_duplicate_record_version(self):
        def fn(rows):
            rows.append(copy.deepcopy(rows[0]))
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("duplicate")

    def test_wrong_source_type_for_file(self):
        def fn(rows):
            rows[0]["source_type"] = "wiki"
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("source_type")

    def test_real_domain_email_flagged(self):
        def fn(rows):
            rows[0]["author"] = "someone@gmail.com"
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("non-example.test")

    def test_local_path_flagged(self):
        def fn(rows):
            rows[0]["metadata"] = {"note": "/Users/someone/file"}
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("local path")

    def test_created_at_needs_offset(self):
        def fn(rows):
            rows[0]["created_at"] = "2026-11-02T09:00:00"
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("created_at")

    def test_delete_without_earlier_version(self):
        def fn(rows):
            rows[0]["operation"] = "delete"
            rows[0]["content"] = ""
            rows[0]["content_hash"] = sha("")
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("earlier version")

    def test_bad_relation_type(self):
        def fn(rows):
            rows[0]["relation"] = "LIKES"
        self.mutate("labels/relations.jsonl", fn)
        self.assertHasError("relation type")

    def test_bad_entity_type(self):
        def fn(rows):
            rows[0]["entity_type"] = "Banana"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("entity_type")

    def test_bad_insight_type(self):
        def fn(rows):
            rows[0]["insight_type"] = "nonsense"
        self.mutate("labels/insights.jsonl", fn)
        self.assertHasError("insight_type")

    def test_insight_needs_is_inference(self):
        def fn(rows):
            del rows[0]["is_inference"]
        self.mutate("labels/insights.jsonl", fn)
        self.assertHasError("is_inference")

    def test_dangling_entity_reference(self):
        def fn(rows):
            rows[0]["object"] = "T1:nobody"
        self.mutate("labels/relations.jsonl", fn)
        self.assertHasError("unknown entity")

    def test_resolution_flag_must_match_entity_ids(self):
        def fn(rows):
            rows[0]["same"] = False
        self.mutate("labels/resolution_pairs.jsonl", fn)
        self.assertHasError("same")

    def test_bad_expected_status(self):
        def fn(rows):
            rows[0]["expected_status"] = "maybe"
        self.mutate("labels/temporal_facts.jsonl", fn)
        self.assertHasError("expected_status")

    def test_duplicate_label_id(self):
        def fn(rows):
            rows[1]["label_id"] = rows[0]["label_id"]
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("duplicate label_id")

    def test_qa_answerable_flag_role_consistency(self):
        def fn(rows):
            rows[2]["evidence_role"] = "required"
        self.mutate("labels/qa.jsonl", fn)
        self.assertHasError("evidence_role")


class TestHygieneAndVocabulary(ValidateBase):
    def test_url_host_must_be_example_test(self):
        def fn(rows):
            rows[0]["source_url"] = "https://intranet.corp.com/x"
        self.mutate("sources/mail.jsonl", fn)
        self.assertHasError("non-example.test host")

    def test_label_errors_name_the_label_id(self):
        def fn(rows):
            rows[0]["evidence"][0]["quote"] = "틀림"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("T1:ent-1")

    def test_alias_must_occur_in_instance_sources(self):
        def fn(rows):
            rows[0]["aliases"] = ["존재하지않는별칭"]
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("alias")

    def test_attribute_must_be_in_vocabulary(self):
        def fn(rows):
            rows[0]["attribute"] = "some_free_text_name"
        self.mutate("labels/temporal_facts.jsonl", fn)
        self.assertHasError("attribute")

    def test_instant_values_must_be_utc(self):
        def fn(rows):
            rows[0]["attribute"] = "start_instant"
            rows[0]["value"] = "2026-11-24T09:00:00+09:00"
        self.mutate("labels/temporal_facts.jsonl", fn)
        self.assertHasError("UTC")

    def test_second_review_file_evidence_is_checked(self):
        os.makedirs(os.path.join(self.root, "labels", "review"))
        bad = {"kind": "relation", "scenario_instance": "T1", "evidence": [
            {"record_id": "mai-0001", "version": 1, "span": [0, 3], "quote": "틀림"}]}
        write_jsonl(os.path.join(self.root, "labels", "review", "second_review_machine.jsonl"), [bad])
        self.assertHasError("second_review_machine")


class TestExpectedAbsent(ValidateBase):
    def test_expected_absent_needs_only_deleted_evidence(self):
        # ent-4 is evidenced by mes-0002 v1, which the fixture deletes in v2: valid
        self.assertEqual(self.errors(), [])
        def fn(rows):
            rows[3]["evidence"] = [rows[0]["evidence"][0]]   # points at the live mail record
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("expected_absent")

    def test_expected_absent_must_be_boolean(self):
        def fn(rows):
            rows[3]["expected_absent"] = "yes"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("expected_absent")


class TestOptionalFields(ValidateBase):
    def test_trigger_must_resolve(self):
        def fn(rows):
            rows[0]["trigger"] = {"record_id": "mai-9999", "version": 2}
        self.mutate("labels/temporal_facts.jsonl", fn)
        self.assertHasError("trigger")

    def test_trigger_must_be_delete_or_revoke_record(self):
        def fn(rows):
            rows[0]["trigger"] = {"record_id": "mai-0001", "version": 1}
        self.mutate("labels/temporal_facts.jsonl", fn)
        self.assertHasError("delete or revoke")

    def test_insight_expected_must_be_boolean(self):
        def fn(rows):
            rows[0]["expected"] = "no"
        self.mutate("labels/insights.jsonl", fn)
        self.assertHasError("expected")


class TestSplits(ValidateBase):
    def test_overlap_between_splits(self):
        def fn(d):
            d["splits"]["eval"].append("T1")
        self.mutate("splits.json", fn)
        self.assertHasError("both")

    def test_instance_missing_from_splits(self):
        def fn(d):
            d["splits"]["eval"].remove("T2")
        self.mutate("splits.json", fn)
        self.assertHasError("not assigned")

    def test_split_names_unknown_instance(self):
        def fn(d):
            d["splits"]["dev"].append("T9")
        self.mutate("splits.json", fn)
        self.assertHasError("unknown instance")

    def test_record_in_two_instances(self):
        def fn(d):
            d["instances"]["T2"]["record_ids"].append("mai-0001")
        self.mutate("splits.json", fn)
        self.assertHasError("more than one instance")

    def test_record_without_instance(self):
        def fn(d):
            d["instances"]["T1"]["record_ids"].remove("mes-0002")
        self.mutate("splits.json", fn)
        self.assertHasError("not in any instance")

    def test_label_with_unknown_instance(self):
        def fn(rows):
            rows[0]["scenario_instance"] = "T9"
        self.mutate("labels/entities.jsonl", fn)
        self.assertHasError("unknown instance")

    def test_default_requires_three_instances_per_scenario(self):
        errs = validate.validate_dataset(self.root)
        self.assertTrue(any("schedule_dependency_delay" in e and "instances" in e for e in errs), errs)


class TestCli(ValidateBase):
    def run_cli(self):
        return subprocess.run(
            [sys.executable, os.path.join(SCORER_DIR, "validate.py"), self.root, "--no-scenario-minimum"],
            capture_output=True, text=True,
        )

    def test_exit_zero_on_valid(self):
        r = self.run_cli()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_exit_nonzero_on_invalid(self):
        def fn(rows):
            rows[0]["evidence"][0]["quote"] = "틀림"
        self.mutate("labels/entities.jsonl", fn)
        r = self.run_cli()
        self.assertEqual(r.returncode, 1)
        self.assertIn("quote does not match span", r.stdout + r.stderr)


class TestCommittedDataset(unittest.TestCase):
    def test_committed_dataset_is_valid(self):
        errs = validate.validate_dataset(GOLDEN_DIR)
        self.assertEqual(errs, [], "\n".join(errs[:20]))

    def test_committed_dataset_size(self):
        n = sum(len(load(os.path.join(GOLDEN_DIR, "sources", f))) for f in ("mail.jsonl", "wiki.jsonl", "messenger.jsonl"))
        self.assertGreaterEqual(n, 120)
        self.assertLessEqual(n, 180)


if __name__ == "__main__":
    unittest.main()
