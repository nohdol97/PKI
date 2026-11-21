"""R03 durability tests (spec R03-K5): single writer, concurrent reads, crash recovery on SQLite targets."""
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

durability = _paths.load_kit_module("r03-engine-comparison", "durability.py", "durability")


class DurabilityTests(unittest.TestCase):
    def test_single_writer_second_writer_is_refused_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            res = durability.single_writer_check(durability.SqliteTarget(), d)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["second_writer_blocked"])
        self.assertEqual(res["integrity_errors"], [])

    def test_concurrent_reads_during_writes_have_no_errors(self):
        with tempfile.TemporaryDirectory() as d:
            res = durability.concurrent_read_check(durability.SqliteTarget(), d, readers=3, writes=60)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["reader_errors"], 0)
        self.assertGreater(res["reads"], 0)

    def test_crash_mid_write_leaves_consistent_store(self):
        with tempfile.TemporaryDirectory() as d:
            res = durability.crash_check("sqlite", d, kill_after_commits=3, rows_per_tx=20)
        self.assertTrue(res["ok"], res)
        self.assertTrue(res["killed"])
        self.assertGreaterEqual(res["rows_after"], res["committed_rows"])
        self.assertEqual(res["rows_after"] % 20, 0)
        self.assertEqual(res["integrity_errors"], [])

    def test_engine_target_reports_not_implemented_integrity(self):
        class NoIntegrity:
            name = "x"

            def export(self):
                return None
        t = durability.EngineTarget(NoIntegrity())
        with self.assertRaises(NotImplementedError):
            t.integrity()


if __name__ == "__main__":
    unittest.main()
