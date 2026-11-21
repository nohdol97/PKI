"""R03 against the REAL committed dataset and scorer (eval/golden, eval/scorer on branch docs/r05-golden-dataset).

The embedding worker is the fake hashing worker, so the predictions are meaningless; these tests only assert the
CONTRACT: field names resolve, the predictions file is accepted by the real scorer with exit 0, and the scorer's JSON
output has the documented shape. They never assert on scores.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

bench = _paths.load_kit_module("r03-engine-comparison", "embedding_bench.py", "embedding_bench")
GOLDEN = os.path.join(_paths.REPO_DIR, "eval", "golden")
SCORER = os.path.join(_paths.REPO_DIR, "eval", "scorer", "score.py")
RUN = os.path.join(_paths.VERIF_DIR, "r03-engine-comparison", "run.py")
FAKE_WORKER = os.path.join(_paths.TESTS_DIR, "fake_embed_worker.py")


class RealDatasetContractTests(unittest.TestCase):
    def test_inspect_golden_passes_on_the_real_dataset(self):
        res = subprocess.run([sys.executable, RUN, "inspect-golden", "--golden", GOLDEN], capture_output=True, text=True, timeout=60)
        self.assertEqual(res.returncode, 0, res.stderr)
        info = json.loads(res.stdout)
        self.assertTrue(any(k.startswith("sources/") for k in info))
        self.assertIn("content", info["sources/mail.jsonl"]["keys"])
        self.assertIn("label_id", info["labels/qa.jsonl"]["keys"])
        self.assertIn("dev", info["splits.json"]["splits"])

    def test_default_field_map_resolves_on_every_source_and_split(self):
        docs = bench.load_sources(os.path.join(GOLDEN, "sources"), bench.DEFAULT_FIELD_MAP)
        self.assertGreater(len(docs), 100)
        self.assertEqual(len({d["id"] for d in docs}), len(docs))
        self.assertTrue(all(d["text"] for d in docs))
        for split in ("dev", "eval"):
            instances = bench.load_split_instances(GOLDEN, split)
            queries = bench.load_queries(os.path.join(GOLDEN, "labels"), bench.DEFAULT_FIELD_MAP, instances)
            self.assertTrue(queries, split)

    def run_bench_and_score(self, split):
        docs = bench.load_sources(os.path.join(GOLDEN, "sources"), bench.DEFAULT_FIELD_MAP)
        queries = bench.load_queries(os.path.join(GOLDEN, "labels"), bench.DEFAULT_FIELD_MAP,
                                     bench.load_split_instances(GOLDEN, split))
        with tempfile.TemporaryDirectory() as d:
            pred = os.path.join(d, "predictions.jsonl")
            metrics = bench.run_embedding_bench({"model_id": "fake"}, [sys.executable, FAKE_WORKER], docs, queries, pred, top_k=10, timeout_s=120)
            res = subprocess.run([sys.executable, SCORER, GOLDEN, pred, "--split", split], capture_output=True, text=True, timeout=120)
        return metrics, queries, res

    def test_predictions_are_accepted_by_the_real_scorer_dev(self):
        metrics, queries, res = self.run_bench_and_score("dev")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        out = json.loads(res.stdout)
        self.assertEqual(out["split"], "dev")
        for section in ("retrieval", "entities", "relations", "resolution", "citation"):
            self.assertIn(section, out)
        for key in ("n_queries", "missing_predictions", "recall_at_k", "precision_at_k", "mrr"):
            self.assertIn(key, out["retrieval"])
        # The scorer counts only ANSWERABLE questions in retrieval; unanswerable ones are predicted too but not counted.
        with open(os.path.join(GOLDEN, "labels", "qa.jsonl"), encoding="utf-8") as fh:
            qa = {r["label_id"]: r for r in map(json.loads, fh)}
        self.assertEqual(out["retrieval"]["n_queries"], sum(1 for q in queries if qa[q["query_id"]]["answerable"]))
        self.assertEqual(out["retrieval"]["missing_predictions"], 0)
        self.assertEqual(metrics["queries"], len(queries))

    def test_predictions_are_accepted_by_the_real_scorer_eval(self):
        _metrics, _queries, res = self.run_bench_and_score("eval")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(json.loads(res.stdout)["split"], "eval")

    def test_run_embed_command_with_automatic_scorer(self):
        with tempfile.TemporaryDirectory() as d:
            res = subprocess.run([sys.executable, RUN, "embed", "--model", "e5-base", "--backend", "command",
                                  "--worker-cmd", json.dumps([sys.executable, FAKE_WORKER]), "--dataset", "golden",
                                  "--golden", GOLDEN, "--split", "dev", "--out", d], capture_output=True, text=True, timeout=300)
            self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
            with open(os.path.join(d, "result.json"), encoding="utf-8") as fh:
                checks = {c["id"]: c for c in json.load(fh)["checks"]}
            self.assertEqual(checks["R03-C3:score:e5-base"]["verdict"], "PASS")

    def test_a_wrong_query_id_is_rejected_by_the_scorer_so_the_contract_is_really_checked(self):
        with tempfile.TemporaryDirectory() as d:
            pred = os.path.join(d, "p.jsonl")
            with open(pred, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"kind": "retrieval", "query_id": "NOPE:qa-9", "ranked": ["mail-0001"]}) + "\n")
            res = subprocess.run([sys.executable, SCORER, GOLDEN, pred, "--split", "dev"], capture_output=True, text=True, timeout=60)
        self.assertNotEqual(res.returncode, 0)


if __name__ == "__main__":
    unittest.main()
