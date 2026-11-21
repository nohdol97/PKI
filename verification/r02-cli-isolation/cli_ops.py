"""R02 operations: detect, capabilities, positive, cancel, not-installed, not-logged-in.

STATUS: written only; NEVER executed against a real claude or codex CLI. `detect` and `capabilities`
call only `--version`, `--help` and the documented status command; no credential file is read. The
only calls that reach a model are `positive`, `negative`, `cancel` (real CLI step) and
`not-logged-in` (a benign structured call that is expected to fail without a login).
"""
import os
import re
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

from common import fingerprint, runner  # noqa: E402

import negative  # noqa: E402

CLI_NAMES = ("claude", "codex")

PROBES = {  # help-derived capability rows (spec R02-R2): name -> {cli: regex over help text}
    "non_interactive_mode": {"claude": r"(?<![\w-])--print\b|(?<![\w-])-p\b", "codex": r"(?m)^\s+exec\b"},
    "json_schema_output": {"claude": r"--json-schema", "codex": r"--output-schema"},
    "json_output_format": {"claude": r"--output-format", "codex": r"(?<![\w-])--json\b"},
    "wall_clock_timeout_flag": {"claude": r"--timeout", "codex": r"--timeout"},
    "session_persistence_off": {"claude": r"--no-session-persistence", "codex": r"--ephemeral"},
    "auth_status_command": {"claude": r"(?m)^\s+auth\b", "codex": r"(?m)^\s+login\b"},
}
HELP_COMMANDS = {"claude": [["--help"]], "codex": [["--help"], ["exec", "--help"]]}
AUTH_ARGV = {"codex": ["login", "status"]}  # documented (research section 4.2). Claude: decided from help.
CONFIG_HOME_ENV = {"codex": "CODEX_HOME", "claude": "CLAUDE_CONFIG_DIR"}  # CLAUDE_CONFIG_DIR: not in the research doc, confirm on site

_NOT_LOGGED = re.compile(r"(?i)not\s+(?:logged|signed)\s*in|logged\s+out|not\s+authenticated|no\s+credentials|unauthenticated|not\s+signed")
_LOGGED = re.compile(r"(?i)logged\s+in|authenticated|signed\s+in")


def classify_auth(text, exit_code):
    if _NOT_LOGGED.search(text or ""):
        return "not_logged_in"
    if _LOGGED.search(text or ""):
        return "logged_in"
    return "unknown"


def find_binary(name, override=None, path_env=None):
    if override:
        return override if os.path.exists(override) else None
    return shutil.which(name, path=path_env if path_env is not None else None)


def flag_in_help(flag, help_text):
    return re.search(r"(?<![\w-])" + re.escape(flag) + r"(?![\w-])", help_text) is not None


def flags_of_profile(profile):
    return [t for t in profile["argv"][1:] if t.startswith("-") and len(t) > 1]


def config_keys_of_profile(profile):
    argv = profile["argv"]
    return [argv[i + 1] for i, t in enumerate(argv[:-1]) if t == "-c"]


def profile_flag_row(profile, help_text):
    flags = sorted(set(flags_of_profile(profile)))
    return {"present": [f for f in flags if flag_in_help(f, help_text)],
            "missing": [f for f in flags if not flag_in_help(f, help_text)],
            "not_checkable_from_help": config_keys_of_profile(profile)}


def read_help(binary, name):
    texts = []
    for extra in HELP_COMMANDS[name]:
        res = runner.run_process([binary] + extra, timeout_s=30)
        texts.append(res.stdout + "\n" + res.stderr)
    return "\n".join(texts)


def detect_cli(name, override=None, path_env=None):
    binary = find_binary(name, override, path_env)
    if not binary:
        return {"cli": name, "installed": False}
    info = {"cli": name, "installed": True, "binary": binary,
            "location_kind": fingerprint.classify_binary_location(binary),
            "shim_kind": "cmd-shim" if binary.lower().endswith((".cmd", ".bat")) else "native-or-other",
            "version": fingerprint.cli_version(binary)}
    help_text = read_help(binary, name)
    info["probes"] = {k: bool(re.search(v[name], help_text)) for k, v in PROBES.items()}
    argv = AUTH_ARGV.get(name)
    if name == "claude" and info["probes"]["auth_status_command"]:
        argv = ["auth", "status"]  # UNVERIFIED subcommand (not in the research doc): used only if `claude --help` lists `auth`
    if argv is None:
        info["auth"] = {"state": "unknown", "how": "no status command found in --help"}
    else:
        res = runner.run_process([binary] + argv, timeout_s=30)
        info["auth"] = {"state": classify_auth(res.stdout + res.stderr, res.returncode), "exit_code": res.returncode,
                        "how": "{} {}".format(name, " ".join(argv))}
    return info


def not_installed_probe(name):
    """Reproduce 'CLI missing': an empty PATH must yield not_found and no crash."""
    res = runner.run_process([name, "--version"], env={"PATH": ""}, timeout_s=10)
    return {"reproduced": res.error == "not_found" and find_binary(name, path_env="") is None, "error": res.error}


def not_logged_in_probe(name, binary):
    """Run the status command (or a benign call) with an EMPTY temporary config home. The user's real login is untouched."""
    with tempfile.TemporaryDirectory() as empty_home:
        env_name = CONFIG_HOME_ENV[name]
        argv = AUTH_ARGV.get(name, ["--version"])
        res = runner.run_process([binary] + argv, extra_env={env_name: empty_home}, timeout_s=30)
        state = classify_auth(res.stdout + res.stderr, res.returncode)
    return {"state": state, "exit_code": res.returncode, "env_var_used": env_name,
            "reproduced": state == "not_logged_in"}


_TREE_PARENT = (
    "import subprocess, sys, time\n"
    "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
    "open(sys.argv[1], 'w').write(str(c.pid))\n"
    "time.sleep(60)\n")


def tree_kill_selftest(timeout_s=2.0):
    """Harmless parent + grandchild: does the harness's own kill reach the whole tree?"""
    with tempfile.TemporaryDirectory() as d:
        pidfile = os.path.join(d, "g.pid")
        res = runner.run_process([sys.executable, "-c", _TREE_PARENT, pidfile], cwd=d, timeout_s=timeout_s)
        grandchild = None
        if os.path.exists(pidfile):
            with open(pidfile) as fh:
                grandchild = int(fh.read() or 0) or None
        deadline = time.time() + 5
        while time.time() < deadline and any(p and runner.pid_alive(p) for p in (res.pid, grandchild)):
            time.sleep(0.1)
        survivors = [p for p in (res.pid, grandchild) if p and runner.pid_alive(p)]
    return {"passed": res.timed_out and not survivors and grandchild is not None, "timed_out": res.timed_out,
            "grandchild_found": grandchild is not None, "survivors": len(survivors)}


def real_cancel(profile, binary, model, cancel_timeout_s, repeat):
    """Cut a real CLI run short and look for survivors. Needs a working login."""
    outcomes = []
    for _ in range(repeat):
        workdir = tempfile.mkdtemp(prefix="r02cancel-")
        try:
            with open(os.path.join(negative.DOC_DIR, "benign.txt"), encoding="utf-8") as fh:
                benign = fh.read()
            facts = negative.execute_profile(
                profile, prompt_doc=benign, workdir=workdir, model=model, schema=negative.load_schema(),
                timeout_s=cancel_timeout_s, binary=binary)
            res = facts["run"]
            pids = [p for p in [res.pid] + list(res.descendants_at_kill) if p]
            deadline = time.time() + 8
            while time.time() < deadline and any(runner.pid_alive(p) for p in pids):
                time.sleep(0.2)
            survivors = [p for p in pids if runner.pid_alive(p)]
        finally:
            removable = True
            try:
                shutil.rmtree(workdir)
            except OSError:
                removable = False
        outcomes.append({"timed_out": res.timed_out, "tracked": len(pids), "survivors": len(survivors), "cwd_removable": removable})
    return outcomes
