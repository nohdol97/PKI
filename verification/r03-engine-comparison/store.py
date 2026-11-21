"""TemporalStore protocol, the product-owned SQLite schema (implemented) and the cortexdb stub (R03-C4).

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only). SqliteProductStore is exercised by unit tests on a temp file only; it has never
been run on Windows, never under crash/concurrency (see durability.py) and never compared with cortexdb.
CortexDbStore is a stub: nothing about cortexdb's call surface was confirmed off-site.

The SQLite schema IS the hypothesis under test (OSS_EVALUATION section 6 item 1): the product keeps
Knowledge/Evidence as authoritative rows; an engine would only be a rebuildable projection. Dates are
ISO-8601 strings (lexicographic order = time order). Evidence is a character span with its quote.
"""
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from engine_adapter import SiteTodo  # noqa: E402

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (source_id TEXT PRIMARY KEY, text TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS facts (
  fact_id TEXT PRIMARY KEY, subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL,
  valid_from TEXT NOT NULL, valid_to TEXT, recorded_at TEXT NOT NULL, retracted_at TEXT,
  origin TEXT NOT NULL DEFAULT 'extracted', supersedes TEXT);
CREATE TABLE IF NOT EXISTS fact_evidence (
  fact_id TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
  span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, quote TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject);
CREATE INDEX IF NOT EXISTS idx_evidence_source ON fact_evidence(source_id);
"""
FAR_FUTURE = "9999-12-31"


class SqliteProductStore:
    def open(self, path):
        self.path = path
        self.conn = sqlite3.connect(path, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=2000")
        self.conn.executescript(SCHEMA)

    def close(self):
        self.conn.close()

    def add_source(self, source_id, text):
        self.conn.execute("INSERT INTO sources(source_id, text) VALUES (?, ?)", (source_id, text))

    def source_text(self, source_id):
        row = self.conn.execute("SELECT text FROM sources WHERE source_id=?", (source_id,)).fetchone()
        return row["text"] if row else None

    def _evidence_rows(self, evidence):
        rows = []
        for source_id, start, end in evidence:
            text = self.source_text(source_id)
            if text is None or not (0 <= start < end <= len(text)):
                raise ValueError("evidence span ({}, {}) is outside source {}".format(start, end, source_id))
            rows.append((source_id, start, end, text[start:end]))
        return rows

    def assert_fact(self, fact_id, *, subject, predicate, object, valid_from, valid_to, recorded_at, evidence,
                    origin="extracted", supersedes=None):
        rows = self._evidence_rows(evidence)
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.conn.execute("INSERT INTO facts VALUES (?,?,?,?,?,?,?,NULL,?,?)",
                              (fact_id, subject, predicate, object, valid_from, valid_to, recorded_at, origin, supersedes))
            self.conn.executemany("INSERT INTO fact_evidence VALUES (?,?,?,?,?)", [(fact_id,) + r for r in rows])
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def supersede(self, old_id, new_id, *, new_object, at, recorded_at, evidence):
        old = self.conn.execute("SELECT * FROM facts WHERE fact_id=?", (old_id,)).fetchone()
        self.conn.execute("UPDATE facts SET valid_to=? WHERE fact_id=? AND valid_to IS NULL", (at, old_id))
        self.assert_fact(new_id, subject=old["subject"], predicate=old["predicate"], object=new_object, valid_from=at,
                         valid_to=None, recorded_at=recorded_at, evidence=evidence, supersedes=old_id)

    def retract(self, fact_id, at):
        self.conn.execute("UPDATE facts SET retracted_at=? WHERE fact_id=?", (at, fact_id))

    def facts_as_of(self, subject, as_of, recorded_as_of=FAR_FUTURE):
        rows = self.conn.execute(
            "SELECT * FROM facts WHERE subject=? AND valid_from<=? AND (valid_to IS NULL OR ?<valid_to) "
            "AND recorded_at<=? AND (retracted_at IS NULL OR retracted_at>?) ORDER BY fact_id",
            (subject, as_of, as_of, recorded_as_of, recorded_as_of)).fetchall()
        return [dict(r) for r in rows]

    def evidence_for(self, fact_id):
        rows = self.conn.execute("SELECT source_id, span_start, span_end, quote FROM fact_evidence WHERE fact_id=? ORDER BY source_id",
                                 (fact_id,)).fetchall()
        return [dict(r) for r in rows]

    def delete_source(self, source_id, dry_run=False):
        touched = [r["fact_id"] for r in self.conn.execute(
            "SELECT DISTINCT fact_id FROM fact_evidence WHERE source_id=?", (source_id,))]
        removed, kept = [], []
        for fid in touched:
            others = self.conn.execute("SELECT count(*) FROM fact_evidence WHERE fact_id=? AND source_id<>?", (fid, source_id)).fetchone()[0]
            (kept if others else removed).append(fid)
        evidence_rows = self.conn.execute("SELECT count(*) FROM fact_evidence WHERE source_id=?", (source_id,)).fetchone()[0]
        report = {"facts_removed": len(removed), "facts_kept_shared": len(kept), "evidence_removed": evidence_rows,
                  "history_rows_remaining": None if dry_run else 0}
        if dry_run:
            return report
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            for fid in removed:
                self.conn.execute("DELETE FROM facts WHERE fact_id=?", (fid,))
            self.conn.execute("DELETE FROM sources WHERE source_id=?", (source_id,))  # cascades evidence rows
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        report["history_rows_remaining"] = self.conn.execute(
            "SELECT count(*) FROM fact_evidence WHERE source_id=?", (source_id,)).fetchone()[0]
        return report

    def export(self):
        facts = []
        for f in self.conn.execute("SELECT * FROM facts ORDER BY fact_id"):
            d = dict(f)
            d["evidence"] = self.evidence_for(f["fact_id"])
            facts.append(d)
        return {"source_ids": [r["source_id"] for r in self.conn.execute("SELECT source_id FROM sources ORDER BY source_id")], "facts": facts}

    def integrity(self):
        errors = [r[0] for r in self.conn.execute("PRAGMA integrity_check")]
        errors = [] if errors == ["ok"] else errors
        errors += ["foreign key violation: {}".format(tuple(r)) for r in self.conn.execute("PRAGMA foreign_key_check")]
        return errors


class CortexDbStore:
    """Plan for cortexdb v2.157.1 / SHA 50c1eeb1f2ddd35ff8f72e7ac35289fdd38a32ba (OSS_EVALUATION 3.2).

    Every call raises SiteTodo: nothing about the call surface was confirmed. Evidence that exists:
      - bitemporal facts valid_from/valid_to/recorded_at/retracted_at and as-of: docs/GUIDE.md#L543-L559,
        cmd/cortexdb-mcp-stdio/facts_asof.go#L14-L40 (an MCP stdio executable exists in the release)
      - per-fact provenance: pkg/cortexdb/fact_provenance.go#L61
      - document delete with dry_run: pkg/cortexdb/knowledge_api.go#L440, graph_cleanup.go#L30, GUIDE.md#L453
      - history rows kept after delete (reason document_deleted): GUIDE.md#L543-L547 (UNCONFIRMED effect)
    Candidate route (UNCONFIRMED): run the release MCP stdio executable and speak JSON-RPC over stdin/stdout
    with the Python standard library (see r02 helpers/mcp_stub.py for the framing). Missing evidence:
    MCP tool names and argument shapes for add-fact / delete-document / as-of, whether the MCP surface
    exposes provenance quotes, whether evidence is a character span or a whole chunk.
    """

    MISSING = ("MCP tool names and arguments for add-fact, delete-document and as-of queries; whether provenance "
               "is a character span or a chunk; whether history rows survive document deletion")

    def _todo(self, what):
        raise SiteTodo("R03-S4", "cortexdb adapter call '{}' is not confirmed".format(what), self.MISSING)

    def open(self, path):
        self._todo("open")

    def close(self):
        self._todo("close")

    def add_source(self, source_id, text):
        self._todo("add_source")

    def assert_fact(self, *args, **kwargs):
        self._todo("assert_fact")

    def facts_as_of(self, *args, **kwargs):
        self._todo("facts_as_of")

    def delete_source(self, *args, **kwargs):
        self._todo("delete_source")

    def export(self):
        self._todo("export")


def run_store_checks(factory, path):
    """Standard series run against any TemporalStore. Returns [{name, ok, detail}]."""
    store = factory()
    store.open(path)
    out = []

    def rec(name, ok, detail=""):
        out.append({"name": name, "ok": bool(ok), "detail": detail})

    try:
        text1 = "Nolan Reef maintains the lamp. Marta Quill is harbor master."
        store.add_source("s1", text1)
        store.add_source("s2", "Nolan Reef maintains the lamp every spring.")
        store.assert_fact("shared", subject="lamp", predicate="maintainer", object="Nolan Reef", valid_from="2020-01-01",
                          valid_to="2022-01-01", recorded_at="2020-01-02", evidence=[("s1", 0, 10), ("s2", 0, 10)])
        store.assert_fact("only_s1", subject="harbor", predicate="master", object="Marta Quill", valid_from="2020-01-01",
                          valid_to=None, recorded_at="2020-01-02", evidence=[("s1", 40, 51)])
        inside = store.facts_as_of("lamp", "2021-06-01")
        outside = store.facts_as_of("lamp", "2022-01-01")
        rec("as_of", len(inside) == 1 and not outside, "inside={} outside={}".format(len(inside), len(outside)))
        ev = store.evidence_for("only_s1")[0]
        rec("span_evidence", ev["quote"] == text1[40:51], "quote={!r}".format(ev["quote"]))
        report = store.delete_source("s1")
        rec("delete_lineage", report["facts_removed"] == 1 and report["facts_kept_shared"] == 1, str(report))
        rec("history_rows_after_delete", report["history_rows_remaining"] == 0, "history_rows_remaining={}".format(report["history_rows_remaining"]))
        exp = store.export()
        rec("export", "s1" not in exp["source_ids"] and all(f["evidence"] for f in exp["facts"]),
            "sources={} facts={}".format(exp["source_ids"], len(exp["facts"])))
        errors = store.integrity()
        rec("integrity", not errors, "; ".join(errors))
    finally:
        store.close()
    return out
