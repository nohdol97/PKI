"""LLM gateway: every LLM call of an engine goes through here so calls can be counted (R03-C1, C2).

STATUS: written only; never run against a real CLI. `CliBackend` reuses the R02 profiles and only
accepts a profile whose R02 result is CONTAINED_ON_OBSERVABLES for the same CLI version (R03-R4).
No API-key path exists: the child environment is the scrubbed one from common.runner.
Prompt text is never stored, only counts, latency and prompt length.
"""
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
R02_DIR = os.path.join(VERIF, "r02-cli-isolation")
for _p in (VERIF, R02_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

TEXT_SCHEMA = {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"], "additionalProperties": False}


class GateBlocked(Exception):
    """The requested CLI profile has no CONTAINED_ON_OBSERVABLES record from R02."""


class BackendError(Exception):
    pass


class LLMGateway:
    def __init__(self, backend):
        self.backend = backend
        self._calls = 0
        self._failures = 0
        self._latency = 0.0
        self._chars = 0
        self._by_purpose = {}

    def complete(self, prompt, purpose="generate", schema=None):
        self._calls += 1
        self._chars += len(prompt)
        self._by_purpose[purpose] = self._by_purpose.get(purpose, 0) + 1
        started = time.time()
        try:
            return self.backend(prompt, schema)
        except Exception:
            self._failures += 1
            raise
        finally:
            self._latency += time.time() - started

    def embed(self, texts):
        raise NotImplementedError("embeddings never go through a CLI; use the embedding worker (embedding_bench.py)")

    def rerank(self, query, candidates):
        raise NotImplementedError("no CLI path for rerank is planned; confirm per engine on site (R03-C2)")

    def snapshot(self):
        return {"calls": self._calls, "failures": self._failures, "total_latency_s": self._latency,
                "prompt_chars": self._chars, "by_purpose": dict(self._by_purpose)}


def delta(before, after):
    by = {k: after["by_purpose"].get(k, 0) - before["by_purpose"].get(k, 0) for k in after["by_purpose"]}
    return {"calls": after["calls"] - before["calls"], "failures": after["failures"] - before["failures"],
            "total_latency_s": after["total_latency_s"] - before["total_latency_s"],
            "prompt_chars": after["prompt_chars"] - before["prompt_chars"],
            "by_purpose": {k: v for k, v in by.items() if v}}


def gate_check(r02_result_path, profile_name, current_cli_version):
    """Allow a CLI profile only if R02 recorded CONTAINED_ON_OBSERVABLES for it, on this CLI version."""
    import profiles as r02_profiles
    try:
        profile = r02_profiles.get_profile(r02_profiles.load_profiles(), profile_name)
    except r02_profiles.ProfileError as exc:
        raise GateBlocked(str(exc))
    if profile["kind"] != "contained":
        raise GateBlocked("{} is a control profile and can never be used for real work".format(profile_name))
    try:
        with open(r02_result_path, encoding="utf-8") as fh:
            result = json.load(fh)
    except (OSError, ValueError) as exc:
        raise GateBlocked("R02 result unreadable ({}); run R02 first".format(type(exc).__name__))
    wanted = "R02-C3:negative:" + profile_name
    for check in result.get("checks", []):
        if check.get("id") == wanted:
            data = check.get("data") or {}
            if data.get("profile_verdict") != "CONTAINED_ON_OBSERVABLES":
                raise GateBlocked("R02 verdict for {} is {}; automatic use stays blocked".format(profile_name, data.get("profile_verdict")))
            if data.get("cli_version") != current_cli_version:
                raise GateBlocked("R02 judged CLI version {} but {} is installed; re-run R02".format(data.get("cli_version"), current_cli_version))
            return True
    raise GateBlocked("no R02 containment record for {}".format(profile_name))


class CliBackend:
    """Backend that calls a CLI profile that passed R02. Every call is a structured call; plain generation
    is wrapped as {"text": ...}. Never runs unless gate_check passed (done by the caller before construction)."""

    def __init__(self, profile, binary, model, timeout_s=300):
        self.profile, self.binary, self.model, self.timeout_s = profile, binary, model, timeout_s

    def __call__(self, prompt, schema):
        import negative
        used = schema or TEXT_SCHEMA
        stdin = prompt if schema else prompt + "\n\nReturn a JSON object with one string field named text."
        workdir = tempfile.mkdtemp(prefix="r03llm-")
        try:
            facts = negative.execute_profile(self.profile, prompt_doc="", workdir=workdir, model=self.model, schema=used,
                                             timeout_s=self.timeout_s, binary=self.binary, stdin_override=stdin)
        finally:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)
        res = facts["run"]
        if res.returncode != 0 or res.timed_out or facts["structured"] is None or facts["schema_errors"]:
            raise BackendError("CLI call failed: exit={} timed_out={} errors={}".format(res.returncode, res.timed_out, facts["schema_errors"][:2]))
        return facts["structured"]
