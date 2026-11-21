"""Static checks of the PowerShell scripts (spec R04-K2). NOT a syntax check: PowerShell was not available
when this kit was written, so the scripts are unexecuted and unparsed. These tests only guard conventions."""
import glob
import os
import re
import unittest

try:
    from . import _paths
except ImportError:
    import _paths

PS_DIR = os.path.join(_paths.VERIF_DIR, "r04-windows-installer", "scripts")
SCRIPTS = sorted(glob.glob(os.path.join(PS_DIR, "*.ps1")))


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


class PowerShellStaticTests(unittest.TestCase):
    def test_scripts_exist(self):
        names = {os.path.basename(p) for p in SCRIPTS}
        for expected in ("common.ps1", "01-preflight.ps1", "02-install-silent.ps1", "03-startup-time.ps1", "04-idle-sampling.ps1",
                         "05-single-instance-stop.ps1", "06-uninstall-leftovers.ps1", "07-signature-info.ps1", "08-roundtrip.ps1"):
            self.assertIn(expected, names)

    def test_every_script_states_it_was_never_executed(self):
        for path in SCRIPTS:
            head = read(path)[:900]
            self.assertIn("NEVER EXECUTED", head, path)

    def test_numbered_scripts_load_the_shared_functions(self):
        for path in SCRIPTS:
            if os.path.basename(path) == "common.ps1":
                continue
            self.assertRegex(read(path), r"\.\s+\(Join-Path \$PSScriptRoot 'common\.ps1'\)", path)

    def test_no_dynamic_code_execution(self):
        for path in SCRIPTS:
            text = read(path)
            for bad in ("Invoke-Expression", "iex ", "Add-Type", "DownloadString", "Invoke-WebRequest -Uri http", "Set-ExecutionPolicy"):
                self.assertNotIn(bad, text, "{} uses {}".format(path, bad))

    def test_braces_and_parentheses_are_balanced(self):
        for path in SCRIPTS:
            body = re.sub(r"<#.*?#>", "", read(path), flags=re.S)
            body = re.sub(r"'[^'\n]*'", "''", body)
            body = re.sub(r'"[^"\n]*"', '""', body)
            body = re.sub(r"#.*", "", body)
            for open_c, close_c in ("{}", "()", "[]"):
                self.assertEqual(body.count(open_c), body.count(close_c), "{} unbalanced {}{}".format(path, open_c, close_c))

    def test_scripts_take_config_and_outdir(self):
        for path in SCRIPTS:
            name = os.path.basename(path)
            if name == "common.ps1":
                continue
            self.assertIn("$ConfigPath", read(path), name)
            self.assertIn("$OutDir", read(path), name)

    def test_no_real_hostnames_paths_or_addresses_baked_in(self):
        for path in SCRIPTS + glob.glob(os.path.join(PS_DIR, "..", "*.json")):
            text = read(path)
            self.assertNotRegex(text, r"[A-Za-z]:\\Users\\[A-Za-z]", path)
            self.assertNotRegex(text, r"\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d+\.\d+", path)


if __name__ == "__main__":
    unittest.main()
