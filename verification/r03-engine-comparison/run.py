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
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
for path in (HERE, VERIF):
    if path not in sys.path:
        sys.path.insert(0, path)

from common import fingerprint  # noqa: E402
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
    b.set_environment(env)
    b.add_note("Written off-site. Unit tests of this kit are not site evidence (issue #37).")
    b.merge_from(os.path.join(args.out, "result.json"))
    jpath, _ = b.write()
    print("wrote {} and result.md".format(os.path.basename(jpath)))
    for c in b.build()["checks"]:
        print("  {:13} {}".format(c["verdict"], c["id"]))


def build_parser():
    ap = argparse.ArgumentParser(prog="run.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    def common(sp, out=True):
        if out:
            sp.add_argument("--out", default="r03-result")
        sp.add_argument("--redact", action="append", default=[])
        sp.add_argument("--dry-run", action="store_true")

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
    sp.add_argument("--scorer-cmd", help="JSON array; {predictions} is replaced. Confirm eval/scorer/score.py arguments first")
    sp.add_argument("--timeout", type=float, default=7200.0)
    sp = sub.add_parser("embed-offline-check"); common(sp)
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
    from common import runner
    if not (args.r02_result and args.profile and args.model):
        raise SystemExit("error: --r02-result, --profile and --model are required for --llm-mode cli")
    profile = profiles.get_profile(profiles.load_profiles(), args.profile)
    binary = os.path.abspath(args.cli_bin) if args.cli_bin else runner.resolve_executable(profile["cli"], runner.build_env())
    if not binary:
        raise SystemExit("error: the {} CLI was not found; pass --cli-bin".format(profile["cli"]))
    llm_gateway.gate_check(args.r02_result, args.profile, fingerprint.cli_version(binary))
    return llm_gateway.LLMGateway(llm_gateway.CliBackend(profile, binary, args.model, args.timeout))


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
            b.add_check("R03-C2:gate:" + args.engine, "only R02-approved CLI profiles are used", "BLOCKED", str(exc))
            finish(args, b)
            return 4
    result = scenario_mod.run_scenario(adapter, records, probes, gateway, args.workdir)
    for step in result.steps:
        verdict = "PASS" if step.ok else "FAIL"
        unverified = [c.name for c in step.checks if c.ok is None]
        b.add_check("R03-C1:{}:{}".format(args.engine, step.name), "scenario step " + step.name, verdict,
                    "wall={:.2f}s llm_calls={} peak_rss={}MB store={}KB; failed: {}".format(
                        step.wall_s, step.llm_calls, step.peak_rss_bytes // 2**20, step.store_bytes // 1024,
                        [c.name for c in step.checks if c.ok is False] or "none"),
                    note=("unverified: " + ", ".join(unverified)) if unverified else step.error,
                    data={"checks": [c.__dict__ for c in step.checks], "llm_by_purpose": step.llm_by_purpose})
    snap = gateway.snapshot()
    b.add_metric("llm_calls_total:" + args.engine, snap["calls"])
    b.add_metric("llm_latency_total_s:" + args.engine, round(snap["total_latency_s"], 3), "s")
    if result.not_implemented:
        step_name, message = result.not_implemented[0]
        b.add_check("R03-C1:{}:{}".format(args.engine, step_name), "scenario step " + step_name, "NOT_RUN", message[:400])
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
        b.add_check("R03-C2:cli-adapter", "engine LLM calls via an R02-approved CLI profile", "BLOCKED", str(exc))
        finish(args, b)
        return 4
    schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"], "additionalProperties": False}
    try:
        out = gateway.complete("Reply with the single word ok in the answer field.", purpose="structured", schema=schema)
        ok = isinstance(out, dict) and "answer" in out
    except Exception as exc:
        ok, out = False, type(exc).__name__
    snap = gateway.snapshot()
    b.add_check("R03-C2:cli-adapter", "engine LLM calls via an R02-approved CLI profile", "PASS" if ok else "FAIL",
                "1 structured call: ok={} latency={:.1f}s".format(ok, snap["total_latency_s"]),
                note="generate/structured only; embed and rerank have no CLI path (see gateway). Which kinds each engine really needs is confirmed in the scenario runs.",
                data=snap)
    finish(args, b)
    return 0 if ok else 1


def cmd_shim(args):
    import shim_server
    if args.dry_run:
        print("DRY RUN: would start a loopback shim (127.0.0.1) in front of an R02-approved CLI profile.")
        return 0
    gateway = load_gateway(args)
    server = shim_server.make_server(gateway, port=args.port)
    print("shim listening on http://127.0.0.1:{}/v1  (dummy API key; Ctrl-C to stop)".format(server.server_address[1]))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    print("calls: {}  refused request kinds: {}".format(gateway.snapshot()["calls"], sorted(set(server.unsupported_requests)) or "none"))
    return 0


def cmd_embed(args):
    model = model_spec(args.model)
    if args.dry_run:
        print("DRY RUN: would run model {} via backend {} on dataset {} (top-k {}), write predictions.jsonl and result files.".format(
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
        split_ids = None
        if args.split:
            with open(os.path.join(args.golden, "splits.json"), encoding="utf-8") as fh:
                split_ids = set(json.load(fh)[args.split])
        queries = eb.load_queries(os.path.join(args.golden, "labels"), field_map, split_ids)
    os.makedirs(args.out, exist_ok=True)
    pred = os.path.join(args.out, "predictions-{}.jsonl".format(args.model))
    try:
        res = eb.run_embedding_bench(model, worker_argv(args), docs, queries, pred, args.top_k, args.timeout, field_map)
    except NotImplementedError as exc:
        return notice(exc)
    b.add_check("R03-C3:embed:" + args.model, "embedding speed/memory and predictions for the scorer", "PASS",
                "docs={} queries={} dim={} load={}s docs/s={} peak_rss={}MB".format(
                    res["docs"], res["queries"], res["dim"], res["load_s"], res["docs_per_s"], res["peak_rss_bytes"] // 2**20),
                note="retrieval QUALITY is judged by eval/scorer/score.py on the predictions file, not here; license_claim={}".format(model["license_claim"]),
                data=res)
    if args.scorer_cmd:
        from common import runner
        argv = [a.replace("{predictions}", pred) for a in json.loads(args.scorer_cmd)]
        scored = runner.run_process(argv, timeout_s=3600)
        b.add_raw("scorer_output:" + args.model, scored.stdout + scored.stderr)
        b.add_check("R03-C3:score:" + args.model, "eval/scorer/score.py ran on the predictions", "PASS" if scored.returncode == 0 else "FAIL",
                    "exit={}".format(scored.returncode))
    else:
        b.add_note("Run eval/scorer/score.py on {} (check its arguments first; its CLI was not known when this kit was written).".format(os.path.basename(pred)))
    finish(args, b)
    return 0


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_embed_offline(args):
    model = model_spec(args.model)
    if args.dry_run:
        print("DRY RUN: would re-run the worker with HF_HUB_OFFLINE=1 / TRANSFORMERS_OFFLINE=1 (names UNCONFIRMED) and scan {} for license files.".format(args.cache_dir))
        return 0
    b = builder(args)
    docs, probes = load_fixtures()
    queries = [{"query_id": p["id"], "query": p["query"]} for p in probes["probes"]]
    with tempfile.TemporaryDirectory() as d:
        try:
            res = eb.run_embedding_bench(model, worker_argv(args), docs[:3], queries[:1], os.path.join(d, "p.jsonl"), 3, 1800,
                                         extra_env={"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
            ok, note = True, "worker loaded and encoded with offline variables set (set the site firewall to block outbound traffic too; the kit cannot observe connections)"
        except NotImplementedError as exc:
            return notice(exc)
        except RuntimeError as exc:
            ok, res, note = False, {}, str(exc)[:300]
    lic = []
    if args.cache_dir and os.path.isdir(args.cache_dir):
        total = 0
        for root, _dirs, files in os.walk(args.cache_dir):
            for f in files:
                p = os.path.join(root, f)
                total += os.path.getsize(p)
                if f.upper().startswith(("LICENSE", "NOTICE")) or f.lower() == "readme.md":
                    lic.append({"file": f, "bytes": os.path.getsize(p), "sha256": sha256_of(p)})
        b.add_metric("model_cache_bytes:" + args.model, total, "bytes")
    b.add_check("R03-C3:offline:" + args.model, "model works from the local cache without network; license files recorded",
                "PASS" if ok else "FAIL", note, data={"license_files": lic, "license_claim": model["license_claim"]})
    finish(args, b)
    return 0 if ok else 1


def cmd_storage(args):
    if args.dry_run:
        print("DRY RUN: would run the standard temporal-store check series on {} in {}.".format(args.store, args.workdir))
        return 0
    factory = store_mod.SqliteProductStore if args.store == "sqlite" else store_mod.CortexDbStore
    os.makedirs(args.workdir, exist_ok=True)
    try:
        results = store_mod.run_store_checks(factory, os.path.join(args.workdir, "store.sqlite"))
    except NotImplementedError as exc:
        return notice(exc)
    b = builder(args)
    for r in results:
        b.add_check("R03-C4:store:{}:{}".format(args.store, r["name"]), "temporal store check " + r["name"],
                    "PASS" if r["ok"] else "FAIL", r["detail"][:300])
    finish(args, b)
    return 0 if all(r["ok"] for r in results) else 1


def cmd_durability(args):
    if args.dry_run:
        print("DRY RUN: would run {} durability check(s) on target {} in {}.".format(args.check, args.target, args.workdir))
        return 0
    if args.target != "sqlite":
        return notice(NotImplementedError("R03-S1..S3: durability checks on engine '{}' need the adapter implementation".format(args.target)))
    b = builder(args)
    base = args.workdir
    checks = ("crash", "concurrent", "single-writer") if args.check == "all" else (args.check,)
    ok_all = True
    for name in checks:
        d = os.path.join(base, name)
        os.makedirs(d, exist_ok=True)
        if name == "crash":
            res = durability.crash_check("sqlite", d)
        elif name == "concurrent":
            res = durability.concurrent_read_check(durability.SqliteTarget(), d)
        else:
            res = durability.single_writer_check(durability.SqliteTarget(), d)
        ok_all &= res["ok"]
        b.add_check("R03-C4:durability:{}:sqlite".format(name), "durability check " + name, "PASS" if res["ok"] else "FAIL", json.dumps(res)[:400], data=res)
    finish(args, b)
    return 0 if ok_all else 1


def main(argv=None):
    args = build_parser().parse_args(argv)
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
