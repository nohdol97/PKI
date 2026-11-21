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

    def test_scripts_write_only_the_raw_result_and_never_pass_format_strings_to_add_check(self):
        common = read(os.path.join(PS_DIR, "common.ps1"))
        self.assertIn("result-raw.json", common)
        self.assertNotIn("'result.json'", common)
        for path in SCRIPTS:
            for line in read(path).splitlines():
                if line.strip().startswith("Add-Check"):
                    self.assertNotRegex(line, r"\s-f\s", "{}: Add-Check must take structured facts, not formatted text".format(path))

    def test_kill_by_name_is_scoped_to_the_install_folder(self):
        common = read(os.path.join(PS_DIR, "common.ps1"))
        self.assertIn("StartsWith($InstallDir", common)
        self.assertIn("wildcards are not allowed", common)
        for path in SCRIPTS:
            text = read(path)
            self.assertNotIn("Get-Process -Name $", text.replace("common.ps1", ""))
            for line in text.splitlines():
                if "Stop-ProductProcesses " in line and "function" not in line:
                    self.assertIn("$installDir", line, "{}: {}".format(path, line))

    def test_installers_support_whatif_and_urls_are_loopback_checked(self):
        for name in ("02-install-silent.ps1", "06-uninstall-leftovers.ps1"):
            text = read(os.path.join(PS_DIR, name))
            self.assertIn("SupportsShouldProcess", text)
            self.assertIn("ShouldProcess(", text)
        self.assertIn("Assert-Loopback", read(os.path.join(PS_DIR, "common.ps1")))
        self.assertIn("Assert-Loopback", read(os.path.join(PS_DIR, "08-roundtrip.ps1")))

    def test_preflight_ignores_windows_store_alias_stubs(self):
        self.assertIn("WindowsApps", read(os.path.join(PS_DIR, "01-preflight.ps1")))

    def test_uninstall_diffs_every_promised_surface(self):
        text = read(os.path.join(PS_DIR, "06-uninstall-leftovers.ps1"))
        for needle in ("uninstall", "startmenu", "tasks", "services", "run", "processes", "Get-ProductProcesses"):
            self.assertIn(needle, text)

    def test_every_check_id_fact_key_and_metric_name_is_in_the_fixed_registries(self):
        from common import results
        for path in SCRIPTS:
            text = read(path)
            for cid in re.findall(r"Add-Check \$result '([^']+)'", text):
                self.assertTrue(results.check_id_allowed(cid), "{}: id {}".format(path, cid))
            for name in re.findall(r"Add-Metric \$result '([^']+)'", text):
                self.assertIn(name, results.METRIC_NAMES, "{}: metric {}".format(path, name))
            for m in re.finditer(r"Add-Check \$result[^@]{0,200}@\{(.*?)\}", text, flags=re.S):
                for key in re.findall(r"\b([a-z][a-z0-9_]*)\s*=", m.group(1)):
                    self.assertIn(key, results.FACT_KEYS, "{}: fact key {}".format(path, key))

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
