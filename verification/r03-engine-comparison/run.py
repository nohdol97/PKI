#!/usr/bin/env python3
"""R03 engine / embedding / storage comparison driver.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED against a real engine, model or CLI. Unit tests use fake adapters,
a fake hashing embedding worker and SQLite temp files only; they are NOT site evidence (issue #37).
Standard library only. See RUNBOOK.md (Korean) next to this file.

Subcommands:
  plan              print the whole procedure, planned adapter calls and the evidence gaps (executes nothing)
  install-steps     print pinned install steps (the operator runs them; each needs the site's network approval)
  inspect-golden    show the keys found in eval/golden so the field map can be fixed
  scenario          import -> extract -> relate -> edit -> delete -> restart for one engine adapter
  shim              start the loopback OpenAI-compatible shim backed by an R02-approved CLI profile
  cli-adapter       R03-C2 smoke: one counted structured call through the gateway with an R02-approved profile
  embed             embedding benchmark for one model (writes predictions for eval/scorer/score.py)
  embed-offline-check  re-run the worker with offline cache variables and record license files (hashes only)
  storage-compare   standard temporal-store check series for the product SQLite schema or cortexdb
  durability        crash / concurrent-read / single-writer checks
An unfinished stub ends with `미구현, 배포처 후속: <R03-S?>` and exit code 3.
"""
import argparse
import hashlib
import importlib.util
import json
import os
import secrets
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
for path in (HERE, VERIF):
    if path not in sys.path:
        sys.path.insert(0, path)

from common import fingerprint, results as results_mod, runner as runner_mod  # noqa: E402
from common.redact import Redactor  # noqa: E402
from common.results import ResultBuilder  # noqa: E402

import durability  # noqa: E402
import embedding_bench as eb  # noqa: E402
import llm_gateway  # noqa: E402
import scenario as scenario_mod  # noqa: E402
import store as store_mod  # noqa: E402

KIT = "r03-engine-comparison"
NOTICE_EXIT = 3
FIXTURES = os.path.join(VERIF, "fixtures", "records")
ENGINES = {"lightrag": ("adapters/lightrag_adapter.py", "LightRagAdapter"),
           "cognee": ("adapters/cognee_adapter.py", "CogneeAdapter"),
           "sage-wiki": ("adapters/sage_wiki_adapter.py", "SageWikiAdapter")}
WORKERS = {"fastembed": "embed_workers/fastembed_worker.py", "sentence-transformers": "embed_workers/sentence_transformers_worker.py"}


def notice(exc):
    print("미구현, 배포처 후속: {}".format(exc))
    return NOTICE_EXIT


def load_adapter_class(engine):
    rel, cls = ENGINES[engine]
    spec = importlib.util.spec_from_file_location("adapter_" + engine.replace("-", "_"), os.path.join(HERE, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return getattr(mod, cls)


def load_fixtures():
    with open(os.path.join(FIXTURES, "sources.jsonl"), encoding="utf-8") as fh:
        records = [json.loads(x) for x in fh if x.strip()]
    with open(os.path.join(FIXTURES, "probes.json"), encoding="utf-8") as fh:
        return records, json.load(fh)


def builder(args):
    return ResultBuilder(KIT, args.out, redactor=Redactor(literals={x: "<REDACTED>" for x in args.redact}),
                         mode="dry-run" if getattr(args, "dry_run", False) else "real")


def finish(args, b, extra_env=None):
    env = fingerprint.environment_fingerprint()
    env.update(extra_env or {})
    if runner_mod.passthrough_names():
        env["passed_env_names"] = runner_mod.passthrough_names()
        b.add_note("env_passthrough_opt_in")
    b.set_environment(env)
    b.add_note("unit_tests_not_site_evidence")
    b.merge_from(os.path.join(args.out, "result.json"))
    jpath, _ = b.write()
    print("wrote {} and result.md (pasteable) and raw/ (LOCAL ONLY, never paste)".format(os.path.basename(jpath)))
    for c in b.build()["checks"]:
        print("  {:13} {}".format(c["verdict"], c["id"]))


def numeric_facts(d):
    """Only booleans and numbers of a result dict become facts (free text never does)."""
    return {k: v for k, v in d.items() if isinstance(v, (bool, int, float)) and k.replace("_", "").isalnum() and k[:1].islower()}


def build_parser():
    ap = argparse.ArgumentParser(prog="run.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    def common(sp, out=True):
        if out:
            sp.add_argument("--out", default="r03-result")
        sp.add_argument("--redact", action="append", default=[])
        sp.add_argument("--dry-run", action="store_true")
        sp.add_argument("--pass-env", action="append", default=[], metavar="NAME", help="opt in to pass a proxy/CA variable to children; names only are recorded")

    sub.add_parser("plan")
    sub.add_parser("install-steps")
    sp = sub.add_parser("inspect-golden"); sp.add_argument("--golden", default="eval/golden")
    sp = sub.add_parser("scenario"); common(sp)
    sp.add_argument("--engine", choices=sorted(ENGINES), required=True)
    sp.add_argument("--workdir", required=True)
    sp.add_argument("--llm-mode", choices=["none", "cli"], default="cli")
    for name in ("cli-adapter", "shim"):
        s2 = sub.add_parser(name); common(s2)
    for s2 in (sub.choices["cli-adapter"], sub.choices["shim"], sub.choices["scenario"]):
        s2.add_argument("--r02-result", help="result.json written by the R02 kit")
        s2.add_argument("--profile", help="R02 profile name that passed containment")
        s2.add_argument("--cli-bin")
        s2.add_argument("--model")
        s2.add_argument("--timeout", type=float, default=300.0)
    sub.choices["shim"].add_argument("--port", type=int, default=0)
    sp = sub.add_parser("embed"); common(sp)
    sp.add_argument("--model", choices=["bge-m3", "e5-base"], required=True)
    sp.add_argument("--backend", choices=sorted(WORKERS) + ["command"], default="fastembed")
    sp.add_argument("--worker-cmd", help="JSON array: the finished worker command (backend=command)")
    sp.add_argument("--dataset", choices=["fixtures", "golden"], default="golden")
    sp.add_argument("--golden", default="eval/golden")
    sp.add_argument("--split")
    sp.add_argument("--field-map", help="JSON file overriding DEFAULT_FIELD_MAP")
    sp.add_argument("--top-k", type=int, default=10)
    sp.add_argument("--scorer-cmd", help="JSON array override; {predictions} is replaced. Default with --split: python3 eval/scorer/score.py <golden> {predictions} --split <split>")
    sp.add_argument("--timeout", type=float, default=7200.0)
    sp = sub.add_parser("embed-offline-check"); common(sp)
    sp.add_argument("--outbound-blocked-attested", action="store_true",
                    help="I blocked outbound network (firewall/VM) for this run; the kit cannot observe it, so without this flag the check stays INCONCLUSIVE")
    sp.add_argument("--model", choices=["bge-m3", "e5-base"], required=True)
    sp.add_argument("--backend", choices=sorted(WORKERS) + ["command"], default="fastembed")
    sp.add_argument("--worker-cmd")
    sp.add_argument("--cache-dir", help="model cache folder to measure and scan for license files")
    sp = sub.add_parser("storage-compare"); common(sp)
    sp.add_argument("--store", choices=["sqlite", "cortexdb"], required=True)
    sp.add_argument("--workdir", required=True)
    sp = sub.add_parser("durability"); common(sp)
    sp.add_argument("--target", default="sqlite", help="sqlite, or an engine name (needs the adapter, R03-S1..S3)")
    sp.add_argument("--check", choices=["crash", "concurrent", "single-writer", "all"], default="all")
    sp.add_argument("--workdir", required=True)
    return ap


def worker_argv(args):
    if args.backend == "command":
        if not args.worker_cmd:
            raise SystemExit("error: --worker-cmd (JSON array) is required with --backend command")
        return json.loads(args.worker_cmd)
    return [sys.executable, os.path.join(HERE, WORKERS[args.backend])]


def model_spec(short):
    return next(m for m in eb.load_models() if m["short"] == short)


def cmd_plan():
    print("R03 procedure (nothing is executed by `plan`):")
    for n, line in enumerate([
            "1. R02 first: only a CLI profile with CONTAINED_ON_OBSERVABLES may be used (R03-C2).",
            "2. install-steps: operator installs ONE candidate per environment, with the site's network approval.",
            "3. scenario per engine: import -> extract -> relate -> incremental edit -> delete -> restart (R03-C1).",
            "4. cli-adapter / shim: the engine's LLM calls go through the counted gateway (R03-C2).",
            "5. embed for bge-m3 and e5-base, then embed-offline-check (R03-C3).",
            "6. storage-compare: product SQLite schema vs cortexdb; durability: crash, concurrent read, single writer (R03-C4)."], 1):
        print(line)
    print("\nPlanned adapter calls without evidence (left as SiteTodo):")
    for engine in sorted(ENGINES):
        cls = load_adapter_class(engine)
        print("  {} ({}): {} planned calls, {} without evidence".format(engine, cls.ITEM_ID, len(cls.PLANNED_CALLS), len(cls.missing_evidence())))
        for call in cls.missing_evidence():
            print("     - " + call)
    print("  cortexdb (R03-S4): {}".format(store_mod.CortexDbStore.MISSING))
    print("  embedding workers (R03-S5): library calls for loading/encoding (fastembed add_custom_model arguments, sentence-transformers options)")
    return 0


def cmd_install_steps():
    with open(os.path.join(HERE, "candidates.json"), encoding="utf-8") as fh:
        data = json.load(fh)
    print(data["notice"])
    for c in data["candidates"]:
        print("\n== {} - {} (primary: {}, site item {})".format(c["name"], c["role"], c["primary"], c["site_item"]))
        print("   pins: " + json.dumps(c["pins"]))
        for s in c["install_steps"]:
            print("   - {}{}\n       {}".format("[NEEDS SITE NETWORK-INSTALL APPROVAL] " if s["site_approval"] else "", s["step"], s["command"]))
    return 0


def load_gateway(args):
    """Gateway backed by an R02-approved CLI profile. Raises GateBlocked when R02 did not clear it."""
    import profiles
    if not (args.r02_result and args.profile and args.model):
        raise SystemExit("error: --r02-result, --profile and --model are required for --llm-mode cli")
    profile = profiles.get_profile(profiles.load_profiles(), args.profile)
    binary = os.path.abspath(args.cli_bin) if args.cli_bin else runner_mod.resolve_executable(profile["cli"], runner_mod.build_env())
    if not binary:
        raise SystemExit("error: the {} CLI was not found; pass --cli-bin".format(profile["cli"]))
    llm_gateway.gate_check(args.r02_result, args.profile, fingerprint.cli_version(binary), args.model)
    return llm_gateway.LLMGateway(llm_gateway.CliBackend(profile, binary, args.model, args.timeout))


FAILED_KIND_WORDS = ("probe", "stale", "forbidden", "export", "same_results")


def check_kind(name):
    for kind, needle in (("probe", "probe "), ("stale", "stale"), ("forbidden", "forbidden"), ("export", "export"), ("same_results", "same results")):
        if needle in name:
            return kind
    return "other_check"


def cmd_scenario(args):
    b = builder(args)
    adapter = load_adapter_class(args.engine)()
    records, probes = load_fixtures()
    if args.dry_run:
        print("DRY RUN: would run import/extract/relate/edit/delete/restart for {} on {} fixture records in {}".format(
            args.engine, len(records), args.workdir))
        return 0
    os.makedirs(args.workdir, exist_ok=True)
    if args.llm_mode == "none":
        gateway = llm_gateway.LLMGateway(lambda p, s: (_ for _ in ()).throw(llm_gateway.BackendError("--llm-mode none: no LLM available")))
    else:
        try:
            gateway = load_gateway(args)
        except llm_gateway.GateBlocked as exc:
            b.add_check("R03-C2:gate:" + args.engine, "BLOCKED", {"gate_open": False})
            b.add_raw("gate_reason_" + args.engine, str(exc))
            finish(args, b)
            return 4
    result = scenario_mod.run_scenario(adapter, records, probes, gateway, args.workdir)
    for step in result.steps:
        failed = [c for c in step.checks if c.ok is False]
        b.add_check("R03-C1:{}:{}".format(args.engine, step.name), "PASS" if step.ok else "FAIL",
                    {"wall_s": round(step.wall_s, 2), "llm_calls": step.llm_calls, "llm_by_purpose": dict(step.llm_by_purpose),
                     "peak_rss_mb": step.peak_rss_bytes // 2 ** 20, "store_kb": step.store_bytes // 1024, "store_files": step.store_files,
                     "checks_total": len(step.checks), "checks_failed": len(failed), "checks_unverified": sum(1 for c in step.checks if c.ok is None),
                     "failed_kinds": sorted({check_kind(c.name) for c in failed}), "step_error": bool(step.error)})
        b.add_raw("scenario_{}_{}".format(args.engine, step.name), "\n".join("{} {} {}".format(c.ok, c.name, c.detail) for c in step.checks) + "\n" + step.error)
    snap = gateway.snapshot()
    b.add_metric("llm_calls_total_" + args.engine.replace("-", "_"), snap["calls"], "calls")
    b.add_metric("llm_latency_total_" + args.engine.replace("-", "_"), round(snap["total_latency_s"], 3), "s")
    if result.not_implemented:
        step_name, message = result.not_implemented[0]
        b.add_check("R03-C1:{}:{}".format(args.engine, step_name if step_name in ("setup", "import", "extract", "relate", "incremental_edit", "delete", "restart") else "setup"),
                    "NOT_RUN", {"not_implemented": True}, ["engine_not_implemented"])
        b.add_raw("not_implemented_" + args.engine, message)
        finish(args, b)
        print("미구현, 배포처 후속: " + message)
        return NOTICE_EXIT
    finish(args, b)
    return 0 if result.all_ok else 1


def cmd_cli_adapter(args):
    if args.dry_run:
        print("DRY RUN: would gate-check the R02 result, then make one counted structured call through the gateway.")
        return 0
    b = builder(args)
    try:
        gateway = load_gateway(args)
    except llm_gateway.GateBlocked as exc:
        b.add_check("R03-C2:cli-adapter", "BLOCKED", {"gate_open": False})
        b.add_raw("gate_reason", str(exc))
        finish(args, b)
        return 4
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"], "additionalProperties": False}
    try:
        out = gateway.complete("Reply with the single word ok in the answer field.", purpose="structured", schema=schema)
        ok = isinstance(out, dict) and "answer" in out
    except Exception as exc:
        ok = False
        b.add_raw("cli_adapter_error", type(exc).__name__)
    snap = gateway.snapshot()
    b.add_check("R03-C2:cli-adapter", "PASS" if ok else "FAIL",
                {"structured_call_ok": ok, "calls": snap["calls"], "failures": snap["failures"], "latency_s": round(snap["total_latency_s"], 1),
                 "by_purpose": dict(snap["by_purpose"])})
    finish(args, b)
    return 0 if ok else 1


def cmd_shim(args):
    import shim_server
    if args.dry_run:
        print("DRY RUN: would start a loopback shim (127.0.0.1, bearer token required) in front of an R02-approved CLI profile.")
        return 0
    gateway = load_gateway(args)
    token = secrets.token_urlsafe(16)
    server = shim_server.make_server(gateway, port=args.port, token=token)
    print("shim listening on http://127.0.0.1:{}/v1".format(server.server_address[1]))
    print("use this value as the engine's API key (it is NOT a vendor key): {}".format(token))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    print("calls: {}  refused request kinds: {}".format(gateway.snapshot()["calls"], sorted(set(server.unsupported_requests)) or "none"))
    return 0


def cmd_embed(args):
    model = model_spec(args.model)
    if args.dry_run:
        print("DRY RUN: would run model {} via backend {} on dataset {} (top-k {}), write raw/predictions-*.jsonl and result files.".format(
            model["model_id"], args.backend, args.dataset, args.top_k))
        return 0
    b = builder(args)
    field_map = dict(eb.DEFAULT_FIELD_MAP)
    if args.field_map:
        with open(args.field_map, encoding="utf-8") as fh:
            field_map.update(json.load(fh))
    if args.dataset == "fixtures":
        docs, probes = load_fixtures()
        queries = [{"query_id": p["id"], "query": p["query"]} for p in probes["probes"]]
    else:
        docs = eb.load_sources(os.path.join(args.golden, "sources"), field_map)
        instances = eb.load_split_instances(args.golden, args.split, field_map) if args.split else None
        queries = eb.load_queries(os.path.join(args.golden, "labels"), field_map, instances)
    raw_dir = os.path.join(args.out, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    pred = os.path.join(raw_dir, "predictions-{}.jsonl".format(args.model))
    try:
        res = eb.run_embedding_bench(model, worker_argv(args), docs, queries, pred, args.top_k, args.timeout, field_map)
    except NotImplementedError as exc:
        return notice(exc)
    b.add_check("R03-C3:embed:" + args.model, "PASS",
                {"docs": res["docs"], "queries": res["queries"], "dim": res["dim"], "load_s": res["load_s"], "wall_s": res["wall_s"],
                 "docs_per_s": res["docs_per_s"], "peak_rss_mb": res["peak_rss_bytes"] // 2 ** 20, "peak_process_count": res["peak_process_count"],
                 "license_claim_is_unverified": True})
    scorer_cmd = args.scorer_cmd
    if not scorer_cmd and args.dataset == "golden" and args.split:
        score_py = os.path.join(os.path.dirname(VERIF), "eval", "scorer", "score.py")
        scorer_cmd = json.dumps([sys.executable, score_py, args.golden, "{predictions}", "--split", args.split])
    if scorer_cmd:
        argv = [a.replace("{predictions}", pred) for a in json.loads(scorer_cmd)]
        scored = runner_mod.run_process(argv, timeout_s=3600)
        b.add_raw("scorer_output_" + args.model, scored.stdout + scored.stderr)
        retrieval = {}
        try:
            retrieval = json.loads(scored.stdout)["retrieval"]
        except (ValueError, KeyError, TypeError):
            pass
        b.add_check("R03-C3:score:" + args.model, "PASS" if scored.returncode == 0 and retrieval else "FAIL",
                    {"scorer_exit": scored.returncode if scored.returncode is not None else -1,
                     **{k: v for k, v in retrieval.items() if k in ("n_queries", "missing_predictions", "recall_at_k", "precision_at_k", "mrr") and isinstance(v, (int, float))}})
    finish(args, b)
    return 0


def sha12(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return "h:" + h.hexdigest()[:12]


def cmd_embed_offline(args):
    model = model_spec(args.model)
    if args.dry_run:
        print("DRY RUN: would re-run the worker with HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 (names UNCONFIRMED, not in OSS_EVALUATION) and scan {} for license files.".format(args.cache_dir))
        return 0
    b = builder(args)
    docs, probes = load_fixtures()
    queries = [{"query_id": p["id"], "query": p["query"]} for p in probes["probes"]]
    with tempfile.TemporaryDirectory() as d:
        try:
            eb.run_embedding_bench(model, worker_argv(args), docs[:3], queries[:1], os.path.join(d, "p.jsonl"), 3, 1800,
                                   extra_env={"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
            worker_ok = True
        except NotImplementedError as exc:
            return notice(exc)
        except RuntimeError as exc:
            worker_ok = False
            b.add_raw("offline_error_" + args.model, str(exc)[:500])
    lic_hashes, total = [], 0
    if args.cache_dir and os.path.isdir(args.cache_dir):
        for root, _dirs, files in os.walk(args.cache_dir):
            for f in files:
                path = os.path.join(root, f)
                total += os.path.getsize(path)
                if f.upper().startswith(("LICENSE", "NOTICE")) or f.lower() == "readme.md":
                    lic_hashes.append(sha12(path))
        b.add_metric("model_cache_bytes_" + args.model.replace("-", "_"), total, "bytes")
    if not worker_ok:
        verdict, codes = "FAIL", []
    elif args.outbound_blocked_attested:
        verdict, codes = "PASS", ["offline_attested_by_operator"]
    else:
        verdict, codes = "INCONCLUSIVE", ["offline_not_observed"]
    b.add_check("R03-C3:offline:" + args.model, verdict,
                {"worker_ok_with_offline_variables": worker_ok, "outbound_blocked_attested": bool(args.outbound_blocked_attested),
                 "license_file_count": len(lic_hashes), "license_file_hashes": lic_hashes, "license_claim_is_unverified": True}, codes)
    finish(args, b)
    return 0 if worker_ok else 1


def cmd_storage(args):
    if args.dry_run:
        print("DRY RUN: would run the standard temporal-store check series on {} in {}.".format(args.store, args.workdir))
        return 0
    factory = store_mod.SqliteProductStore if args.store == "sqlite" else store_mod.CortexDbStore
    os.makedirs(args.workdir, exist_ok=True)
    try:
        outcomes = store_mod.run_store_checks(factory, os.path.join(args.workdir, "store.sqlite"))
    except NotImplementedError as exc:
        return notice(exc)
    b = builder(args)
    for r in outcomes:
        b.add_check("R03-C4:store:{}:{}".format(args.store, r["name"]), "PASS" if r["ok"] else "FAIL", {"ok": bool(r["ok"])})
        b.add_raw("store_{}_{}".format(args.store, r["name"]), r["detail"])
    finish(args, b)
    return 0 if outcomes and all(r["ok"] for r in outcomes) else 1


def cmd_durability(args):
    if args.dry_run:
        print("DRY RUN: would run {} durability check(s) on target {} in {}.".format(args.check, args.target, args.workdir))
        return 0
    if args.target != "sqlite":
        return notice(NotImplementedError("R03-S1..S3: durability checks on engine '{}' need the adapter implementation".format(args.target)))
    b = builder(args)
    checks = ("crash", "concurrent", "single-writer") if args.check == "all" else (args.check,)
    ok_all = True
    for name in checks:
        d = os.path.join(args.workdir, name)
        os.makedirs(d, exist_ok=True)
        if name == "crash":
            res = durability.crash_check("sqlite", d)
        elif name == "concurrent":
            res = durability.concurrent_read_check(durability.SqliteTarget(), d)
        else:
            res = durability.single_writer_check(durability.SqliteTarget(), d)
        ok_all &= res["ok"]
        facts = numeric_facts(res)
        facts["integrity_error_count"] = len(res.get("integrity_errors", []))
        b.add_check("R03-C4:durability:{}:sqlite".format(name), "PASS" if res["ok"] else "FAIL", facts, ["crash_check_sqlite_only"] if name == "crash" else [])
    finish(args, b)
    return 0 if ok_all else 1


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if getattr(args, "pass_env", None):
            runner_mod.set_passthrough(args.pass_env)
    except ValueError as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 2
    try:
        if args.command == "plan":
            return cmd_plan()
        if args.command == "install-steps":
            return cmd_install_steps()
        if args.command == "inspect-golden":
            print(json.dumps(eb.describe_golden(args.golden), indent=2, ensure_ascii=False))
            return 0
        return {"scenario": cmd_scenario, "cli-adapter": cmd_cli_adapter, "shim": cmd_shim, "embed": cmd_embed,
                "embed-offline-check": cmd_embed_offline, "storage-compare": cmd_storage, "durability": cmd_durability}[args.command](args)
    except NotImplementedError as exc:
        return notice(exc)


if __name__ == "__main__":
    sys.exit(main())
