"""R03-C4 durability procedures: crash, concurrent read, single writer.

STATUS: written only. The SQLite target has been exercised by unit tests on a temp directory (POSIX).
The engine targets are stubs: they need the adapters (R03-S1..S3). Never run on Windows.

Target interface: open(workdir), write(i), count(), new_reader() -> callable, writer_probe(workdir),
integrity(), close().

Crash child entry (also this file): `python durability.py _child-writer sqlite <workdir> <rows_per_tx>`
commits transactions of rows_per_tx rows forever and prints `committed <k>` after each commit.
"""
import os
import sqlite3
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

DB_NAME = "durability.sqlite"


def _connect(path, timeout_ms=2000):
    conn = sqlite3.connect(path, isolation_level=None, timeout=timeout_ms / 1000.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout={}".format(int(timeout_ms)))
    conn.execute("CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)")
    return conn


class SqliteTarget:
    name = "sqlite"

    def open(self, workdir):
        self.path = os.path.join(workdir, DB_NAME)
        self.conn = _connect(self.path)
        self._readers = []

    def write(self, i):
        self.conn.execute("BEGIN IMMEDIATE")
        self.conn.execute("INSERT INTO rows(id, payload) VALUES (?, ?)", (i, "row-{}".format(i)))
        self.conn.execute("COMMIT")

    def count(self):
        return self.conn.execute("SELECT count(*) FROM rows").fetchone()[0]

    def new_reader(self):
        conn = sqlite3.connect(self.path, isolation_level=None, timeout=2.0, check_same_thread=False)
        self._readers.append(conn)
        return lambda: conn.execute("SELECT count(*) FROM rows").fetchone()[0]

    def writer_probe(self, workdir):
        """Hold the write lock on one connection; a second writer must be refused cleanly, not corrupt."""
        holder = _connect(self.path)
        other = _connect(self.path, timeout_ms=200)
        holder.execute("BEGIN IMMEDIATE")
        blocked, detail = False, ""
        try:
            other.execute("BEGIN IMMEDIATE")
            other.execute("ROLLBACK")
        except sqlite3.OperationalError as exc:
            blocked, detail = True, str(exc)
        holder.execute("COMMIT")
        other.execute("BEGIN IMMEDIATE")
        other.execute("INSERT INTO rows(id, payload) VALUES (-1, 'after-release')")
        other.execute("COMMIT")
        holder.close()
        other.close()
        return {"second_writer_blocked": blocked, "detail": detail}

    def integrity(self):
        errors = [r[0] for r in self.conn.execute("PRAGMA integrity_check")]
        return [] if errors == ["ok"] else errors

    def close(self):
        for conn in self._readers:
            conn.close()
        self.conn.close()


class EngineTarget:
    """Adapter-backed target. integrity/writer_probe need engine-specific knowledge (R03-S1..S3)."""

    def __init__(self, adapter):
        self.adapter = adapter
        self.name = getattr(adapter, "name", "engine")

    def open(self, workdir):
        raise NotImplementedError("R03-S1..S3: engine targets need the adapter setup")

    def write(self, i):
        self.adapter.ingest({"id": "d{}".format(i), "title": "t", "lang": "en", "text": "synthetic durability record {}".format(i)})

    def count(self):
        return len(self.adapter.export().source_ids)

    def new_reader(self):
        return lambda: len(self.adapter.query("synthetic durability record", k=3))

    def writer_probe(self, workdir):
        raise NotImplementedError("R03-S1..S3: single-writer behaviour of an engine must be probed through its own API")

    def integrity(self):
        fn = getattr(self.adapter, "integrity_check", None)
        if fn is None:
            raise NotImplementedError("R03-S1..S3: adapter has no integrity_check; the engine's own recovery tool is unconfirmed")
        return fn()

    def close(self):
        self.adapter.close()


def single_writer_check(target, workdir):
    target.open(workdir)
    try:
        probe = target.writer_probe(workdir)
        errors = target.integrity()
    finally:
        target.close()
    return {"ok": probe["second_writer_blocked"] and not errors, "second_writer_blocked": probe["second_writer_blocked"],
            "integrity_errors": errors, "detail": probe.get("detail", "")}


def concurrent_read_check(target, workdir, readers=3, writes=100):
    target.open(workdir)
    stats = {"reads": 0, "errors": 0, "max_latency_s": 0.0}
    lock = threading.Lock()
    done = threading.Event()

    def reader_loop():
        read = target.new_reader()
        while not done.is_set():
            started = time.time()
            try:
                read()
                with lock:
                    stats["reads"] += 1
                    stats["max_latency_s"] = max(stats["max_latency_s"], time.time() - started)
            except Exception:
                with lock:
                    stats["errors"] += 1
            time.sleep(0.001)

    threads = [threading.Thread(target=reader_loop, daemon=True) for _ in range(readers)]
    for t in threads:
        t.start()
    try:
        for i in range(writes):
            target.write(i)
            time.sleep(0.001)
    finally:
        done.set()
        for t in threads:
            t.join(timeout=10)
    final = target.count()
    target.close()
    return {"ok": stats["errors"] == 0 and stats["reads"] > 0 and final == writes, "reader_errors": stats["errors"],
            "reads": stats["reads"], "max_read_latency_s": round(stats["max_latency_s"], 4), "rows_written": final}


def crash_check(target_name, workdir, kill_after_commits=5, rows_per_tx=50, timeout_s=120):
    """Kill the writer's whole process tree mid-transaction, reopen, verify integrity and no partial transaction."""
    if target_name != "sqlite":
        raise NotImplementedError("R03-S1..S3: engine crash checks need the adapter child entry point")
    from common import runner
    argv = [sys.executable, os.path.abspath(__file__), "_child-writer", target_name, workdir, str(rows_per_tx)]
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=runner.build_env(),
                            **runner.popen_group_kwargs())
    committed, killed = 0, False
    deadline = time.time() + timeout_s
    try:
        for line in proc.stdout:
            if line.startswith("committed "):
                committed = int(line.split()[1])
            if committed >= kill_after_commits:
                runner.kill_tree(proc)
                killed = True
                break
            if time.time() > deadline:
                runner.kill_tree(proc)
                break
    finally:
        if proc.poll() is None:
            runner.kill_tree(proc)
        proc.wait(timeout=30)
        proc.stdout.close()
    target = SqliteTarget()
    target.open(workdir)
    try:
        rows_after, errors = target.count(), target.integrity()
    finally:
        target.close()
    ok = killed and not errors and rows_after >= committed * rows_per_tx and rows_after % rows_per_tx == 0
    return {"ok": ok, "killed": killed, "committed_rows": committed * rows_per_tx, "rows_after": rows_after,
            "partial_transaction_rows": rows_after % rows_per_tx, "integrity_errors": errors}


def _child_writer(workdir, rows_per_tx):
    conn = _connect(os.path.join(workdir, DB_NAME))
    next_id, commits = 0, 0
    while True:
        conn.execute("BEGIN IMMEDIATE")
        for _ in range(rows_per_tx):
            conn.execute("INSERT INTO rows(id, payload) VALUES (?, ?)", (next_id, "row-{}".format(next_id)))
            next_id += 1
            time.sleep(0.003)
        conn.execute("COMMIT")
        commits += 1
        print("committed {}".format(commits), flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "_child-writer":
        os.makedirs(sys.argv[3], exist_ok=True)
        _child_writer(sys.argv[3], int(sys.argv[4]))
