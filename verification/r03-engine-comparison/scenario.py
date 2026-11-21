"""Scenario runner: import -> extract -> relate -> incremental edit -> delete -> restart.

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only); run so far only against in-memory fake adapters in unit tests, never a real engine.

Correctness is judged by engine-agnostic probe queries (does the result set contain a source id from
the expected set, is a forbidden source id absent, is stale text absent). Every step records wall time,
LLM calls, peak RSS of this process (children: see adapter.child_pids) and store size on disk.
"""
import copy
import os
import sys
import time
from dataclasses import dataclass, field
from typing import List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

from common import procinfo  # noqa: E402

import llm_gateway  # noqa: E402


@dataclass
class Check:
    name: str
    ok: Optional[bool]  # None = could not be checked (reported as unverified)
    detail: str = ""


@dataclass
class StepResult:
    name: str
    checks: List[Check] = field(default_factory=list)
    wall_s: float = 0.0
    llm_calls: int = 0
    llm_by_purpose: dict = field(default_factory=dict)
    peak_rss_bytes: int = 0
    store_bytes: int = 0
    store_files: int = 0
    error: str = ""

    @property
    def ok(self):
        return not self.error and bool(self.checks) and all(c.ok is not False for c in self.checks)  # no checks is not a pass


@dataclass
class ScenarioResult:
    steps: List[StepResult] = field(default_factory=list)
    not_implemented: list = field(default_factory=list)

    @property
    def all_ok(self):
        return not self.not_implemented and bool(self.steps) and all(s.ok for s in self.steps)


def dir_size(path):
    total, files = 0, 0
    for root, _dirs, names in os.walk(path):
        for n in names:
            try:
                total += os.path.getsize(os.path.join(root, n))
                files += 1
            except OSError:
                pass
    return total, files


def probe_check(adapter, probe, k=5):
    hits = adapter.query(probe["query"], k=k)
    ids = [h.source_id for h in hits]
    ok = any(e in ids for e in probe["expect_any"])
    checks = [Check("probe " + probe["id"], ok, "expected any of {} in {}".format(probe["expect_any"], ids))]
    stale = probe.get("stale_substring")
    if stale:
        offenders = [h.source_id for h in hits if h.source_id in probe["expect_any"] and stale in h.text]
        checks.append(Check("stale text absent " + probe["id"], not offenders, "stale '{}' still returned for {}".format(stale, offenders)))
    return checks


def forbidden_checks(adapter, queries, forbidden):
    out = []
    for q in queries:
        ids = [h.source_id for h in adapter.query(q, k=10)]
        bad = [i for i in ids if i in forbidden]
        out.append(Check("forbidden source absent for query '{}'".format(q[:30]), not bad, "found {}".format(bad)))
    try:
        exported = adapter.export().source_ids
        out.append(Check("export excludes forbidden sources", not (set(forbidden) & set(exported)),
                         "export still references {}".format(sorted(set(forbidden) & set(exported)))))
    except NotImplementedError as exc:
        out.append(Check("export excludes forbidden sources", None, "export not implemented: " + str(exc)))
    return out


def run_scenario(adapter, records, probes, gateway, workdir):
    result = ScenarioResult()
    try:
        adapter.setup(workdir, gateway)
    except NotImplementedError as exc:
        result.not_implemented.append(("setup", str(exc)))
        return result
    by_id = {r["id"]: r for r in records}
    snapshots = {}

    def step_import():
        for r in records:
            adapter.ingest(r)
        return [Check("all records ingested", True, "{} records".format(len(records)))]

    def hook(name):
        def run():
            fn = getattr(adapter, name, None)
            if fn is None:
                return [Check(name + " phase", True, "included in ingest (adapter has no separate {} hook)".format(name))]
            fn()
            return [Check(name + " phase", True, "ran")]
        return run

    def step_relate():
        checks = hook("relate")()
        for probe in probes["probes"]:
            checks += probe_check(adapter, probe)
        snapshots["after_relate"] = {p["id"]: sorted(h.source_id for h in adapter.query(p["query"], k=5)) for p in probes["probes"]}
        return checks

    def step_edit():
        edit = probes["edit"]
        record = copy.deepcopy(by_id[edit["source_id"]])
        record["text"] = edit["new_text"]
        adapter.update(record)
        return probe_check(adapter, edit["probe"])

    def step_delete():
        d = probes["delete"]
        adapter.delete(d["source_id"])
        checks = probe_check(adapter, d["survivor_probe"])
        queries = [p["query"] for p in probes["probes"]] + [d["survivor_probe"]["query"]]
        checks += forbidden_checks(adapter, queries, d["forbidden_source_ids"])
        snapshots["after_delete"] = {p["id"]: sorted(h.source_id for h in adapter.query(p["query"], k=5)) for p in probes["probes"]}
        return checks

    def step_restart():
        adapter.restart()
        d = probes["delete"]
        checks = [Check("same results after restart for probe " + pid,
                        sorted(h.source_id for h in adapter.query(next(p["query"] for p in probes["probes"] if p["id"] == pid), k=5)) == ids,
                        "before restart {}".format(ids)) for pid, ids in snapshots["after_delete"].items()]
        checks += probe_check(adapter, d["survivor_probe"])
        checks += forbidden_checks(adapter, [d["survivor_probe"]["query"]], d["forbidden_source_ids"])
        return checks

    steps = [("import", step_import), ("extract", hook("extract")), ("relate", step_relate),
             ("incremental_edit", step_edit), ("delete", step_delete), ("restart", step_restart)]
    for name, fn in steps:
        before = gateway.snapshot()
        started = time.time()
        step = StepResult(name)
        try:
            step.checks = fn()
        except NotImplementedError as exc:
            result.not_implemented.append((name, str(exc)))
            return result
        except Exception as exc:
            step.error = "{}: {}".format(type(exc).__name__, exc)
        step.wall_s = time.time() - started
        used = llm_gateway.delta(before, gateway.snapshot())
        step.llm_calls, step.llm_by_purpose = used["calls"], used["by_purpose"]
        step.peak_rss_bytes = procinfo.peak_rss_bytes()
        step.store_bytes, step.store_files = dir_size(workdir)
        result.steps.append(step)
    try:
        adapter.close()
    except Exception:
        pass
    return result
