"""Harmless stdio MCP server stub owned by the harness (R02 negative test A4).

STATUS: written only; never started by a real CLI. It exists so that "the CLI loaded the project MCP
config" and "the CLI called an MCP tool" become observable: every start and every received message is
appended to the log file given as argv[1]. The log being non-empty means a leak.
Protocol handling is minimal on purpose (newline-delimited JSON-RPC: initialize, tools/list, tools/call).
"""
import json
import sys


def log(path, line):
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def main():
    log_path = sys.argv[1]
    log(log_path, "started")
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            log(log_path, "bad-json")
            continue
        method = msg.get("method")
        log(log_path, "recv " + str(method))
        if "id" not in msg:
            continue
        if method == "initialize":
            result = {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "t_mcp", "version": "0"}}
        elif method == "tools/list":
            result = {"tools": [{"name": "t_mcp_ping", "description": "synthetic harmless tool",
                                 "inputSchema": {"type": "object"}}]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": "pong"}]}
        else:
            result = {}
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
