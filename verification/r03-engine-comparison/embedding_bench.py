"""Embedding benchmark runner (R03-C3): speed, memory, predictions file for eval/scorer/score.py.

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only); no embedding model has ever been loaded or downloaded. The runner talks to an
external WORKER process over JSON Lines, so the heavy library lives only in the worker. Unit tests use
a hashing fake worker.

CONTRACT ASSUMPTIONS (eval/golden is authored in parallel; field names are NOT confirmed):
  eval/golden/sources/*.jsonl  SourceRecords, eval/golden/labels/*.jsonl, eval/golden/splits.json,
  eval/scorer/score.py taking a predictions JSONL. DEFAULT_FIELD_MAP below holds every assumed name in
  one place; override with --field-map or fix after `run.py inspect-golden` shows the real keys.

Worker protocol (stdin JSONL in, stdout JSONL out):
  in : {"id": str, "text": str, "kind": "query"|"passage"}   (prefixes from models.json are already applied)
  out: first {"event":"loaded","seconds":float,"dim":int}, then {"id": str, "vector": [floats]} per input.
  Exit code 3 = the worker is an unfinished stub (R03-S5); the runner turns it into NotImplementedError.
"""
import glob
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

from common import runner  # noqa: E402

DEFAULT_FIELD_MAP = {
    "source_id": "id", "source_text": "text", "source_lang": "lang",
    "query_id": "query_id", "query_text": "query", "query_lang": "lang", "relevant_ids": "relevant",
    "pred_query_id": "query_id", "pred_ranked": "ranked", "pred_doc_id": "doc_id", "pred_score": "score",
}
MODELS_PATH = os.path.join(HERE, "models.json")


class GoldenFormatError(Exception):
    pass


def load_models(path=MODELS_PATH):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["models"]


def apply_prefix(model, kind, text):
    return (model.get("prefix_query", "") if kind == "query" else model.get("prefix_passage", "")) + text


def _jsonl_files(path):
    if os.path.isdir(path):
        return sorted(glob.glob(os.path.join(path, "*.jsonl")))
    return [path]


def _read_jsonl(path):
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            if line.strip():
                yield n, json.loads(line)


def load_sources(path, field_map):
    out = []
    for file in _jsonl_files(path):
        for n, row in _read_jsonl(file):
            try:
                rec = {"id": row[field_map["source_id"]], "text": row[field_map["source_text"]]}
            except KeyError as exc:
                raise GoldenFormatError("{}:{} has no field {}; run `run.py inspect-golden` and pass --field-map".format(
                    os.path.basename(file), n, exc))
            lang = row.get(field_map.get("source_lang", ""))
            if lang is not None:
                rec["lang"] = lang
            out.append(rec)
    return out


def load_queries(labels_path, field_map, split_ids=None):
    out = []
    for file in _jsonl_files(labels_path):
        for n, row in _read_jsonl(file):
            try:
                q = {"query_id": row[field_map["query_id"]], "query": row[field_map["query_text"]]}
            except KeyError as exc:
                raise GoldenFormatError("{}:{} has no field {}; run `run.py inspect-golden` and pass --field-map".format(
                    os.path.basename(file), n, exc))
            if row.get(field_map.get("query_lang", "")) is not None:
                q["lang"] = row[field_map["query_lang"]]
            if split_ids is None or q["query_id"] in split_ids:
                out.append(q)
    return out


def describe_golden(root):
    """Keys of the first lines of every golden file, so the operator can fix the field map."""
    info = {}
    for sub in ("sources", "labels"):
        for file in sorted(glob.glob(os.path.join(root, sub, "*.jsonl"))):
            keys, lines = set(), 0
            for _n, row in _read_jsonl(file):
                lines += 1
                if lines <= 3 and isinstance(row, dict):
                    keys.update(row.keys())
            info["{}/{}".format(sub, os.path.basename(file))] = {"keys": sorted(keys), "lines": lines}
    splits = os.path.join(root, "splits.json")
    if os.path.exists(splits):
        with open(splits, encoding="utf-8") as fh:
            data = json.load(fh)
        info["splits.json"] = {"keys": sorted(data.keys()) if isinstance(data, dict) else [type(data).__name__], "lines": 1}
    return info


def rank(query_vec, doc_vecs, k):
    def cos(a, b):
        na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
        return sum(x * y for x, y in zip(a, b)) / (na * nb) if na and nb else 0.0
    scored = sorted(((did, cos(query_vec, v)) for did, v in doc_vecs.items()), key=lambda t: (-t[1], t[0]))
    return scored[:k]


def format_prediction(query_id, ranked, field_map=None):
    fm = field_map or DEFAULT_FIELD_MAP
    return {fm["pred_query_id"]: query_id,
            fm["pred_ranked"]: [{fm["pred_doc_id"]: d, fm["pred_score"]: round(s, 6)} for d, s in ranked]}


def run_embedding_bench(model, worker_argv, docs, queries, out_path, top_k=10, timeout_s=3600,
                        field_map=None, extra_env=None):
    lines = []
    for d in docs:
        lines.append(json.dumps({"id": "d:" + d["id"], "text": apply_prefix(model, "passage", d["text"]), "kind": "passage"}, ensure_ascii=False))
    for q in queries:
        lines.append(json.dumps({"id": "q:" + q["query_id"], "text": apply_prefix(model, "query", q["query"]), "kind": "query"}, ensure_ascii=False))
    started = time.time()
    res = runner.run_process(worker_argv, stdin_text="\n".join(lines) + "\n", timeout_s=timeout_s,
                             max_output_bytes=10 ** 9, sample_interval_s=0.5, extra_env=extra_env)
    wall = time.time() - started
    if res.error == "not_found":
        raise NotImplementedError("R03-S5: embedding worker command not found (it must be set up on site)")
    if res.returncode == 3:
        raise NotImplementedError("R03-S5: embedding worker is an unfinished stub: " + res.stderr.strip()[:300])
    if res.timed_out or res.returncode != 0:
        raise RuntimeError("embedding worker failed: exit={} timed_out={} stderr={}".format(res.returncode, res.timed_out, res.stderr[-300:]))
    load_s, dim, vectors = 0.0, 0, {}
    for raw in res.stdout.splitlines():
        if not raw.strip():
            continue
        msg = json.loads(raw)
        if msg.get("event") == "loaded":
            load_s, dim = float(msg.get("seconds", 0.0)), int(msg.get("dim", 0))
        else:
            vectors[msg["id"]] = msg["vector"]
    doc_vecs = {d["id"]: vectors["d:" + d["id"]] for d in docs}
    with open(out_path, "w", encoding="utf-8") as fh:
        for q in queries:
            ranked = rank(vectors["q:" + q["query_id"]], doc_vecs, top_k)
            fh.write(json.dumps(format_prediction(q["query_id"], ranked, field_map), ensure_ascii=False) + "\n")
    encode_s = max(wall - load_s, 1e-6)
    return {"model_id": model.get("model_id"), "docs": len(docs), "queries": len(queries), "dim": dim, "load_s": round(load_s, 3),
            "wall_s": round(wall, 3), "docs_per_s": round(len(docs) / encode_s, 2), "peak_rss_bytes": res.peak_rss_bytes,
            "peak_process_count": res.peak_process_count, "predictions_path": os.path.basename(out_path)}
