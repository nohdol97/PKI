#!/usr/bin/env python3
"""Validate a golden dataset directory (stdlib only).

Usage: python3 validate.py <golden_dir> [--no-scenario-minimum]
Exit code 0 = valid, 1 = violations (printed one per line).
"""
import argparse
import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from common import load_json, load_jsonl  # noqa: E402

SOURCE_FILES = {"mail.jsonl": "mail", "wiki.jsonl": "wiki", "messenger.jsonl": "messenger"}
LABEL_FILES = ["entities", "resolution_pairs", "relations", "temporal_facts", "insights", "qa"]

RECORD_FIELDS = [
    "id", "source_type", "external_id", "title", "content", "author", "participants", "thread_id",
    "source_url", "created_at", "updated_at", "content_hash", "version", "access_scope", "metadata",
    "connector_instance_id", "operation", "schema_version",
]
OPERATIONS = {"upsert", "delete", "revoke", "access-revoked"}

# Design section 7
ENTITY_TYPES = {
    "Person", "Organization", "Project", "System", "Concept", "Document", "Fact", "Decision", "Task",
    "Commitment", "Event", "Issue", "Dependency", "BusinessRule", "OpenQuestion", "Insight",
}
RELATION_TYPES = {
    "BELONGS_TO", "RESPONSIBLE_FOR", "DEPENDS_ON", "RELATED_TO", "MENTIONS", "DECIDED", "CAUSED_BY",
    "SUPERSEDES", "CONTRADICTS", "SUPPORTS", "DERIVED_FROM",
}
# Design section 10, English slugs (mapping to the Korean names is in eval/golden/README.md)
INSIGHT_TYPES = {
    "important_work_change", "schedule_conflict", "dependency_delay", "decision_change",
    "conflicting_information", "unhandled_request", "unresolved_issue", "similar_problem_resolution",
    "related_document_discovery", "new_opportunity", "policy_definition_change",
    "new_relation_discovered", "possibly_missed_information",
}
# Design section 6.7 statuses plus two dataset-level extensions: removed, restricted
FACT_STATUSES = {"candidate", "verified", "disputed", "superseded", "rejected", "removed", "restricted"}

# Controlled vocabulary for temporal_facts.attribute (one name per kind of fact, so predictions can be compared)
FACT_ATTRIBUTES = {
    "target_date", "completion_date", "deploy_date", "start_date", "launch_date",
    "start_instant", "due_instant", "submit_instant",
    "owner", "assignee", "employment", "status", "blocker", "temporary_use", "failover_target", "description",
    "monthly_requests", "rate_limit_per_minute", "budget_krw", "unit_price_krw", "vulnerability_count",
    "public_launch_window", "maintenance_window", "freeze_period", "p1_response_minutes",
    "card_approval_rate", "duration_minutes",
}
INSTANT_ATTRIBUTES = {"start_instant", "due_instant", "submit_instant"}
UTC_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

REQUIRED_SCENARIOS = {
    "schedule_dependency_delay": 3,
    "same_name_different_people": 3,
    "abbreviation_two_meanings": 3,
    "contradicting_statements": 3,
    "correction_supersedes": 3,
    "deletion": 3,
    "permission_revocation": 3,
    "timezone_offsets": 3,
    "duplicate_threads": 3,
    "mixed_ko_en_same_concept": 3,
    "distractor_noise": 3,
}

ISO_OFFSET = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$")
URL_HOST = re.compile(r"https?://([^/\s:]+)")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")
LOCAL_PATH = re.compile(r"(/Users/|/home/[a-z]|[A-Za-z]:\\\\Users)")
SECRETISH = re.compile(r"(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9]{20,})")


def content_hash(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _walk_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk_strings(v)


def _check_hygiene(where, value, errors):
    for text in _walk_strings(value):
        for m in EMAIL.finditer(text):
            domain = m.group(1).lower()
            if domain != "example.test" and not domain.endswith(".example.test"):
                errors.append("%s: non-example.test email domain %r" % (where, domain))
        for m in URL_HOST.finditer(text):
            host = m.group(1).lower()
            if host != "example.test" and not host.endswith(".example.test"):
                errors.append("%s: non-example.test host %r" % (where, host))
        if LOCAL_PATH.search(text):
            errors.append("%s: local path-like text" % where)
        if SECRETISH.search(text):
            errors.append("%s: secret-like text" % where)


def check_record(rec, expected_type, where):
    errors = []
    for f in RECORD_FIELDS:
        if f not in rec:
            errors.append("%s: missing field %s" % (where, f))
    if errors:
        return errors
    if rec["source_type"] != expected_type:
        errors.append("%s: source_type %r does not match file kind %r" % (where, rec["source_type"], expected_type))
    if rec["operation"] not in OPERATIONS:
        errors.append("%s: operation %r not in %s" % (where, rec["operation"], sorted(OPERATIONS)))
    if not isinstance(rec["version"], int) or rec["version"] < 1:
        errors.append("%s: version must be an integer >= 1" % where)
    for f in ("created_at", "updated_at"):
        if not isinstance(rec[f], str) or not ISO_OFFSET.match(rec[f]):
            errors.append("%s: %s must be ISO-8601 with a UTC offset" % (where, f))
    if not isinstance(rec["content"], str):
        errors.append("%s: content must be a string" % where)
    elif rec["content_hash"] != content_hash(rec["content"]):
        errors.append("%s: content_hash does not match sha256 of content" % where)
    for f in ("participants", "access_scope"):
        if not isinstance(rec[f], list) or not all(isinstance(x, str) for x in rec[f]):
            errors.append("%s: %s must be a list of strings" % (where, f))
    if not isinstance(rec["metadata"], dict):
        errors.append("%s: metadata must be an object" % where)
    if rec["operation"] == "delete" and rec.get("content") != "":
        errors.append("%s: delete record must have empty content" % where)
    _check_hygiene(where, rec, errors)
    return errors


def check_evidence(ev, records, where, allowed_ids=None):
    """records: {(record_id, version): record}. Returns a list of error strings."""
    errors = []
    if not isinstance(ev, dict) or not all(k in ev for k in ("record_id", "version", "span", "quote")):
        return ["%s: evidence item needs record_id, version, span, quote" % where]
    rec = records.get((ev["record_id"], ev["version"]))
    if rec is None:
        return ["%s: evidence points at unknown record %s v%s" % (where, ev["record_id"], ev["version"])]
    if allowed_ids is not None and ev["record_id"] not in allowed_ids:
        errors.append("%s: evidence record %s is outside instance" % (where, ev["record_id"]))
    span = ev["span"]
    if (not isinstance(span, list) or len(span) != 2 or not all(isinstance(x, int) for x in span)):
        return errors + ["%s: span must be [start, end] integers" % where]
    start, end = span
    if start < 0 or end > len(rec["content"]) or start > end:
        return errors + ["%s: span out of range for %s v%s (content length %d)" % (
            where, ev["record_id"], ev["version"], len(rec["content"]))]
    if start == end:
        return errors + ["%s: span must not be empty" % where]
    if rec["content"][start:end] != ev["quote"]:
        errors.append("%s: quote does not match span %s of %s v%s (content has %r)" % (
            where, span, ev["record_id"], ev["version"], rec["content"][start:end]))
    return errors


def _is_iso_or_null(v):
    return v is None or (isinstance(v, str) and ISO_DATE.match(v) is not None)


def _need(row, keys, where, errors):
    ok = True
    for k in keys:
        if k not in row:
            errors.append("%s: missing field %s" % (where, k))
            ok = False
    return ok


def validate_dataset(golden_dir, required_scenarios=None):
    """Return a list of violation strings (empty list = valid).

    required_scenarios: {scenario: min_instances}; None uses REQUIRED_SCENARIOS, {} disables."""
    if required_scenarios is None:
        required_scenarios = REQUIRED_SCENARIOS
    errors = []

    records = {}
    versions_of = {}
    for fname, kind in SOURCE_FILES.items():
        path = os.path.join(golden_dir, "sources", fname)
        if not os.path.exists(path):
            errors.append("missing file sources/%s" % fname)
            continue
        for n, rec in enumerate(load_jsonl(path), start=1):
            where = "sources/%s:%d" % (fname, n)
            errors.extend(check_record(rec, kind, where))
            if "id" in rec and "version" in rec:
                key = (rec["id"], rec["version"])
                if key in records:
                    errors.append("%s: duplicate record %s v%s" % (where, key[0], key[1]))
                records[key] = rec
                versions_of.setdefault(rec["id"], []).append(rec["version"])
    for (rid, ver), rec in records.items():
        if rec.get("operation") in ("delete", "revoke") and not any(v < ver for v in versions_of[rid]):
            errors.append("record %s v%s: %s needs an earlier version" % (rid, ver, rec["operation"]))

    splits_path = os.path.join(golden_dir, "splits.json")
    if not os.path.exists(splits_path):
        errors.append("missing file splits.json")
        return errors
    splits = load_json(splits_path)
    instances = splits.get("instances", {})
    split_lists = splits.get("splits", {})
    for name in ("dev", "eval"):
        if name not in split_lists:
            errors.append("splits.json: missing split %s" % name)
    dev, ev_ = list(split_lists.get("dev", [])), list(split_lists.get("eval", []))
    for name, lst in (("dev", dev), ("eval", ev_)):
        if len(lst) != len(set(lst)):
            errors.append("splits.json: duplicate instance inside split %s" % name)
        for i in lst:
            if i not in instances:
                errors.append("splits.json: split %s names unknown instance %s" % (name, i))
    for i in set(dev) & set(ev_):
        errors.append("splits.json: instance %s is in both dev and eval" % i)
    for i in instances:
        if i not in dev and i not in ev_:
            errors.append("splits.json: instance %s not assigned to a split" % i)

    owner = {}
    for iid, inst in instances.items():
        if not inst.get("record_ids"):
            errors.append("splits.json: instance %s has no records" % iid)
        for rid in inst.get("record_ids", []):
            if rid in owner and owner[rid] != iid:
                errors.append("splits.json: record %s in more than one instance (%s, %s)" % (rid, owner[rid], iid))
            owner[rid] = iid
            if rid not in versions_of:
                errors.append("splits.json: instance %s lists unknown record %s" % (iid, rid))
    for rid in versions_of:
        if rid not in owner:
            errors.append("record %s is not in any instance" % rid)

    counts = {}
    for inst in instances.values():
        counts[inst.get("scenario")] = counts.get(inst.get("scenario"), 0) + 1
    for scen, minimum in required_scenarios.items():
        if counts.get(scen, 0) < minimum:
            errors.append("scenario %s has %d instances, needs >= %d" % (scen, counts.get(scen, 0), minimum))

    ids_by_instance = {i: set(inst.get("record_ids", [])) for i, inst in instances.items()}
    labels = {}
    for name in LABEL_FILES:
        path = os.path.join(golden_dir, "labels", name + ".jsonl")
        if not os.path.exists(path):
            errors.append("missing file labels/%s.jsonl" % name)
            labels[name] = []
            continue
        labels[name] = load_jsonl(path)

    seen_label_ids = set()
    entity_instance = {}
    for row in labels["entities"]:
        if "entity_id" in row:
            entity_instance[row["entity_id"]] = row.get("scenario_instance")

    def common(name, n, row):
        where = "labels/%s.jsonl:%d" % (name, n)
        if isinstance(row, dict) and "label_id" in row:
            where += " (%s)" % row["label_id"]
        if not _need(row, ["label_id", "scenario_instance", "evidence"], where, errors):
            return where, False
        if row["label_id"] in seen_label_ids:
            errors.append("%s: duplicate label_id %s" % (where, row["label_id"]))
        seen_label_ids.add(row["label_id"])
        inst = row["scenario_instance"]
        if inst not in instances:
            errors.append("%s: unknown instance %s" % (where, inst))
            return where, False
        if not isinstance(row["evidence"], list) or not row["evidence"]:
            errors.append("%s: evidence must be a non-empty list" % where)
            return where, True
        for e in row["evidence"]:
            errors.extend(check_evidence(e, records, where, ids_by_instance[inst]))
        trig = row.get("trigger")
        if trig is not None:
            trec = records.get((trig.get("record_id"), trig.get("version")))
            if trec is None:
                errors.append("%s: trigger points at unknown record" % where)
            elif trec["operation"] not in ("delete", "revoke"):
                errors.append("%s: trigger must be a delete or revoke record" % where)
            elif trig["record_id"] not in ids_by_instance[inst]:
                errors.append("%s: trigger record is outside instance" % where)
        _check_hygiene(where, row, errors)
        return where, True

    def check_entity_ref(where, inst, eid):
        if eid not in entity_instance:
            errors.append("%s: unknown entity %s" % (where, eid))
        elif entity_instance[eid] != inst:
            errors.append("%s: entity %s belongs to another instance" % (where, eid))

    for n, row in enumerate(labels["entities"], start=1):
        where, ok = common("entities", n, row)
        if not ok or not _need(row, ["entity_id", "entity_type", "name", "aliases"], where, errors):
            continue
        if row["entity_type"] not in ENTITY_TYPES:
            errors.append("%s: entity_type %r not in design section 7" % (where, row["entity_type"]))
        if "expected_absent" in row:
            if not isinstance(row["expected_absent"], bool):
                errors.append("%s: expected_absent must be a boolean" % where)
            elif row["expected_absent"]:
                for e in row["evidence"]:
                    deleted = any(r["operation"] == "delete" and r["id"] == e.get("record_id") and r["version"] > e.get("version", 0)
                                  for r in records.values())
                    if not deleted:
                        errors.append("%s: expected_absent entity has evidence from %s v%s that is not deleted"
                                      % (where, e.get("record_id"), e.get("version")))
        inst_text = "\n".join(rec["content"] for (rid, _v), rec in records.items()
                              if rid in ids_by_instance.get(row["scenario_instance"], ()))
        for alias in row["aliases"]:
            if alias not in inst_text:
                errors.append("%s: alias %r occurs in no record of the instance" % (where, alias))

    for n, row in enumerate(labels["resolution_pairs"], start=1):
        where, ok = common("resolution_pairs", n, row)
        if not ok or not _need(row, ["mention_a", "mention_b", "entity_id_a", "entity_id_b", "same"], where, errors):
            continue
        for k in ("entity_id_a", "entity_id_b"):
            check_entity_ref(where, row["scenario_instance"], row[k])
        if bool(row["same"]) != (row["entity_id_a"] == row["entity_id_b"]):
            errors.append("%s: same=%s contradicts entity_id_a/entity_id_b" % (where, row["same"]))
        if row["evidence"] != [row["mention_a"], row["mention_b"]]:
            errors.append("%s: evidence must equal [mention_a, mention_b]" % where)

    for n, row in enumerate(labels["relations"], start=1):
        where, ok = common("relations", n, row)
        if not ok or not _need(row, ["subject", "relation", "object", "expected", "valid_from", "valid_until"], where, errors):
            continue
        if row["relation"] not in RELATION_TYPES:
            errors.append("%s: relation type %r not in design section 7" % (where, row["relation"]))
        for k in ("subject", "object"):
            check_entity_ref(where, row["scenario_instance"], row[k])
        if not isinstance(row["expected"], bool):
            errors.append("%s: expected must be a boolean" % where)
        for k in ("valid_from", "valid_until"):
            if not _is_iso_or_null(row[k]):
                errors.append("%s: %s must be an ISO date or null" % (where, k))

    fact_ids = {r.get("label_id") for r in labels["temporal_facts"]}
    for n, row in enumerate(labels["temporal_facts"], start=1):
        where, ok = common("temporal_facts", n, row)
        if not ok or not _need(row, ["subject", "attribute", "value", "valid_from", "valid_until",
                                     "expected_status", "supersedes", "as_of"], where, errors):
            continue
        check_entity_ref(where, row["scenario_instance"], row["subject"])
        if row["attribute"] not in FACT_ATTRIBUTES:
            errors.append("%s: attribute %r not in the controlled vocabulary" % (where, row["attribute"]))
        elif row["attribute"] in INSTANT_ATTRIBUTES and not (isinstance(row["value"], str) and UTC_INSTANT.match(row["value"])):
            errors.append("%s: instant value %r must be UTC (...Z)" % (where, row["value"]))
        if row["expected_status"] not in FACT_STATUSES:
            errors.append("%s: expected_status %r not allowed" % (where, row["expected_status"]))
        for k in ("valid_from", "valid_until", "as_of"):
            if not _is_iso_or_null(row[k]):
                errors.append("%s: %s must be an ISO date or null" % (where, k))
        if row["supersedes"] is not None and row["supersedes"] not in fact_ids:
            errors.append("%s: supersedes points at unknown fact %s" % (where, row["supersedes"]))

    for n, row in enumerate(labels["insights"], start=1):
        where, ok = common("insights", n, row)
        if not ok or not _need(row, ["insight_type", "title", "is_inference", "affected_entities"], where, errors):
            continue
        if row["insight_type"] not in INSIGHT_TYPES:
            errors.append("%s: insight_type %r not in design section 10" % (where, row["insight_type"]))
        if not isinstance(row["is_inference"], bool):
            errors.append("%s: is_inference must be a boolean" % where)
        if "expected" in row and not isinstance(row["expected"], bool):
            errors.append("%s: expected must be a boolean" % where)
        for eid in row["affected_entities"]:
            check_entity_ref(where, row["scenario_instance"], eid)

    for n, row in enumerate(labels["qa"], start=1):
        where, ok = common("qa", n, row)
        if not ok or not _need(row, ["question", "answerable", "answer_facts", "evidence_role"], where, errors):
            continue
        if not isinstance(row["answerable"], bool):
            errors.append("%s: answerable must be a boolean" % where)
        else:
            want = "required" if row["answerable"] else "forbidden"
            if row["evidence_role"] != want:
                errors.append("%s: evidence_role must be %r when answerable=%s" % (where, want, row["answerable"]))
            if row["answerable"] and not row["answer_facts"]:
                errors.append("%s: answerable question needs answer_facts" % where)

    review = os.path.join(golden_dir, "labels", "review", "second_review_machine.jsonl")
    if os.path.exists(review):
        for n, row in enumerate(load_jsonl(review), start=1):
            where = "labels/review/second_review_machine.jsonl:%d" % n
            for e in row.get("evidence", []):
                errors.extend(check_evidence(e, records, where))
    return errors


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("golden_dir")
    ap.add_argument("--no-scenario-minimum", action="store_true",
                    help="skip the per-scenario instance minimum (used by test fixtures)")
    args = ap.parse_args(argv)
    errors = validate_dataset(args.golden_dir, required_scenarios={} if args.no_scenario_minimum else None)
    for e in errors:
        print(e)
    if errors:
        print("INVALID: %d violation(s)" % len(errors))
        return 1
    print("OK: dataset valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
