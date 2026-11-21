"""R03 embedding benchmark tests (spec R03-K3) with a fake hashing worker. No model is ever loaded."""
import json
import os
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

bench = _paths.load_kit_module("r03-engine-comparison", "embedding_bench.py", "embedding_bench")
FAKE_WORKER = os.path.join(_paths.TESTS_DIR, "fake_embed_worker.py")
FIX = os.path.join(_paths.VERIF_DIR, "fixtures", "records")


class FieldMapTests(unittest.TestCase):
    def test_prefix_policy(self):
        e5 = {"prefix_query": "query: ", "prefix_passage": "passage: "}
        self.assertEqual(bench.apply_prefix(e5, "query", "hello"), "query: hello")
        self.assertEqual(bench.apply_prefix(e5, "passage", "hello"), "passage: hello")
        self.assertEqual(bench.apply_prefix({}, "query", "hello"), "hello")

    def test_models_file_lists_both_candidates_with_license_and_unconfirmed_flags(self):
        models = bench.load_models()
        ids = {m["model_id"] for m in models}
        self.assertEqual(ids, {"BAAI/bge-m3", "intfloat/multilingual-e5-base"})
        for m in models:
            self.assertIn("license_claim", m)
            self.assertIn("prefix_source", m)

    def test_load_sources_with_field_map(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "a.jsonl")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"doc": "d1", "body": "hello", "language": "en"}) + "\n")
            recs = bench.load_sources(d, {"source_id": "doc", "source_text": "body", "source_lang": "language"})
            self.assertEqual(recs, [{"id": "d1", "text": "hello", "lang": "en"}])

    def test_missing_field_gives_actionable_error(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a.jsonl"), "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"x": 1}) + "\n")
            with self.assertRaises(bench.GoldenFormatError) as cm:
                bench.load_sources(d, bench.DEFAULT_FIELD_MAP)
            self.assertIn("inspect-golden", str(cm.exception))

    def test_describe_golden_lists_keys(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sources"))
            with open(os.path.join(d, "sources", "a.jsonl"), "w", encoding="utf-8") as fh:
                fh.write(json.dumps({"id": "d1", "text": "t", "extra": 1}) + "\n")
            info = bench.describe_golden(d)
            self.assertIn("extra", info["sources/a.jsonl"]["keys"])


class BenchTests(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(FIX, "sources.jsonl"), encoding="utf-8") as fh:
            self.docs = [json.loads(x) for x in fh if x.strip()]
        self.queries = [{"query_id": "q1", "query": "rail line closes for repairs", "lang": "en"},
                        {"query_id": "q2", "query": "new pier construction budget", "lang": "en"}]

    def run_bench(self, out):
        argv = [sys.executable, FAKE_WORKER]
        return bench.run_embedding_bench({"model_id": "fake"}, argv, self.docs, self.queries, out, top_k=3, timeout_s=60)

    def test_predictions_file_is_written_and_deterministic(self):
        with tempfile.TemporaryDirectory() as d:
            r1 = self.run_bench(os.path.join(d, "p1.jsonl"))
            r2 = self.run_bench(os.path.join(d, "p2.jsonl"))
            with open(os.path.join(d, "p1.jsonl"), encoding="utf-8") as a, open(os.path.join(d, "p2.jsonl"), encoding="utf-8") as b:
                self.assertEqual(a.read(), b.read())
            with open(os.path.join(d, "p1.jsonl"), encoding="utf-8") as fh:
                lines = [json.loads(x) for x in fh]
        self.assertEqual([x["query_id"] for x in lines], ["q1", "q2"])
        self.assertIn(lines[0]["ranked"][0]["doc_id"], ("s4", "s5"))
        self.assertEqual(lines[1]["ranked"][0]["doc_id"], "s3")
        self.assertEqual(r1["dim"], 64)

    def test_metrics_reported(self):
        with tempfile.TemporaryDirectory() as d:
            res = self.run_bench(os.path.join(d, "p.jsonl"))
        for key in ("load_s", "docs_per_s", "peak_rss_bytes", "dim", "wall_s", "queries", "docs"):
            self.assertIn(key, res)
        self.assertEqual(res["docs"], 6)

    def test_cosine_rank(self):
        ranked = bench.rank([1.0, 0.0], {"a": [1.0, 0.0], "b": [0.0, 1.0], "c": [0.7, 0.7]}, 2)
        self.assertEqual([x[0] for x in ranked], ["a", "c"])

    def test_worker_that_signals_not_implemented_is_a_notice(self):
        argv = [sys.executable, "-c", "import sys; sys.stderr.write('stub'); sys.exit(3)"]
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(NotImplementedError):
                bench.run_embedding_bench({"model_id": "x"}, argv, self.docs, self.queries, os.path.join(d, "p"), top_k=3, timeout_s=30)


if __name__ == "__main__":
    unittest.main()
