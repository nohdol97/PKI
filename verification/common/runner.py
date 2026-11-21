"""Process runner: argv arrays only, shell=False, wall-clock timeout, whole-tree kill,
minimal scrubbed environment.

STATUS: written only; never executed against a real CLI/engine. The POSIX branch is exercised by
unit tests with harmless python children. The Windows branch (Job Object via ctypes, `taskkill /T /F`)
has never been executed on Windows.

Windows limitation (honest): a process that spawns grandchildren before it is assigned to the job
object can leak them out of the job; `taskkill /T /F` is run afterwards as a second net and relies
on the parent link, which Windows does not keep after the parent exits.
"""
import ctypes
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Optional

ENV_ALLOWLIST = (
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
    "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES", "PROCESSOR_ARCHITECTURE",
    "LANG", "LC_ALL", "LC_CTYPE", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
)
FORBIDDEN_ENV_PREFIXES = (
    "ANTHROPIC_", "OPENAI_", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "AWS_", "AZURE_", "GOOGLE_",
    "GITHUB_", "GH_", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN",
)
PASSTHROUGH_ALLOWED = (
    "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
)
_passthrough = []
_CMD_META = set('"%^&|<>!\r\n')


@dataclass
class RunResult:
    returncode: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    duration_s: float = 0.0
    pid: Optional[int] = None
    error: Optional[str] = None
    output_truncated: bool = False
    descendants_at_kill: list = field(default_factory=list)
    peak_rss_bytes: int = 0
    peak_process_count: int = 0
    cpu_seconds: float = 0.0


def set_passthrough(names):
    """Operator opt-in (--pass-env): copy these proxy / CA variables from the parent into child environments.
    Only the names in PASSTHROUGH_ALLOWED are accepted; values are never logged or recorded."""
    bad = [n for n in names if n not in PASSTHROUGH_ALLOWED]
    if bad:
        raise ValueError("not an allowed pass-through variable: " + ", ".join(bad))
    _passthrough[:] = list(names)


def passthrough_names():
    return list(_passthrough)


def build_env(extra=None):
    """Minimal environment: allowlisted names from os.environ plus `extra`.

    Names with a credential-like prefix (ANTHROPIC_*, OPENAI_*, CODEX_API_KEY, cloud keys ...) are
    never passed: not from os.environ (the allowlist excludes them) and not through `extra`.
    """
    env = {k: v for k, v in os.environ.items() if k.upper() in ENV_ALLOWLIST}
    for name in _passthrough:
        if name in os.environ:
            env[name] = os.environ[name]
    for name, value in (extra or {}).items():
        if name.upper().startswith(FORBIDDEN_ENV_PREFIXES):
            raise ValueError("refusing to pass credential-like environment variable to a child process: " + name)
        env[name] = value
    return env


def cmd_shim_problem(binary_path, args):
    """On Windows a .cmd/.bat shim is run through cmd.exe, which mangles quotes and metacharacters."""
    if not binary_path.lower().endswith((".cmd", ".bat")):
        return None
    for arg in args:
        if any(ch in _CMD_META for ch in arg):
            return "argument contains cmd.exe metacharacters but the binary is a .cmd/.bat shim; use the native .exe"
    return None


def taskkill_argv(pid):
    return ["taskkill", "/PID", str(int(pid)), "/T", "/F"]


def popen_group_kwargs():
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
    return {"start_new_session": True}


# ---- Windows job object (never executed on Windows) --------------------------------------------
def _attach_kill_on_close_job(proc):
    if sys.platform != "win32":
        return None
    try:
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32

        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                        ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

        k32.CreateJobObjectW.restype = wintypes.HANDLE
        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        k32.SetInformationJobObject(wintypes.HANDLE(job), 9, ctypes.byref(info), ctypes.sizeof(info))
        if not k32.AssignProcessToJobObject(wintypes.HANDLE(job), wintypes.HANDLE(int(proc._handle))):
            return None
        return job
    except Exception:
        return None


def _terminate_job(job):
    try:
        from ctypes import wintypes
        ctypes.windll.kernel32.TerminateJobObject(wintypes.HANDLE(job), 1)
        ctypes.windll.kernel32.CloseHandle(wintypes.HANDLE(job))
    except Exception:
        pass


# ---- liveness / descendants ---------------------------------------------------------------------
def pid_alive(pid):
    if sys.platform == "win32":
        try:
            k32 = ctypes.windll.kernel32
            k32.OpenProcess.restype = ctypes.c_void_p
            handle = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return False
            code = ctypes.c_ulong()
            k32.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code))
            k32.CloseHandle(ctypes.c_void_p(handle))
            return code.value == 259  # STILL_ACTIVE
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    probe = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
    return bool(probe.stdout.strip()) and not probe.stdout.strip().startswith("Z")


def list_descendants(pid):
    from . import procinfo
    try:
        return procinfo.descendants_of(procinfo.list_process_table(), pid)
    except Exception:
        return []


def kill_tree(proc, descendants=None):
    """Kill `proc` and everything below it. Safe to call on an already-dead process."""
    descendants = list(descendants) if descendants is not None else list_descendants(proc.pid)
    if sys.platform == "win32":
        job = getattr(proc, "_pki_job", None)
        if job:
            _terminate_job(job)
        subprocess.run(taskkill_argv(proc.pid), capture_output=True)
        for pid in descendants:
            subprocess.run(taskkill_argv(pid), capture_output=True)
    else:
        import signal
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        for pid in descendants:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    try:
        proc.kill()
    except Exception:
        pass
    return descendants


def resolve_executable(name, env):
    if os.path.dirname(name):
        return name
    return shutil.which(name, path=(env or {}).get("PATH")) or None


def _sample_tree(proc, interval_s, stats, stop):
    from . import procinfo
    while not stop.is_set():
        try:
            count, rss, cpu = procinfo.tree_totals(proc.pid)
            stats["peak_process_count"] = max(stats["peak_process_count"], count)
            stats["peak_rss_bytes"] = max(stats["peak_rss_bytes"], rss)
            stats["cpu_seconds"] = max(stats["cpu_seconds"], cpu)
        except Exception:
            pass
        stop.wait(interval_s)


def run_process(argv, *, cwd=None, env=None, extra_env=None, stdin_text=None, timeout_s=60,
                max_output_bytes=1_000_000, drain_timeout_s=5.0, sample_interval_s=None):
    """Run `argv` (a list of str) without a shell and return a RunResult.

    Never raises for a missing binary or a timeout; those are reported in the result.
    """
    if isinstance(argv, (str, bytes)):
        raise TypeError("argv must be a list of str; shell strings are not accepted")
    if not argv:
        raise ValueError("argv is empty")
    if not all(isinstance(a, str) for a in argv):
        raise TypeError("every argv element must be str")
    child_env = env if env is not None else build_env(extra_env)
    result = RunResult()
    exe = resolve_executable(argv[0], child_env)
    if exe is None:
        result.error = "not_found"
        return result
    if sys.platform == "win32":
        problem = cmd_shim_problem(exe, argv[1:])
        if problem:
            result.error = "cmd_shim_unsafe"
            result.stderr = problem
            return result
    started = time.time()
    try:
        proc = subprocess.Popen(
            [exe] + list(argv[1:]), cwd=cwd, env=child_env, shell=False,
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, **popen_group_kwargs())
    except FileNotFoundError:
        result.error = "not_found"
        return result
    except OSError as exc:
        result.error = "os_error:{}".format(getattr(exc, "errno", "?"))
        return result
    result.pid = proc.pid
    proc._pki_job = _attach_kill_on_close_job(proc)
    stats = {"peak_process_count": 0, "peak_rss_bytes": 0, "cpu_seconds": 0.0}
    stop = threading.Event()
    sampler = None
    if sample_interval_s:
        sampler = threading.Thread(target=_sample_tree, args=(proc, sample_interval_s, stats, stop), daemon=True)
        sampler.start()
    data = stdin_text.encode("utf-8") if stdin_text is not None else None
    try:
        out, err = proc.communicate(input=data, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        result.timed_out = True
        result.descendants_at_kill = kill_tree(proc)
        try:
            out, err = proc.communicate(timeout=drain_timeout_s)
        except subprocess.TimeoutExpired:
            for stream in (proc.stdout, proc.stderr):
                try:
                    stream.close()
                except Exception:
                    pass
            out, err = b"", b""
    except BaseException:
        kill_tree(proc)
        raise
    else:
        job = getattr(proc, "_pki_job", None)
        if job:
            _terminate_job(job)  # also reaps stragglers that outlived the main process
    stop.set()
    if sampler:
        sampler.join(timeout=5)
    result.peak_rss_bytes = stats["peak_rss_bytes"]
    result.peak_process_count = stats["peak_process_count"]
    result.cpu_seconds = stats["cpu_seconds"]
    result.returncode = proc.returncode
    result.duration_s = time.time() - started
    for attr, raw in (("stdout", out), ("stderr", err)):
        text = (raw or b"").decode("utf-8", errors="replace")
        if len(text) > max_output_bytes:
            text = text[:max_output_bytes]
            result.output_truncated = True
        setattr(result, attr, text)
    return result
