#!/usr/bin/env python3
"""Score a predictions JSONL against the golden labels (stdlib only).

Usage: python3 score.py <golden_dir> <predictions.jsonl> [--split dev|eval] [--scenario NAME ...] [--k 5]
The predictions format is documented in eval/scorer/README.md.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from common import load_json, load_jsonl  # noqa: E402


def _dedupe(ranked):
    seen = set()
    out = []
    for item in ranked:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _check_k(k):
    if k < 1:
        raise ValueError("k must be >= 1")


def recall_at_k(ranked, relevant, k):
    """Share of relevant ids found in the top k. None when there is nothing relevant."""
    _check_k(k)
    if not relevant:
        return None
    top = set(_dedupe(ranked)[:k])
    return len(top & set(relevant)) / len(relevant)


def precision_at_k(ranked, relevant, k):
    """Relevant hits in the top k divided by k (a short list is not rewarded)."""
    _check_k(k)
    top = set(_dedupe(ranked)[:k])
    return len(top & set(relevant)) / k


def reciprocal_rank(ranked, relevant):
    for i, item in enumerate(_dedupe(ranked), start=1):
        if item in relevant:
            return 1.0 / i
    return 0.0


def _safe_div(a, b):
    return a / b if b else 0.0


def _f1(p, r):
    return _safe_div(2 * p * r, p + r)


def relation_metrics(predicted, gold, forbidden):
    """predicted/gold/forbidden are sets of (subject, relation, object)."""
    predicted, gold, forbidden = set(predicted), set(gold), set(forbidden)
    tp = len(predicted & gold)
    hits = len(predicted & forbidden)
    p = _safe_div(tp, len(predicted))
    r = _safe_div(tp, len(gold))
    return {
        "precision": p,
        "recall": r,
        "f1": _f1(p, r),
        "n_predicted": len(predicted),
        "n_gold": len(gold),
        "forbidden_hits": hits,
        "forbidden_rate": _safe_div(hits, len(forbidden)),
    }


def pairwise_f1(predicted, gold):
    """predicted/gold: {pair_id: bool same-entity}. A missing prediction means 'not same'."""
    tp = fp = fn = 0
    gold_neg = 0
    false_merge = 0
    missing = 0
    for pid, g in gold.items():
        if pid not in predicted:
            missing += 1
        p = bool(predicted.get(pid, False))
        if g:
            if p:
                tp += 1
            else:
                fn += 1
        else:
            gold_neg += 1
            if p:
                fp += 1
                false_merge += 1
    prec = _safe_div(tp, tp + fp)
    rec = _safe_div(tp, tp + fn)
    return {
        "precision": prec,
        "recall": rec,
        "f1": _f1(prec, rec),
        "false_merge_rate": _safe_div(false_merge, gold_neg),
        "n_pairs": len(gold),
        "missing": missing,
    }


def citation_metrics(predicted, required, forbidden):
    """predicted: {query_id: [(record_id, version)]}; required: {query_id: set of pairs} for
    answerable questions; forbidden: {query_id: set of pairs} for unanswerable ones."""
    n_pred = n_correct = forbidden_cites = 0
    req_total = req_covered = 0
    for qid, req in required.items():
        cited = set(predicted.get(qid, []))
        req_total += len(req)
        req_covered += len(cited & req)
    for qid, cites in predicted.items():
        n_pred += len(cites)
        if qid in required:
            n_correct += sum(1 for c in cites if c in required[qid])
        elif qid in forbidden:
            forbidden_cites += sum(1 for c in cites if c in forbidden[qid])
    return {
        "accuracy": _safe_div(n_correct, n_pred),
        "recall": _safe_div(req_covered, req_total),
        "forbidden_citations": forbidden_cites,
        "n_predicted": n_pred,
    }


def _scope_instances(golden_dir, split, scenarios):
    splits = load_json(os.path.join(golden_dir, "splits.json"))
    insts = splits["instances"]
    chosen = set(insts)
    if split is not None:
        if split not in splits["splits"]:
            raise ValueError("unknown split: %s" % split)
        chosen &= set(splits["splits"][split])
    if scenarios:
        chosen = {i for i in chosen if insts[i]["scenario"] in set(scenarios)}
    return chosen


def _mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else 0.0


def score(golden_dir, predictions_path, split=None, scenarios=None, k=5):
    _check_k(k)
    labels = os.path.join(golden_dir, "labels")
    scope = _scope_instances(golden_dir, split, scenarios)
    qa = {q["label_id"]: q for q in load_jsonl(os.path.join(labels, "qa.jsonl"))}
    pairs = {p["label_id"]: p for p in load_jsonl(os.path.join(labels, "resolution_pairs.jsonl"))}
    relations = load_jsonl(os.path.join(labels, "relations.jsonl"))
    entities = {e["entity_id"]: e["scenario_instance"] for e in load_jsonl(os.path.join(labels, "entities.jsonl"))}

    retrieval_pred = {}
    citation_pred = {}
    resolution_pred = {}
    relation_pred = set()
    for row in load_jsonl(predictions_path):
        kind = row.get("kind")
        if kind == "retrieval":
            if row["query_id"] not in qa:
                raise ValueError("unknown query_id: %s" % row["query_id"])
            ranked = [x["record_id"] if isinstance(x, dict) else x for x in row["ranked"]]
            retrieval_pred[row["query_id"]] = ranked
        elif kind == "citation":
            if row["query_id"] not in qa:
                raise ValueError("unknown query_id: %s" % row["query_id"])
            citation_pred[row["query_id"]] = [(c["record_id"], c["version"]) for c in row["citations"]]
        elif kind == "resolution":
            if row["pair_id"] not in pairs:
                raise ValueError("unknown pair_id: %s" % row["pair_id"])
            resolution_pred[row["pair_id"]] = bool(row["same"])
        elif kind == "relation":
            relation_pred.add((row["subject"], row["relation"], row["object"]))
        else:
            raise ValueError("unknown prediction kind: %r" % (kind,))

    answerable = {qid: q for qid, q in qa.items() if q["scenario_instance"] in scope and q["answerable"]}
    unanswerable = {qid: q for qid, q in qa.items() if q["scenario_instance"] in scope and not q["answerable"]}

    recalls, precisions, rrs = [], [], []
    missing = 0
    for qid, q in answerable.items():
        relevant = {e["record_id"] for e in q["evidence"]}
        if qid not in retrieval_pred:
            missing += 1
        ranked = retrieval_pred.get(qid, [])
        recalls.append(recall_at_k(ranked, relevant, k))
        precisions.append(precision_at_k(ranked, relevant, k))
        rrs.append(reciprocal_rank(ranked, relevant))

    gold_rel = {(r["subject"], r["relation"], r["object"]) for r in relations
                if r["scenario_instance"] in scope and r["expected"]}
    forb_rel = {(r["subject"], r["relation"], r["object"]) for r in relations
                if r["scenario_instance"] in scope and not r["expected"]}
    pred_rel = {t for t in relation_pred if entities.get(t[0]) in scope}

    gold_pairs = {pid: p["same"] for pid, p in pairs.items() if p["scenario_instance"] in scope}
    pred_pairs = {pid: v for pid, v in resolution_pred.items() if pid in gold_pairs}

    required = {qid: {(e["record_id"], e["version"]) for e in q["evidence"]} for qid, q in answerable.items()}
    forbidden = {qid: {(e["record_id"], e["version"]) for e in q["evidence"]} for qid, q in unanswerable.items()}
    pred_cites = {qid: c for qid, c in citation_pred.items() if qid in required or qid in forbidden}

    return {
        "split": split,
        "scenarios": sorted(scenarios) if scenarios else None,
        "k": k,
        "retrieval": {
            "n_queries": len(answerable),
            "missing_predictions": missing,
            "recall_at_k": _mean(recalls),
            "precision_at_k": _mean(precisions),
            "mrr": _mean(rrs),
        },
        "relations": relation_metrics(pred_rel, gold_rel, forb_rel),
        "resolution": pairwise_f1(pred_pairs, gold_pairs),
        "citation": citation_metrics(pred_cites, required, forbidden),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("golden_dir")
    ap.add_argument("predictions")
    ap.add_argument("--split", choices=["dev", "eval"])
    ap.add_argument("--scenario", action="append", dest="scenarios")
    ap.add_argument("--k", type=int, default=5)
    args = ap.parse_args(argv)
    result = score(args.golden_dir, args.predictions, split=args.split, scenarios=args.scenarios, k=args.k)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
