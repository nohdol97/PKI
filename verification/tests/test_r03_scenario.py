"""R03 scenario runner tests (spec R03-K1) against fake in-memory adapters. Never a real engine."""
import json
import os
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

scenario = _paths.load_kit_module("r03-engine-comparison", "scenario.py", "scenario")
llm_gateway = _paths.load_kit_module("r03-engine-comparison", "llm_gateway.py", "llm_gateway")
try:
    from . import fake_engine
except ImportError:
    import fake_engine

FIX = os.path.join(_paths.VERIF_DIR, "fixtures", "records")


def load_fixtures():
    with open(os.path.join(FIX, "sources.jsonl"), encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh if line.strip()]
    with open(os.path.join(FIX, "probes.json"), encoding="utf-8") as fh:
        probes = json.load(fh)
    return records, probes


def run(adapter_cls):
    records, probes = load_fixtures()
    gateway = llm_gateway.LLMGateway(lambda p, s: {"text": "x"})
    with tempfile.TemporaryDirectory() as d:
        adapter = adapter_cls()
        return scenario.run_scenario(adapter, records, probes, gateway, d), gateway


class ScenarioTests(unittest.TestCase):
    def test_good_adapter_passes_every_step(self):
        result, gateway = run(fake_engine.FakeAdapter)
        names = [s.name for s in result.steps]
        self.assertEqual(names, ["import", "extract", "relate", "incremental_edit", "delete", "restart"])
        failed = [(s.name, [c for c in s.checks if not c.ok]) for s in result.steps if not s.ok]
        self.assertEqual(failed, [])
        self.assertTrue(result.all_ok)

    def test_metrics_recorded_per_step(self):
        result, gateway = run(fake_engine.FakeAdapter)
        step = result.steps[0]
        self.assertEqual(step.llm_calls, 6)  # one fake call per fixture record
        self.assertGreaterEqual(step.wall_s, 0)
        self.assertGreater(step.peak_rss_bytes, 0)
        self.assertGreaterEqual(step.store_bytes, 0)
        edit = next(s for s in result.steps if s.name == "incremental_edit")
        self.assertEqual(edit.llm_calls, 1)

    def test_leaky_delete_fails_the_delete_step(self):
        result, _ = run(fake_engine.LeakyDeleteAdapter)
        delete = next(s for s in result.steps if s.name == "delete")
        self.assertFalse(delete.ok)
        self.assertFalse(result.all_ok)
        self.assertTrue(any("forbidden" in c.name for c in delete.checks if not c.ok))

    def test_restart_amnesia_fails_the_restart_step(self):
        result, _ = run(fake_engine.AmnesiaAdapter)
        restart = next(s for s in result.steps if s.name == "restart")
        self.assertFalse(restart.ok)

    def test_partial_restart_loss_is_caught_by_result_comparison(self):
        result, _ = run(fake_engine.PartialAmnesiaAdapter)
        restart = next(s for s in result.steps if s.name == "restart")
        self.assertFalse(restart.ok)
        self.assertTrue(any("same results after restart" in c.name for c in restart.checks if c.ok is False))

    def test_stale_edit_fails_the_edit_step(self):
        result, _ = run(fake_engine.StaleEditAdapter)
        edit = next(s for s in result.steps if s.name == "incremental_edit")
        self.assertFalse(edit.ok)
        self.assertTrue(any("stale" in c.name for c in edit.checks if not c.ok))

    def test_not_implemented_adapter_is_reported_without_crash(self):
        result, _ = run(fake_engine.StubAdapter)
        self.assertEqual(result.not_implemented[0][0], "setup")
        self.assertIn("unconfirmed", result.not_implemented[0][1])
        self.assertFalse(result.all_ok)

    def test_a_step_without_any_check_is_not_a_pass(self):
        self.assertFalse(scenario.StepResult("import").ok)

    def test_dir_size(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "a"), "wb") as fh:
                fh.write(b"x" * 1000)
            self.assertEqual(scenario.dir_size(d), (1000, 1))


if __name__ == "__main__":
    unittest.main()
