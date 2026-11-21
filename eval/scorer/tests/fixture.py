"""Tiny valid golden dataset for scorer/validator tests (not the real dataset)."""
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCORER_DIR = os.path.dirname(HERE)
REPO_ROOT = os.path.dirname(os.path.dirname(SCORER_DIR))
GOLDEN_DIR = os.path.join(REPO_ROOT, "eval", "golden")
if SCORER_DIR not in sys.path:
    sys.path.insert(0, SCORER_DIR)

CONTENT_1 = "한서윤은 오로라 프로젝트를 담당한다. 오로라는 정산 API에 의존한다."
CONTENT_2 = "정산 API 완료가 2026-12-10으로 연기되었다."


def sha(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def record(rid, kind, content, version=1, operation="upsert", scope=None):
    return {
        "id": rid,
        "source_type": kind,
        "external_id": "ext-" + rid,
        "title": "t",
        "content": content,
        "author": "seoyun.han@example.test",
        "participants": ["seoyun.han@example.test"],
        "thread_id": "th-" + rid,
        "source_url": "https://wiki.example.test/" + rid,
        "created_at": "2026-11-02T09:00:00+09:00",
        "updated_at": "2026-11-02T09:00:00+09:00",
        "content_hash": sha(content),
        "version": version,
        "access_scope": scope if scope is not None else ["org:all"],
        "metadata": {},
        "connector_instance_id": "conn-test-1",
        "operation": operation,
        "schema_version": "1",
    }


def ev(rid, content, quote, version=1):
    start = content.index(quote)
    return {"record_id": rid, "version": version, "span": [start, start + len(quote)], "quote": quote}


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def make_dataset(root):
    os.makedirs(os.path.join(root, "sources"), exist_ok=True)
    os.makedirs(os.path.join(root, "labels"), exist_ok=True)
    write_jsonl(os.path.join(root, "sources", "mail.jsonl"), [record("mai-0001", "mail", CONTENT_1)])
    write_jsonl(os.path.join(root, "sources", "wiki.jsonl"), [record("wik-0001", "wiki", CONTENT_1)])
    write_jsonl(os.path.join(root, "sources", "messenger.jsonl"), [
        record("mes-0001", "messenger", CONTENT_2),
        record("mes-0002", "messenger", CONTENT_2),
        record("mes-0002", "messenger", "", version=2, operation="delete"),
        record("mes-0003", "messenger", CONTENT_2),
    ])
    e_p = ev("mai-0001", CONTENT_1, "한서윤")
    e_proj = ev("mai-0001", CONTENT_1, "오로라 프로젝트")
    e_sys = ev("mai-0001", CONTENT_1, "정산 API")
    e_dep = ev("wik-0001", CONTENT_1, "오로라는 정산 API에 의존한다")
    e_delay = ev("mes-0001", CONTENT_2, "2026-12-10으로 연기")
    e_other = ev("mes-0002", CONTENT_2, "정산 API")
    write_jsonl(os.path.join(root, "labels", "entities.jsonl"), [
        {"label_id": "T1:ent-1", "scenario_instance": "T1", "entity_id": "T1:person", "entity_type": "Person",
         "name": "한서윤", "aliases": [], "evidence": [e_p]},
        {"label_id": "T1:ent-2", "scenario_instance": "T1", "entity_id": "T1:proj", "entity_type": "Project",
         "name": "오로라", "aliases": [], "evidence": [e_proj]},
        {"label_id": "T1:ent-3", "scenario_instance": "T1", "entity_id": "T1:sys", "entity_type": "System",
         "name": "정산 API", "aliases": [], "evidence": [e_sys]},
        {"label_id": "T1:ent-4", "scenario_instance": "T1", "entity_id": "T1:sys2", "entity_type": "System",
         "name": "정산 API(다른 것)", "aliases": [], "evidence": [e_other], "expected_absent": True},
    ])
    write_jsonl(os.path.join(root, "labels", "resolution_pairs.jsonl"), [
        {"label_id": "T1:pair-1", "scenario_instance": "T1", "mention_a": e_sys, "mention_b": e_dep,
         "entity_id_a": "T1:sys", "entity_id_b": "T1:sys", "same": True, "evidence": [e_sys, e_dep]},
        {"label_id": "T1:pair-2", "scenario_instance": "T1", "mention_a": e_sys, "mention_b": e_other,
         "entity_id_a": "T1:sys", "entity_id_b": "T1:sys2", "same": False, "evidence": [e_sys, e_other]},
    ])
    write_jsonl(os.path.join(root, "labels", "relations.jsonl"), [
        {"label_id": "T1:rel-1", "scenario_instance": "T1", "subject": "T1:proj", "relation": "DEPENDS_ON",
         "object": "T1:sys", "expected": True, "valid_from": None, "valid_until": None, "evidence": [e_dep]},
        {"label_id": "T1:rel-2", "scenario_instance": "T1", "subject": "T1:proj", "relation": "DEPENDS_ON",
         "object": "T1:sys2", "expected": False, "valid_from": None, "valid_until": None, "evidence": [e_other]},
        {"label_id": "T1:rel-3", "scenario_instance": "T1", "subject": "T1:person", "relation": "RESPONSIBLE_FOR",
         "object": "T1:proj", "expected": True, "valid_from": None, "valid_until": None, "evidence": [e_p]},
    ])
    write_jsonl(os.path.join(root, "labels", "temporal_facts.jsonl"), [
        {"label_id": "T1:fact-1", "scenario_instance": "T1", "subject": "T1:sys", "attribute": "completion_date",
         "value": "2026-12-10", "valid_from": "2026-11-02", "valid_until": None, "expected_status": "verified",
         "supersedes": None, "as_of": "2026-11-21", "evidence": [e_delay]},
    ])
    write_jsonl(os.path.join(root, "labels", "insights.jsonl"), [
        {"label_id": "T1:ins-1", "scenario_instance": "T1", "insight_type": "dependency_delay",
         "title": "의존 업무 지연", "is_inference": True, "affected_entities": ["T1:proj", "T1:sys"],
         "evidence": [e_dep, e_delay]},
    ])
    write_jsonl(os.path.join(root, "labels", "qa.jsonl"), [
        {"label_id": "T1:qa-1", "scenario_instance": "T1", "question": "정산 API는 언제 끝나는가?",
         "answerable": True, "answer_facts": ["2026-12-10"], "evidence_role": "required", "evidence": [e_delay]},
        {"label_id": "T1:qa-2", "scenario_instance": "T1", "question": "오로라가 의존하는 것은?",
         "answerable": True, "answer_facts": ["정산 API"], "evidence_role": "required", "evidence": [e_dep, e_p]},
        {"label_id": "T1:qa-3", "scenario_instance": "T1", "question": "접근 불가 질문",
         "answerable": False, "answer_facts": [], "evidence_role": "forbidden", "evidence": [e_other]},
    ])
    splits = {
        "sealing_note": "convention",
        "splits": {"dev": ["T1"], "eval": ["T2"]},
        "instances": {
            "T1": {"scenario": "schedule_dependency_delay", "record_ids": ["mai-0001", "wik-0001", "mes-0001", "mes-0002"]},
            "T2": {"scenario": "deletion", "record_ids": ["mes-0003"]},
        },
    }
    with open(os.path.join(root, "splits.json"), "w", encoding="utf-8") as fh:
        json.dump(splits, fh, ensure_ascii=False, indent=2)
    return root
