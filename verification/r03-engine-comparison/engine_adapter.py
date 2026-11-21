"""EngineAdapter protocol and shared types for the R03 engine comparison.

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only); no candidate engine has been installed, imported or run.
"""
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol, Set


class SiteTodo(NotImplementedError):
    """An upstream API behaviour that cannot be confirmed off-site (spec: 배포처 후속).

    `run.py` turns this into the notice `미구현, 배포처 후속: <item>` and a non-zero exit.
    """

    def __init__(self, item_id, what, missing_evidence):
        self.item_id = item_id
        super().__init__("{}: {}. Missing evidence: {}".format(item_id, what, missing_evidence))


@dataclass
class Hit:
    source_id: str
    text: str
    score: float = 0.0


@dataclass
class ExportResult:
    """What the engine can hand back: every source id it still references and extracted facts with evidence."""
    source_ids: Set[str]
    facts: List[dict] = field(default_factory=list)


class EngineAdapter(Protocol):
    """Contract every candidate adapter fulfils. A source record is {"id","title","lang","text"}."""

    name: str
    pinned_version: str

    def setup(self, workdir: str, gateway) -> None:
        """Create/open the engine's store under `workdir`; route ALL LLM calls through `gateway`."""

    def ingest(self, record: dict) -> None: ...

    def update(self, record: dict) -> None:
        """Replace the content of an existing source id (incremental edit)."""

    def delete(self, source_id: str) -> None: ...

    def query(self, text: str, k: int = 5) -> List[Hit]: ...

    def export(self) -> ExportResult: ...

    def restart(self) -> None:
        """Close and reopen the engine from its on-disk state (a new process where the engine needs one)."""

    def stats(self) -> Dict[str, float]: ...

    def close(self) -> None: ...

    # Optional phase hooks (engines that extract/relate inside ingest leave them out):
    #   def extract(self) -> None
    #   def relate(self) -> None
    # Optional: def child_pids(self) -> List[int] when the engine runs as a separate process.
    # Optional: def integrity_check(self) -> List[str]


class StubAdapter:
    """Base for adapters whose upstream calls are unconfirmed. Subclasses list PLANNED_CALLS; calls with
    `evidence=None` have NO evidence in docs/OSS_EVALUATION.md and are never guessed."""

    ITEM_ID = "R03-S?"
    name = "stub"
    pinned_version = "unpinned"
    PLANNED_CALLS: list = []

    def _todo(self, call):
        missing = [c["call"] for c in self.PLANNED_CALLS if c["evidence"] is None]
        raise SiteTodo(self.ITEM_ID, "{} adapter call '{}' is not confirmed".format(self.name, call),
                       "; ".join(missing) or "see PLANNED_CALLS")

    @classmethod
    def missing_evidence(cls):
        return [c["call"] for c in cls.PLANNED_CALLS if c["evidence"] is None]

    def setup(self, workdir, gateway):
        self._todo("setup")

    def ingest(self, record):
        self._todo("ingest")

    def update(self, record):
        self._todo("update")

    def delete(self, source_id):
        self._todo("delete")

    def query(self, text, k=5):
        self._todo("query")

    def export(self):
        self._todo("export")

    def restart(self):
        self._todo("restart")

    def stats(self):
        self._todo("stats")

    def close(self):
        pass
