"""Fake engine adapters for the R03 scenario tests (in-memory inverted index). Never a real engine."""
import re

try:
    from . import _paths  # noqa: F401
except ImportError:
    import _paths  # noqa: F401

engine_adapter = _paths.load_kit_module("r03-engine-comparison", "engine_adapter.py", "engine_adapter")
Hit = engine_adapter.Hit
ExportResult = engine_adapter.ExportResult


def words(text):
    return set(re.findall(r"\w+", text.lower()))


class FakeAdapter:
    """Correct behaviour. Each ingest/update makes one gateway call so call counting is visible."""
    name = "fake-good"
    pinned_version = "0"

    def __init__(self, gateway=None):
        self.gateway = gateway
        self.docs = {}
        self.persist = {}

    def setup(self, workdir, gateway):
        self.gateway = gateway
        self.workdir = workdir

    def _llm(self, text):
        if self.gateway:
            self.gateway.complete("extract: " + text[:20], purpose="structured")

    def ingest(self, record):
        self._llm(record["text"])
        self.docs[record["id"]] = record["text"]
        self.persist = dict(self.docs)

    def update(self, record):
        self._llm(record["text"])
        self.docs[record["id"]] = record["text"]
        self.persist = dict(self.docs)

    def delete(self, source_id):
        self.docs.pop(source_id, None)
        self.persist = dict(self.docs)

    def query(self, text, k=5):
        q = words(text)
        scored = sorted(((len(q & words(t)), sid, t) for sid, t in self.docs.items()), reverse=True)
        return [Hit(sid, t, float(s)) for s, sid, t in scored[:k] if s > 0]

    def export(self):
        return ExportResult(set(self.docs), [{"text": t, "evidence": [sid]} for sid, t in self.docs.items()])

    def restart(self):
        self.docs = dict(self.persist)

    def stats(self):
        return {}

    def close(self):
        pass


class LeakyDeleteAdapter(FakeAdapter):
    """Bug: delete leaves the text reachable through a stale derived index."""
    name = "fake-leaky-delete"

    def delete(self, source_id):
        self.stale = getattr(self, "stale", {})
        self.stale[source_id] = self.docs.pop(source_id, "")
        self.persist = dict(self.docs)

    def query(self, text, k=5):
        hits = super().query(text, k)
        q = words(text)
        for sid, t in getattr(self, "stale", {}).items():
            if q & words(t):
                hits.append(Hit(sid, t, 0.5))
        return hits


class AmnesiaAdapter(FakeAdapter):
    """Bug: restart loses everything."""
    name = "fake-amnesia"

    def restart(self):
        self.docs = {}


class StaleEditAdapter(FakeAdapter):
    """Bug: update appends instead of replacing, so the old claim stays searchable."""
    name = "fake-stale-edit"

    def update(self, record):
        self._llm(record["text"])
        self.docs[record["id"]] = self.docs.get(record["id"], "") + " " + record["text"]
        self.persist = dict(self.docs)


class StubAdapter:
    name = "stub"
    pinned_version = "0"

    def setup(self, workdir, gateway):
        raise NotImplementedError("stub: upstream API unconfirmed")


class PartialAmnesiaAdapter(FakeAdapter):
    """Bug: restart silently drops one unrelated document (the survivor and forbidden probes still pass)."""
    name = "fake-partial-amnesia"

    def restart(self):
        self.docs = {k: v for k, v in self.persist.items() if k != "s3"}
