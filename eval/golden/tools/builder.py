"""Deterministic builder for the synthetic golden dataset.

Records are created with explicit content; evidence spans are computed from the exact
content so quote == content[start:end] holds by construction. The committed JSONL is the
source of truth; this script only makes spans easy to keep exact.
"""
import datetime
import hashlib
import json
import os

CONNECTORS = {"mail": "conn-mail-01", "wiki": "conn-wiki-01", "messenger": "conn-chat-01"}
PREFIX = {"mail": "mail", "wiki": "wiki", "messenger": "msg"}
FILES = {"mail": "mail.jsonl", "wiki": "wiki.jsonl", "messenger": "messenger.jsonl"}


def sha(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


class World:
    def __init__(self):
        self.records = []          # dicts in creation order
        self.ids = {}              # (iid, ref) -> record id
        self.contents = {}         # (record id, version) -> content
        self.created = {}          # (record id, version) -> created_at
        self.counter = {"mail": 0, "wiki": 0, "messenger": 0}
        self.labels = {k: [] for k in
                       ("entities", "resolution_pairs", "relations", "temporal_facts", "insights", "qa")}
        self.label_n = {}
        self.instances = {}

    def instance(self, iid, scenario):
        inst = Inst(self, iid, scenario)
        self.instances[iid] = inst
        return inst

    def next_label(self, iid, kind):
        n = self.label_n.get((iid, kind), 0) + 1
        self.label_n[(iid, kind)] = n
        return "%s:%s-%d" % (iid, kind, n)

    def write(self, out_dir, dev, sealed_note):
        os.makedirs(os.path.join(out_dir, "sources"), exist_ok=True)
        os.makedirs(os.path.join(out_dir, "labels"), exist_ok=True)
        for kind, fname in FILES.items():
            rows = [r for r in self.records if r["source_type"] == kind]
            _dump(os.path.join(out_dir, "sources", fname), rows)
        for name, rows in self.labels.items():
            _dump(os.path.join(out_dir, "labels", name + ".jsonl"), rows)
        insts = {}
        for iid, inst in self.instances.items():
            insts[iid] = {"scenario": inst.scenario, "record_ids": sorted(set(inst.record_ids))}
        splits = {
            "sealing_note": sealed_note,
            "splits": {
                "dev": [i for i in insts if i in dev],
                "eval": [i for i in insts if i not in dev],
            },
            "instances": insts,
        }
        with open(os.path.join(out_dir, "splits.json"), "w", encoding="utf-8") as fh:
            json.dump(splits, fh, ensure_ascii=False, indent=2)
            fh.write("\n")


def _dump(path, rows):
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


class Inst:
    def __init__(self, world, iid, scenario):
        self.w, self.iid, self.scenario = world, iid, scenario
        self.record_ids = []
        self.refs = {}

    # ---- records -------------------------------------------------------
    def rec(self, ref, kind, content, title, author, created, *, participants=None, thread=None,
            updated=None, version=1, scope=None, op="upsert", ext=None, meta=None, connector=None):
        w = self.w
        if version == 1:
            w.counter[kind] += 1
            rid = "%s-%04d" % (PREFIX[kind], w.counter[kind])
            self.refs[ref] = rid
            self.record_ids.append(rid)
            slug = "%s-%s" % (self.iid.lower(), ref)
            ext = ext or {"mail": "<%s@mail.example.test>" % slug,
                          "wiki": "page/%s" % slug,
                          "messenger": "ch-%s/%s" % (self.iid.lower(), ref)}[kind]
            self._ext = getattr(self, "_ext", {})
            self._ext[ref] = ext
        rid = self.refs[ref]
        ext = self._ext[ref]
        url = {"mail": "https://mail.example.test/msg/", "wiki": "https://wiki.example.test/",
               "messenger": "https://chat.example.test/archives/"}[kind] + ext.strip("<>").split("@")[0]
        record = {
            "id": rid,
            "source_type": kind,
            "external_id": ext,
            "title": title,
            "content": content,
            "author": author,
            "participants": participants if participants is not None else [author],
            "thread_id": thread or "thr-%s-%s" % (self.iid.lower(), ref),
            "source_url": url,
            "created_at": created,
            "updated_at": updated or created,
            "content_hash": sha(content),
            "version": version,
            "access_scope": scope if scope is not None else ["org:all"],
            "metadata": meta or {},
            "connector_instance_id": connector or CONNECTORS[kind],
            "operation": op,
            "schema_version": "1",
        }
        w.records.append(record)
        w.contents[(rid, version)] = content
        w.created[(rid, version)] = created
        return rid

    # ---- evidence ------------------------------------------------------
    def E(self, ref, quote, ver=1, nth=0):
        rid = self.refs[ref]
        content = self.w.contents[(rid, ver)]
        pos = -1
        for _ in range(nth + 1):
            pos = content.find(quote, pos + 1)
            if pos < 0:
                raise ValueError("quote not found in %s v%d (%s): %r" % (rid, ver, self.iid, quote))
        return {"record_id": rid, "version": ver, "span": [pos, pos + len(quote)], "quote": quote}

    def _ev(self, spec):
        return spec if isinstance(spec, dict) else self.E(*spec)

    def _evs(self, specs):
        return [self._ev(s) for s in specs]

    def eid(self, key):
        return "%s:%s" % (self.iid, key)

    def trig(self, ref, ver):
        return {"record_id": self.refs[ref], "version": ver}

    # ---- labels --------------------------------------------------------
    def ent(self, key, etype, name, evs, aliases=()):
        self.w.labels["entities"].append({
            "label_id": self.w.next_label(self.iid, "ent"), "scenario_instance": self.iid,
            "entity_id": self.eid(key), "entity_type": etype, "name": name, "aliases": list(aliases),
            "evidence": self._evs(evs)})

    def pair(self, a, b, ent_a, ent_b):
        ma, mb = self._ev(a), self._ev(b)
        self.w.labels["resolution_pairs"].append({
            "label_id": self.w.next_label(self.iid, "pair"), "scenario_instance": self.iid,
            "mention_a": ma, "mention_b": mb, "entity_id_a": self.eid(ent_a), "entity_id_b": self.eid(ent_b),
            "same": ent_a == ent_b, "evidence": [ma, mb]})

    def rel(self, subj, relation, obj, evs, expected=True, vf=None, vu=None):
        self.w.labels["relations"].append({
            "label_id": self.w.next_label(self.iid, "rel"), "scenario_instance": self.iid,
            "subject": self.eid(subj), "relation": relation, "object": self.eid(obj), "expected": expected,
            "valid_from": vf, "valid_until": vu, "evidence": self._evs(evs)})

    def fact(self, subj, attribute, value, vf, vu, status, evs, supersedes=None, as_of="2026-11-21", trigger=None):
        label_id = self.w.next_label(self.iid, "fact")
        evs = self._evs(evs)
        if vf is None and vu is None:
            # convention: without a stated start, validity starts at the assertion (UTC day of the first evidence record)
            first = evs[0]
            stamp = datetime.datetime.fromisoformat(self.w.created[(first["record_id"], first["version"])])
            vf = stamp.astimezone(datetime.timezone.utc).date().isoformat()
        row = {"label_id": label_id, "scenario_instance": self.iid, "subject": self.eid(subj),
               "attribute": attribute, "value": value, "valid_from": vf, "valid_until": vu,
               "expected_status": status, "supersedes": supersedes, "as_of": as_of,
               "evidence": evs}
        if trigger:
            row["trigger"] = trigger
        self.w.labels["temporal_facts"].append(row)
        return label_id

    def ins(self, itype, title, infer, affected, evs, expected=True, trigger=None):
        row = {"label_id": self.w.next_label(self.iid, "ins"), "scenario_instance": self.iid,
               "insight_type": itype, "title": title, "is_inference": infer,
               "affected_entities": [self.eid(a) for a in affected], "evidence": self._evs(evs)}
        if not expected:
            row["expected"] = False
        if trigger:
            row["trigger"] = trigger
        self.w.labels["insights"].append(row)

    def qa(self, question, facts, evs, answerable=True, viewer=None, trigger=None):
        row = {"label_id": self.w.next_label(self.iid, "qa"), "scenario_instance": self.iid,
               "question": question, "answerable": answerable, "answer_facts": list(facts),
               "evidence_role": "required" if answerable else "forbidden", "evidence": self._evs(evs)}
        if viewer:
            row["viewer"] = viewer
        if trigger:
            row["trigger"] = trigger
        self.w.labels["qa"].append(row)
