"""cognee adapter skeleton (R03-S2).

STATUS: STUB, NEVER EXECUTED. cognee is not installed or imported here. Every call raises SiteTodo.
Pins (docs/OSS_EVALUATION.md 2.1): PyPI/release v1.6.10 (primary), HEAD 1961133d0c68 (secondary).
Evidence permalinks at SHA 1961133d0c68b450fe8e71941a756371e94f7c04
(base https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/).
LLM route: the closed provider list has no CLI adapter, so cognee talks to the loopback OpenAI-compatible
shim (shim_server.py) through its `custom` provider. Which structured-output mode (tool calling or json
schema) litellm/instructor uses is UNCONFIRMED; the shim records any `tools` request it must refuse.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from engine_adapter import StubAdapter  # noqa: E402

B = "https://github.com/topoteretes/cognee/blob/1961133d0c68b450fe8e71941a756371e94f7c04/"
L = B + "cognee/infrastructure/llm/structured_output_framework/litellm_instructor/llm/get_llm_client.py"


class CogneeAdapter(StubAdapter):
    ITEM_ID = "R03-S2"
    name = "cognee"
    pinned_version = "1.6.10 (release, primary) | 1961133d0c68 (HEAD, secondary)"
    PLANNED_CALLS = [
        {"call": "setup: select the `custom` LLM provider (OpenAI-compatible) and point it at the loopback shim", "evidence": L + "#L300-L317 (E1.4)"},
        {"call": "setup: configuration key / environment variable names for provider, endpoint, dummy key", "evidence": None},
        {"call": "setup: multilingual embedder (default is English-only bge-small-en-v1.5)", "evidence": B + "cognee/infrastructure/databases/vector/embeddings/config.py#L30 ; get_embedding_engine.py#L126-L190 (E1.5)"},
        {"call": "setup: turn telemetry off (variable name TELEMETRY_DISABLED is mentioned, effect unverified)", "evidence": None},
        {"call": "ingest: add documents (the `remember()` call is named in an issue title; exact add/remember signature and doc id handling unknown)", "evidence": None},
        {"call": "extract/relate: the cognify pipeline (one LLM call per chunk by default; summary_method llm doubles it; extractor gliner = 0)", "evidence": B + "cognee/api/v1/cognify/cognify.py#L700-L760 ; cognify/config.py#L22 (E1.6)"},
        {"call": "update: `update(..., chunk_level_diff=True)` re-extracts only changed chunks (unchanged-chunk skip unverified)", "evidence": B + "cognee/api/v1/update/update.py#L36-L90 (E1.7)"},
        {"call": "delete: `forget()` removes graph, vectors, raw data and sessions (shared-fact survival unverified)", "evidence": B + "cognee/api/v1/forget/forget.py#L36-L100 ; #L546-L600 (E1.8)"},
        {"call": "query: search API name, search types, how to read source documents of a hit", "evidence": None},
        {"call": "export: edge -> chunk -> document evidence exists in the store; the export API is unknown", "evidence": B + "cognee/modules/provenance/edge_evidence/__init__.py#L1-L33 (E1.9)"},
        {"call": "restart: re-open SQLite + LanceDB + Ladybug stores; consistency after a crash (no cross-store transaction found)", "evidence": B + "pyproject.toml#L106-L120 (E1.10)"},
        {"call": "Windows packaged-host failure (issue #6808, inherited PYTHONPATH) reproduction", "evidence": None},
    ]
