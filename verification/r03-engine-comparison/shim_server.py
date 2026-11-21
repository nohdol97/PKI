"""Loopback OpenAI-compatible shim in front of the LLM gateway (R03-C2, cognee `custom` provider plan).

STATUS: written only; never connected to cognee or any real client. It serves only what could be
confirmed from general OpenAI API shape: POST /v1/chat/completions with plain messages and
response_format json_schema/json_object. Which structured-output mode cognee (litellm/instructor)
really uses is UNCONFIRMED (OSS_EVALUATION E1.4); a `tools`/`functions` request is answered 501 and
recorded in `server.unsupported_requests` so the site learns which mode is needed. Binds 127.0.0.1 only.
"""
import http.server
import json
import time


def _flatten(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))
    return ""


class _Server(http.server.ThreadingHTTPServer):
    def __init__(self, addr, handler, gateway, token=None):
        super().__init__(addr, handler)
        self.gateway = gateway
        self.token = token
        self.unsupported_requests = []


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, status, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        token = self.server.token
        return token is None or self.headers.get("Authorization") == "Bearer " + token

    def do_POST(self):
        if not self._authorized():
            return self._send(401, {"error": {"message": "missing or wrong bearer token"}})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._send(400, {"error": {"message": "invalid JSON"}})
        if self.path != "/v1/chat/completions":
            self.server.unsupported_requests.append(self.path)
            return self._send(501, {"error": {"message": "shim serves only /v1/chat/completions; embeddings use the embedding worker"}})
        for key in ("tools", "functions", "tool_choice"):
            if body.get(key):
                self.server.unsupported_requests.append(key)
                return self._send(501, {"error": {"message": "{} mode is not supported by the shim (R03-S2: confirm which structured mode the engine uses)".format(key)}})
        prompt = "\n\n".join("{}: {}".format(m.get("role", "user"), _flatten(m.get("content"))) for m in body.get("messages", []))
        schema = None
        rf = body.get("response_format") or {}
        if rf.get("type") == "json_schema":
            schema = (rf.get("json_schema") or {}).get("schema")
        elif rf.get("type") == "json_object":
            schema = {"type": "object"}
        try:
            result = self.server.gateway.complete(prompt, purpose="structured" if schema else "generate", schema=schema)
        except Exception as exc:
            return self._send(502, {"error": {"message": "backend failed: " + type(exc).__name__}})
        content = json.dumps(result) if schema else (result.get("text") if isinstance(result, dict) and "text" in result else json.dumps(result))
        self._send(200, {"id": "shim-1", "object": "chat.completion", "created": int(time.time()), "model": body.get("model", "shim"),
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                         "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})

    do_GET = do_POST


def make_server(gateway, port=0, token=None):
    """Loopback only. With a token, every request must carry `Authorization: Bearer <token>` (another local
    process cannot use the CLI login through the shim without it)."""
    return _Server(("127.0.0.1", port), _Handler, gateway, token)
