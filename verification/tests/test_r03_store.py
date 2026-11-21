"""R03 TemporalStore tests: product-owned SQLite schema (spec R03-K4). Pure sqlite3, temp files only."""
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

store_mod = _paths.load_kit_module("r03-engine-comparison", "store.py", "store")


class SqliteStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.s = store_mod.SqliteProductStore()
        self.s.open(os.path.join(self.tmp.name, "k.sqlite"))
        self.addCleanup(self.s.close)
        self.s.add_source("s1", "Nolan Reef maintains the lamp. Marta Quill is harbor master.")
        self.s.add_source("s2", "Nolan Reef maintains the lamp every spring.")

    def fact(self, fid, source_ids, **kw):
        ev = [(sid, 0, 10) for sid in source_ids]
        base = dict(subject="lamp", predicate="maintainer", object="Nolan Reef", valid_from="2020-01-01",
                    valid_to=None, recorded_at="2020-01-02")
        base.update(kw)
        self.s.assert_fact(fid, evidence=ev, **base)

    def test_as_of_interval_boundaries(self):
        self.fact("f1", ["s1"], valid_from="2020-01-01", valid_to="2021-01-01")
        self.assertEqual([f["fact_id"] for f in self.s.facts_as_of("lamp", "2020-06-01")], ["f1"])
        self.assertEqual(self.s.facts_as_of("lamp", "2019-12-31"), [])
        self.assertEqual(self.s.facts_as_of("lamp", "2021-01-01"), [])  # valid_to is exclusive

    def test_supersede_closes_old_interval(self):
        self.fact("f1", ["s1"], object="Nolan Reef")
        self.s.supersede("f1", "f2", new_object="Ines Harbor", at="2022-03-01", recorded_at="2022-03-02", evidence=[("s2", 0, 10)])
        self.assertEqual(self.s.facts_as_of("lamp", "2021-01-01")[0]["object"], "Nolan Reef")
        self.assertEqual(self.s.facts_as_of("lamp", "2022-06-01")[0]["object"], "Ines Harbor")

    def test_recorded_time_hides_facts_not_yet_known(self):
        self.fact("f1", ["s1"], recorded_at="2024-01-01")
        self.assertEqual(self.s.facts_as_of("lamp", "2020-06-01", recorded_as_of="2023-01-01"), [])
        self.assertEqual(len(self.s.facts_as_of("lamp", "2020-06-01", recorded_as_of="2025-01-01")), 1)

    def test_retracted_fact_excluded_after_retraction(self):
        self.fact("f1", ["s1"])
        self.s.retract("f1", "2021-05-05")
        self.assertEqual(len(self.s.facts_as_of("lamp", "2020-06-01", recorded_as_of="2021-01-01")), 1)
        self.assertEqual(self.s.facts_as_of("lamp", "2020-06-01", recorded_as_of="2021-06-01"), [])

    def test_evidence_span_must_match_source_text(self):
        with self.assertRaises(ValueError):
            self.s.assert_fact("bad", subject="a", predicate="b", object="c", valid_from="2020-01-01", valid_to=None,
                               recorded_at="2020-01-01", evidence=[("s1", 5, 999999)])
        self.fact("f1", ["s1"])
        quote = self.s.evidence_for("f1")[0]["quote"]
        self.assertEqual(quote, "Nolan Reef")
        self.assertEqual(quote, self.s.source_text("s1")[0:10])

    def test_delete_source_removes_only_unshared_facts(self):
        self.fact("shared", ["s1", "s2"])
        self.fact("only_s1", ["s1"], subject="harbor", predicate="master", object="Marta Quill")
        report = self.s.delete_source("s1")
        self.assertEqual(report["facts_removed"], 1)
        self.assertEqual(report["facts_kept_shared"], 1)
        self.assertEqual(report["history_rows_remaining"], 0)
        self.assertEqual([f["fact_id"] for f in self.s.facts_as_of("lamp", "2020-06-01")], ["shared"])
        self.assertEqual(self.s.facts_as_of("harbor", "2020-06-01"), [])
        self.assertNotIn("s1", self.s.export()["source_ids"])
        self.assertEqual([e["source_id"] for e in self.s.evidence_for("shared")], ["s2"])

    def test_delete_dry_run_changes_nothing(self):
        self.fact("only_s1", ["s1"])
        report = self.s.delete_source("s1", dry_run=True)
        self.assertEqual(report["facts_removed"], 1)
        self.assertEqual(len(self.s.facts_as_of("lamp", "2020-06-01")), 1)
        self.assertIn("s1", self.s.export()["source_ids"])

    def test_export_contains_facts_with_evidence_and_integrity_ok(self):
        self.fact("f1", ["s1"])
        exp = self.s.export()
        self.assertEqual(exp["facts"][0]["evidence"][0]["source_id"], "s1")
        self.assertEqual(self.s.integrity(), [])

    def test_user_origin_fact_is_marked(self):
        self.fact("u1", ["s1"], origin="user")
        self.assertEqual(self.s.facts_as_of("lamp", "2020-06-01")[0]["origin"], "user")


class StoreChecksTests(unittest.TestCase):
    def test_standard_check_series_passes_for_product_store(self):
        with tempfile.TemporaryDirectory() as d:
            results = store_mod.run_store_checks(store_mod.SqliteProductStore, os.path.join(d, "k.sqlite"))
        failed = [r for r in results if not r["ok"]]
        self.assertEqual(failed, [])
        self.assertTrue({"as_of", "span_evidence", "delete_lineage", "history_rows_after_delete", "export"} <= {r["name"] for r in results})

    def test_cortexdb_is_a_stub_with_notice(self):
        s = store_mod.CortexDbStore()
        with self.assertRaises(NotImplementedError) as cm:
            s.open("x")
        self.assertIn("R03-S4", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
