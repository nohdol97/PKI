"""sage-wiki adapter skeleton (R03-S3).

STATUS: STUB, NEVER EXECUTED. sage-wiki is not downloaded, built or run here. Every call raises SiteTodo.
Pins (docs/OSS_EVALUATION.md 3.1): release v0.2.13 (primary, asset sage-wiki_v0.2.13_windows_amd64.zip, existence only
confirmed), or build from SHA 63c9d7bd99da407d6f94f061ec138feae051c558 with CGO_ENABLED=0.
Evidence permalinks (base https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/).
It is a Go program: the plan drives the release executable as a subprocess (common.runner) and, where the
executable calls an LLM on its own (query-time expand/rerank are configuration based), points it at the
loopback shim. A Go library route (Workspace.Compile with an injected provider) would need Go code and a
Go toolchain; it is NOT part of this kit.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from engine_adapter import StubAdapter  # noqa: E402

B = "https://github.com/xoai/sage-wiki/blob/63c9d7bd99da407d6f94f061ec138feae051c558/"


class SageWikiAdapter(StubAdapter):
    ITEM_ID = "R03-S3"
    name = "sage-wiki"
    pinned_version = "v0.2.13 (release, primary) | 63c9d7bd99da (source build, secondary)"
    PLANNED_CALLS = [
        {"call": "setup: workspace/project directory layout and configuration file format", "evidence": None},
        {"call": "setup: provider injection exists only for compile (`Workspace.Compile`, WithCompileProvider); a configured provider cannot be replaced by credentials", "evidence": B + "pkg/engine/engine.go#L73-L90 ; pkg/engine/methods.go#L321 ; internal/compiler/pipeline.go#L185 (E: 3.2)"},
        {"call": "setup: query-time expand/rerank stay configuration based (CLI-only site needs the shim as an OpenAI-compatible endpoint)", "evidence": B + "pkg/engine/engine.go#L62-L67 (code comment)"},
        {"call": "setup: how the release executable is told to use an OpenAI-compatible base URL and a dummy key", "evidence": None},
        {"call": "ingest/extract/relate: executable subcommands for adding sources and compiling (triple extraction costs one more LLM call per document when enabled)", "evidence": None},
        {"call": "update: manifest diff detects changed sources", "evidence": B + "internal/compiler/diff.go#L22 (3.2)"},
        {"call": "delete: removed sources are handled (`handleRemovedSources`); cascade to orphan ontology edges/entities is unverified", "evidence": B + "internal/compiler/pipeline.go#L509-L510 ; #L1968 (3.2)"},
        {"call": "query: executable subcommand for search and how to read hit sources", "evidence": None},
        {"call": "export: relation `evidence` (supporting span), `source_doc`, bitemporal validity are modelled; the export surface is unknown", "evidence": B + "internal/ontology/ontology.go#L53-L58 ; #L303-L329 ; internal/ontology/temporal.go#L12-L26 (3.2)"},
        {"call": "restart: stop and start the executable on the same workspace (SQLite pure Go + own HNSW)", "evidence": B + "go.mod#L27 ; Makefile#L4-L5 (3.2)"},
        {"call": "in-process CPU embedder bundled or not; Korean embedding path", "evidence": None},
    ]
