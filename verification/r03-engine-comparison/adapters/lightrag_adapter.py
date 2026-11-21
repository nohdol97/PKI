"""LightRAG adapter skeleton (R03-S1).

STATUS: STUB, NEVER EXECUTED. LightRAG is not installed or imported here. Every call raises SiteTodo.
Pins (docs/OSS_EVALUATION.md 2.1): release PyPI 1.5.7 (primary) or HEAD 01261ed135bf (1.5.8rc, secondary).
Evidence links below are permalinks at SHA 01261ed135bfd2f821ff476ed2894b35288a30f8
(base https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/).
A call with evidence=None has NO evidence in OSS_EVALUATION and is left for the site to confirm.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from engine_adapter import StubAdapter  # noqa: E402

B = "https://github.com/HKUDS/LightRAG/blob/01261ed135bfd2f821ff476ed2894b35288a30f8/"


class LightRagAdapter(StubAdapter):
    ITEM_ID = "R03-S1"
    name = "lightrag"
    pinned_version = "1.5.7 (release, primary) | 01261ed135bf (HEAD 1.5.8rc, secondary)"
    PLANNED_CALLS = [
        {"call": "setup: pass the gateway as the `llm_model_func` callable", "evidence": B + "lightrag/lightrag.py#L1143 ; " + B + "docs/ProgramingWithCore.md#L96 (E3.2)"},
        {"call": "setup: pass the local embedder as an `EmbeddingFunc`", "evidence": B + "lightrag/lightrag.py#L1073 ; " + B + "lightrag/utils.py#L678-L708 (E3.3)"},
        {"call": "setup: inject an offline tokenizer (avoid the first-use tiktoken download)", "evidence": B + "lightrag/lightrag.py#L958 ; " + B + "lightrag/tiktoken_cache.py#L1-L30 (E3.3)"},
        {"call": "setup: file-based default storage under the working dir (documented as test-scale only)", "evidence": B + "lightrag/lightrag.py#L824 ; " + B + "docs/design/FileBackedSnapshotContract.md#L22-L24 (E3.4)"},
        {"call": "setup: required initialisation sequence of the LightRAG object (async init, pipeline status)", "evidence": None},
        {"call": "ingest/extract/relate: the insert method name and signature, how a document id is supplied", "evidence": None},
        {"call": "update: delete by document id, then re-ingest (same name+content is rejected as a duplicate)", "evidence": B + "docs/FileProcessingPipeline.md#L871-L875 (E3.6)"},
        {"call": "delete: `adelete_by_doc_id` rebuilds affected entities from the extraction cache", "evidence": B + "lightrag/lightrag.py#L8124-L8137 (E3.5)"},
        {"call": "query: method name, mode names, and how to read the supporting chunks / source ids", "evidence": None},
        {"call": "export: any API that returns extracted entities/relations with their source chunks (reading the on-disk graph files is the fallback)", "evidence": None},
        {"call": "restart: re-create the object on the same working dir; processing documents are recovered on restart", "evidence": B + "docs/FileProcessingPipeline.md#L1062 (E3.8)"},
        {"call": "integrity_check: `kg_integrity_repair` reports orphan data after a half-finished delete", "evidence": B + "docs/FileProcessingPipeline.md#L1085 (E3.5)"},
        {"call": "single process only: working-dir lock; Gunicorn multi-process is not supported on Windows", "evidence": B + "lightrag/kg/working_dir_lock.py#L121-L154 ; " + B + "docs/LightRAG-API-Server.md#L213 (E3.8)"},
        {"call": "pipmaster runtime pip install behaviour (can it be blocked?)", "evidence": None},
    ]
