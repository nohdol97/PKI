import json
import os
import tempfile
import unittest

from fixture import GOLDEN_DIR, make_dataset, write_jsonl
import score


class TestRankingMetrics(unittest.TestCase):
    def test_recall_at_k(self):
        self.assertAlmostEqual(score.recall_at_k(["a", "b", "c"], {"a", "c", "z"}, 2), 1 / 3)
        self.assertAlmostEqual(score.recall_at_k(["a", "b", "c"], {"a", "c", "z"}, 3), 2 / 3)

    def test_recall_empty_relevant_is_none(self):
        self.assertIsNone(score.recall_at_k(["a"], set(), 3))

    def test_precision_at_k_divides_by_k_even_if_short(self):
        self.assertAlmostEqual(score.precision_at_k(["a"], {"a"}, 4), 0.25)
        self.assertAlmostEqual(score.precision_at_k(["a", "x", "a"], {"a"}, 3), 1 / 3)

    def test_duplicates_in_ranking_count_once(self):
        # duplicate record ids are collapsed (first occurrence keeps its rank)
        self.assertAlmostEqual(score.recall_at_k(["a", "a", "b"], {"a", "b"}, 2), 1.0)

    def test_reciprocal_rank(self):
        self.assertEqual(score.reciprocal_rank(["x", "y", "a"], {"a"}), 1 / 3)
        self.assertEqual(score.reciprocal_rank(["x"], {"a"}), 0.0)
        self.assertEqual(score.reciprocal_rank(["a"], {"a"}), 1.0)

    def test_reciprocal_rank_dedupes_ranked(self):
        # a repeated id must not push the first relevant hit down (kills the no-dedupe mutation)
        self.assertEqual(score.reciprocal_rank(["x", "x", "a"], {"a"}), 0.5)

    def test_k_must_be_positive(self):
        with self.assertRaises(ValueError):
            score.recall_at_k(["a"], {"a"}, 0)


class TestRelationMetrics(unittest.TestCase):
    def test_precision_recall_and_forbidden(self):
        gold = {("p", "DEPENDS_ON", "s"), ("a", "BELONGS_TO", "t")}
        forbidden = {("p", "DEPENDS_ON", "s2")}
        pred = {("p", "DEPENDS_ON", "s"), ("p", "DEPENDS_ON", "s2"), ("x", "RELATED_TO", "y")}
        m = score.relation_metrics(pred, gold, forbidden)
        self.assertAlmostEqual(m["precision"], 1 / 3)
        self.assertAlmostEqual(m["recall"], 1 / 2)
        self.assertEqual(m["forbidden_hits"], 1)
        self.assertAlmostEqual(m["forbidden_rate"], 1.0)

    def test_relation_type_must_match(self):
        m = score.relation_metrics({("p", "RELATED_TO", "s")}, {("p", "DEPENDS_ON", "s")}, set())
        self.assertEqual(m["recall"], 0.0)

    def test_no_predictions(self):
        m = score.relation_metrics(set(), {("a", "BELONGS_TO", "b")}, set())
        self.assertEqual(m["precision"], 0.0)
        self.assertEqual(m["recall"], 0.0)


class TestRelationEdgeCases(unittest.TestCase):
    def test_symmetric_types_ignore_direction(self):
        for rel in ("CONTRADICTS", "RELATED_TO"):
            m = score.relation_metrics({("b", rel, "a")}, {("a", rel, "b")}, set())
            self.assertEqual(m["recall"], 1.0, rel)

    def test_directed_types_keep_direction(self):
        m = score.relation_metrics({("b", "DEPENDS_ON", "a")}, {("a", "DEPENDS_ON", "b")}, set())
        self.assertEqual(m["recall"], 0.0)

    def test_unjudged_count_is_reported_not_scored(self):
        m = score.relation_metrics({("a", "DEPENDS_ON", "b")}, {("a", "DEPENDS_ON", "b")}, set(), unjudged=3)
        self.assertEqual(m["precision"], 1.0)
        self.assertEqual(m["n_unjudged"], 3)


class TestEntityMetrics(unittest.TestCase):
    def test_recall_and_surfaced_absent(self):
        m = score.entity_metrics({"a", "x"}, present={"a", "b"}, absent={"x", "y"})
        self.assertAlmostEqual(m["recall"], 0.5)
        self.assertEqual(m["surfaced_absent"], 1)
        self.assertEqual(m["n_absent"], 2)

    def test_absent_entities_do_not_count_as_gold(self):
        m = score.entity_metrics({"a"}, present={"a"}, absent={"gone"})
        self.assertEqual(m["recall"], 1.0)
        self.assertEqual(m["surfaced_absent"], 0)


class TestPairwiseF1(unittest.TestCase):
    def test_f1(self):
        gold = {"p1": True, "p2": True, "p3": False, "p4": False}
        pred = {"p1": True, "p2": False, "p3": True, "p4": False}
        m = score.pairwise_f1(pred, gold)
        self.assertAlmostEqual(m["precision"], 0.5)
        self.assertAlmostEqual(m["recall"], 0.5)
        self.assertAlmostEqual(m["f1"], 0.5)
        self.assertAlmostEqual(m["false_merge_rate"], 0.5)

    def test_missing_prediction_counts_as_not_same(self):
        m = score.pairwise_f1({}, {"p1": True, "p2": False})
        self.assertEqual(m["recall"], 0.0)
        self.assertEqual(m["false_merge_rate"], 0.0)
        self.assertEqual(m["missing"], 2)

    def test_perfect(self):
        gold = {"p1": True, "p2": False}
        self.assertEqual(score.pairwise_f1(dict(gold), gold)["f1"], 1.0)


class TestCitation(unittest.TestCase):
    def test_accuracy_recall_forbidden(self):
        required = {"q1": {("r1", 1), ("r2", 1)}, "q2": {("r3", 1)}}
        forbidden = {"q3": {("r9", 1)}}
        pred = {
            "q1": [("r1", 1), ("r7", 1)],
            "q2": [("r3", 1)],
            "q3": [("r9", 1)],
        }
        m = score.citation_metrics(pred, required, forbidden)
        # predicted 4 citations, 2 correct
        self.assertAlmostEqual(m["accuracy"], 2 / 4)
        self.assertAlmostEqual(m["recall"], 2 / 3)
        self.assertEqual(m["forbidden_citations"], 1)

    def test_duplicate_citations_count_once(self):
        m = score.citation_metrics({"q1": [("r1", 1), ("r1", 1)]}, {"q1": {("r1", 1)}}, {})
        self.assertEqual(m["n_predicted"], 1)
        self.assertEqual(m["accuracy"], 1.0)

    def test_version_must_match(self):
        m = score.citation_metrics({"q1": [("r1", 2)]}, {"q1": {("r1", 1)}}, {})
        self.assertEqual(m["accuracy"], 0.0)

    def test_citing_for_unanswerable_is_incorrect_even_if_not_forbidden_record(self):
        m = score.citation_metrics({"q3": [("r5", 1)]}, {}, {"q3": {("r9", 1)}})
        self.assertEqual(m["accuracy"], 0.0)
        self.assertEqual(m["forbidden_citations"], 0)

    def test_no_citations_predicted(self):
        m = score.citation_metrics({}, {"q1": {("r1", 1)}}, {})
        self.assertEqual(m["accuracy"], 0.0)
        self.assertEqual(m["recall"], 0.0)


class TestScoreEndToEnd(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = make_dataset(os.path.join(self._tmp.name, "g"))
        self.pred_path = os.path.join(self._tmp.name, "pred.jsonl")

    def tearDown(self):
        self._tmp.cleanup()

    def test_scores_from_predictions_file(self):
        write_jsonl(self.pred_path, [
            {"kind": "retrieval", "query_id": "T1:qa-1", "ranked": ["mes-0002", "mes-0001"]},
            {"kind": "retrieval", "query_id": "T1:qa-2", "ranked": ["wik-0001", "mai-0001"]},
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys"},
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys2"},
            {"kind": "resolution", "pair_id": "T1:pair-1", "same": True},
            {"kind": "resolution", "pair_id": "T1:pair-2", "same": False},
            {"kind": "citation", "query_id": "T1:qa-1", "citations": [{"record_id": "mes-0001", "version": 1}]},
            {"kind": "citation", "query_id": "T1:qa-3", "citations": []},
        ])
        res = score.score(self.root, self.pred_path, k=2)
        r = res["retrieval"]
        self.assertEqual(r["n_queries"], 2)
        self.assertAlmostEqual(r["recall_at_k"], 1.0)
        self.assertAlmostEqual(r["mrr"], (0.5 + 1.0) / 2)
        self.assertAlmostEqual(r["precision_at_k"], (0.5 + 1.0) / 2)
        self.assertAlmostEqual(res["relations"]["precision"], 0.5)
        self.assertAlmostEqual(res["relations"]["recall"], 0.5)
        self.assertEqual(res["relations"]["forbidden_hits"], 1)
        self.assertEqual(res["resolution"]["f1"], 1.0)
        self.assertEqual(res["citation"]["forbidden_citations"], 0)

    def test_split_filter_excludes_other_split(self):
        write_jsonl(self.pred_path, [
            {"kind": "retrieval", "query_id": "T1:qa-1", "ranked": ["mes-0001"]},
        ])
        res = score.score(self.root, self.pred_path, split="eval", k=2)
        self.assertEqual(res["retrieval"]["n_queries"], 0)

    def test_scenario_filter(self):
        write_jsonl(self.pred_path, [])
        res = score.score(self.root, self.pred_path, scenarios=["deletion"], k=2)
        self.assertEqual(res["retrieval"]["n_queries"], 0)

    def test_unknown_prediction_kind_is_error(self):
        write_jsonl(self.pred_path, [{"kind": "mystery"}])
        with self.assertRaises(ValueError):
            score.score(self.root, self.pred_path)

    def test_relation_split_filter_drops_other_split_predictions(self):
        # T1 is dev: under --split eval its relation predictions must not be scored (kills the no-filter mutation)
        write_jsonl(self.pred_path, [
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys"},
        ])
        res = score.score(self.root, self.pred_path, split="eval")
        self.assertEqual(res["relations"]["n_predicted"], 0)
        res = score.score(self.root, self.pred_path, split="dev")
        self.assertEqual(res["relations"]["n_predicted"], 1)

    def test_unknown_relation_entity_is_error(self):
        write_jsonl(self.pred_path, [{"kind": "relation", "subject": "T1:nobody", "relation": "DEPENDS_ON", "object": "T1:sys"}])
        with self.assertRaises(ValueError):
            score.score(self.root, self.pred_path)

    def test_unknown_relation_type_is_error(self):
        write_jsonl(self.pred_path, [{"kind": "relation", "subject": "T1:proj", "relation": "LIKES", "object": "T1:sys"}])
        with self.assertRaises(ValueError):
            score.score(self.root, self.pred_path)

    def test_unjudged_relation_is_reported_separately(self):
        write_jsonl(self.pred_path, [
            {"kind": "relation", "subject": "x", "relation": "DEPENDS_ON", "object": "y", "judged": False},
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys"},
        ])
        res = score.score(self.root, self.pred_path)
        self.assertEqual(res["relations"]["n_unjudged"], 1)
        self.assertEqual(res["relations"]["precision"], 1.0)

    def test_judged_false_cannot_hide_gold_id_relations(self):
        # N1: a prediction file must not exempt its own relations. Both endpoints are gold ids,
        # so the scorer judges them whatever the `judged` field says.
        write_jsonl(self.pred_path, [
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys2", "judged": False},
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "T1:sys", "judged": False},
        ])
        res = score.score(self.root, self.pred_path)
        self.assertEqual(res["relations"]["forbidden_hits"], 1)
        self.assertEqual(res["relations"]["n_predicted"], 2)
        self.assertEqual(res["relations"]["n_unjudged"], 0)
        self.assertAlmostEqual(res["relations"]["precision"], 0.5)

    def test_judged_false_honoured_when_an_endpoint_is_not_a_gold_id(self):
        write_jsonl(self.pred_path, [
            {"kind": "relation", "subject": "T1:proj", "relation": "DEPENDS_ON", "object": "not-gold", "judged": False},
        ])
        res = score.score(self.root, self.pred_path)
        self.assertEqual(res["relations"]["n_unjudged"], 1)
        self.assertEqual(res["relations"]["n_predicted"], 0)

    def test_entity_predictions_scored_with_absent_marker(self):
        # T1:sys2 is marked expected-absent in the fixture; surfacing it is a violation, not recall
        write_jsonl(self.pred_path, [
            {"kind": "entity", "entity_id": "T1:proj"},
            {"kind": "entity", "entity_id": "T1:sys2"},
        ])
        res = score.score(self.root, self.pred_path)
        self.assertEqual(res["entities"]["surfaced_absent"], 1)
        self.assertAlmostEqual(res["entities"]["recall"], 1 / 3)

    def test_unknown_entity_prediction_is_error(self):
        write_jsonl(self.pred_path, [{"kind": "entity", "entity_id": "T1:nobody"}])
        with self.assertRaises(ValueError):
            score.score(self.root, self.pred_path)

    def test_unknown_query_id_is_error(self):
        write_jsonl(self.pred_path, [{"kind": "retrieval", "query_id": "nope", "ranked": []}])
        with self.assertRaises(ValueError):
            score.score(self.root, self.pred_path)


class TestOracleOnCommittedDataset(unittest.TestCase):
    """Gold-derived predictions must score perfectly; this checks the scorer wiring,
    not any product."""

    def test_oracle_scores_perfect(self):
        def load(name):
            with open(os.path.join(GOLDEN_DIR, "labels", name), encoding="utf-8") as fh:
                return [json.loads(x) for x in fh if x.strip()]
        rows = []
        for q in load("qa.jsonl"):
            if q["answerable"]:
                ids = []
                for e in q["evidence"]:
                    if e["record_id"] not in ids:
                        ids.append(e["record_id"])
                rows.append({"kind": "retrieval", "query_id": q["label_id"], "ranked": ids})
                rows.append({"kind": "citation", "query_id": q["label_id"],
                             "citations": [{"record_id": e["record_id"], "version": e["version"]} for e in q["evidence"]]})
            else:
                rows.append({"kind": "citation", "query_id": q["label_id"], "citations": []})
        for r in load("relations.jsonl"):
            if r["expected"]:
                rows.append({"kind": "relation", "subject": r["subject"], "relation": r["relation"], "object": r["object"]})
        for p in load("resolution_pairs.jsonl"):
            rows.append({"kind": "resolution", "pair_id": p["label_id"], "same": p["same"]})
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "oracle.jsonl")
            write_jsonl(path, rows)
            res = score.score(GOLDEN_DIR, path, k=5)
        self.assertEqual(res["retrieval"]["recall_at_k"], 1.0)
        self.assertEqual(res["retrieval"]["mrr"], 1.0)
        self.assertEqual(res["relations"]["precision"], 1.0)
        self.assertEqual(res["relations"]["recall"], 1.0)
        self.assertEqual(res["relations"]["forbidden_hits"], 0)
        self.assertEqual(res["resolution"]["f1"], 1.0)
        self.assertEqual(res["citation"]["accuracy"], 1.0)
        self.assertEqual(res["citation"]["recall"], 1.0)
        self.assertEqual(res["citation"]["forbidden_citations"], 0)


if __name__ == "__main__":
    unittest.main()
