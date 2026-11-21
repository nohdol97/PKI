"""R03 LLM gateway, R02-result gate and loopback shim tests (spec R03-K2). Fake backends only."""
import json
import os
import tempfile
import threading
import unittest
import urllib.request

try:
    from . import _paths
except ImportError:
    import _paths

gw = _paths.load_kit_module("r03-engine-comparison", "llm_gateway.py", "llm_gateway")
shim = _paths.load_kit_module("r03-engine-comparison", "shim_server.py", "shim_server")


def r02_result(profile, verdict, version="1.2.3", extra_checks=()):
    return {"schema_version": 1, "kit": "r02-cli-isolation", "mode": "real", "environment": {}, "metrics": {}, "raw": {},
            "checks": [{"id": "R02-C3:negative:" + profile, "criterion": "c", "verdict": "PASS", "observed": "o", "note": "",
                        "data": {"profile": profile, "profile_verdict": verdict, "cli_version": version}}] + list(extra_checks)}


class GatewayCountingTests(unittest.TestCase):
    def test_counts_by_purpose_and_latency(self):
        g = gw.LLMGateway(lambda prompt, schema: {"text": "x"})
        g.complete("a", purpose="generate")
        g.complete("b", purpose="structured", schema={"type": "object"})
        g.complete("c", purpose="structured", schema={"type": "object"})
        snap = g.snapshot()
        self.assertEqual(snap["calls"], 3)
        self.assertEqual(snap["by_purpose"], {"generate": 1, "structured": 2})
        self.assertGreaterEqual(snap["total_latency_s"], 0)
        self.assertEqual(snap["prompt_chars"], 3)

    def test_prompt_text_is_not_stored(self):
        g = gw.LLMGateway(lambda p, s: {"text": "ok"})
        g.complete("SECRET-PROMPT-BODY")
        self.assertNotIn("SECRET-PROMPT-BODY", json.dumps(g.snapshot()))

    def test_delta_between_snapshots(self):
        g = gw.LLMGateway(lambda p, s: {"text": "ok"})
        before = g.snapshot()
        g.complete("a")
        self.assertEqual(gw.delta(before, g.snapshot())["calls"], 1)

    def test_backend_failure_is_counted_and_raised(self):
        def boom(p, s):
            raise RuntimeError("backend down")
        g = gw.LLMGateway(boom)
        with self.assertRaises(RuntimeError):
            g.complete("a")
        self.assertEqual(g.snapshot()["failures"], 1)

    def test_unsupported_purposes_have_no_cli_path(self):
        g = gw.LLMGateway(lambda p, s: {"text": "ok"})
        with self.assertRaises(NotImplementedError):
            g.embed(["a"])  # embeddings never go through a CLI; they use the embedding worker
        with self.assertRaises(NotImplementedError):
            g.rerank("q", ["a"])


class GateTests(unittest.TestCase):
    def write(self, d, obj):
        path = os.path.join(d, "result.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        return path

    def test_contained_profile_allowed(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, r02_result("codex-A-full", "CONTAINED_ON_OBSERVABLES"))
            gw.gate_check(path, "codex-A-full", current_cli_version="1.2.3")

    def test_blocked_not_proven_and_missing_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            for verdict in ("BLOCKED", "NOT_PROVEN"):
                path = self.write(d, r02_result("codex-A-full", verdict))
                with self.assertRaises(gw.GateBlocked):
                    gw.gate_check(path, "codex-A-full", current_cli_version="1.2.3")
            path = self.write(d, r02_result("codex-A-full", "CONTAINED_ON_OBSERVABLES"))
            with self.assertRaises(gw.GateBlocked):
                gw.gate_check(path, "claude-A-restricted-safe", current_cli_version="1.2.3")

    def test_version_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, r02_result("codex-A-full", "CONTAINED_ON_OBSERVABLES", version="1.2.3"))
            with self.assertRaises(gw.GateBlocked):
                gw.gate_check(path, "codex-A-full", current_cli_version="1.2.4")

    def test_missing_or_garbage_file_refused(self):
        with self.assertRaises(gw.GateBlocked):
            gw.gate_check("/no/such/result.json", "codex-A-full", current_cli_version="1")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "result.json")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("{not json")
            with self.assertRaises(gw.GateBlocked):
                gw.gate_check(path, "codex-A-full", current_cli_version="1")

    def test_control_profile_never_allowed(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.write(d, r02_result("codex-X-control-readonly-default", "CONTAINED_ON_OBSERVABLES"))
            with self.assertRaises(gw.GateBlocked):
                gw.gate_check(path, "codex-X-control-readonly-default", current_cli_version="1.2.3")


class ShimTests(unittest.TestCase):
    def start(self, backend):
        g = gw.LLMGateway(backend)
        server = shim.make_server(g, port=0)
        t = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        t.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return server, g

    def post(self, server, path, body):
        req = urllib.request.Request("http://127.0.0.1:{}{}".format(server.server_address[1], path),
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as err:
            try:
                return err.code, json.loads(err.read())
            finally:
                err.close()

    def test_binds_loopback_only(self):
        server, _ = self.start(lambda p, s: {"text": "hi"})
        self.assertEqual(server.server_address[0], "127.0.0.1")

    def test_plain_chat_completion_goes_through_gateway(self):
        server, g = self.start(lambda p, s: {"text": "pong"})
        status, body = self.post(server, "/v1/chat/completions", {"model": "x", "messages": [{"role": "user", "content": "ping"}]})
        self.assertEqual(status, 200)
        self.assertEqual(body["choices"][0]["message"]["content"], "pong")
        self.assertEqual(g.snapshot()["calls"], 1)

    def test_json_schema_response_format_is_passed_as_schema(self):
        seen = {}

        def backend(prompt, schema):
            seen["schema"] = schema
            return {"a": 1}
        server, _ = self.start(backend)
        schema = {"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]}
        status, body = self.post(server, "/v1/chat/completions", {
            "messages": [{"role": "user", "content": "x"}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "n", "schema": schema}}})
        self.assertEqual(status, 200)
        self.assertEqual(seen["schema"], schema)
        self.assertEqual(json.loads(body["choices"][0]["message"]["content"]), {"a": 1})

    def test_tool_calling_mode_is_reported_not_guessed(self):
        server, _ = self.start(lambda p, s: {"text": "x"})
        status, body = self.post(server, "/v1/chat/completions", {"messages": [{"role": "user", "content": "x"}],
                                                                 "tools": [{"type": "function", "function": {"name": "f"}}]})
        self.assertEqual(status, 501)
        self.assertIn("tools", body["error"]["message"])
        self.assertEqual(server.unsupported_requests, ["tools"])

    def test_embeddings_not_served(self):
        server, _ = self.start(lambda p, s: {"text": "x"})
        status, _ = self.post(server, "/v1/embeddings", {"input": "x"})
        self.assertEqual(status, 501)


if __name__ == "__main__":
    unittest.main()
