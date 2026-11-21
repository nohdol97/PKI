"""Spec K6/K7/K3: the 배포처 후속 items in each spec match verification/SITE_FOLLOWUPS.md one-to-one, and every
follow-up PATH prints `미구현, 배포처 후속` and exits non-zero. These are countable, not existence checks."""
import os
import re
import subprocess
import sys
import tempfile
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

DOCS = os.path.join(_paths.REPO_DIR, "docs")
SPECS = {"R02": "2026-11-21-R02-cli-isolation.md", "R03": "2026-11-21-R03-engine-comparison.md", "R04": "2026-11-21-R04-windows-installer.md"}
NOTICE = "미구현, 배포처 후속"


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def spec_items(prefix):
    text = read(os.path.join(DOCS, "specs", SPECS[prefix]))
    section = text.split("## 비목표", 1)[1].split("## 요구사항", 1)[0]
    return re.findall(r"^- ({}-S\d+):".format(prefix), section, flags=re.M)


def checklist_items():
    text = read(os.path.join(_paths.VERIF_DIR, "SITE_FOLLOWUPS.md"))
    assert "## 배포처 설정 체크리스트" in text
    section = text.split("## 배포처 설정 체크리스트", 1)[1]
    return re.findall(r"^- \[ \] (R0\d-S\d+):", section, flags=re.M)


def run(script, *args):
    return subprocess.run([sys.executable, os.path.join(_paths.VERIF_DIR, script)] + list(args), capture_output=True, text=True, timeout=120)


class CountTests(unittest.TestCase):
    def test_item_counts_match_per_spec(self):
        listed = checklist_items()
        for prefix, expected in (("R02", 2), ("R03", 5), ("R04", 3)):
            items = spec_items(prefix)
            self.assertEqual(len(items), expected, prefix)
            self.assertEqual(sorted(i for i in listed if i.startswith(prefix)), sorted(items), prefix)
        self.assertEqual(len(listed), 10)


class NoticePathTests(unittest.TestCase):
    def check(self, res, item):
        self.assertNotEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.returncode, 3, res.stdout + res.stderr)
        self.assertIn(NOTICE, res.stdout)
        self.assertIn(item, res.stdout)

    def test_r02_paths(self):
        self.check(run("r02-cli-isolation/run.py", "terms"), "R02-S1")
        self.check(run("r02-cli-isolation/run.py", "os-trace"), "R02-S2")

    def test_r03_paths(self):
        with tempfile.TemporaryDirectory() as d:
            for n, engine in ((1, "lightrag"), (2, "cognee"), (3, "sage-wiki")):
                res = run("r03-engine-comparison/run.py", "scenario", "--engine", engine, "--llm-mode", "none",
                          "--workdir", os.path.join(d, engine), "--out", os.path.join(d, "o" + engine))
                self.check(res, "R03-S{}".format(n))
            self.check(run("r03-engine-comparison/run.py", "storage-compare", "--store", "cortexdb", "--workdir", d, "--out", d), "R03-S4")
            self.check(run("r03-engine-comparison/run.py", "embed", "--model", "bge-m3", "--backend", "fastembed",
                           "--dataset", "fixtures", "--out", d), "R03-S5")

    def test_r04_paths(self):
        self.check(run("r04-windows-installer/run.py", "build-skeleton"), "R04-S1")
        self.check(run("r04-windows-installer/run.py", "second-installer"), "R04-S2")


if __name__ == "__main__":
    unittest.main()
