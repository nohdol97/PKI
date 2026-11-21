"""Process table, descendant lookup and RSS helpers (stdlib only).

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only); the Windows branches (PowerShell CIM query, psapi via ctypes) have never
been executed. The POSIX branch is exercised by unit tests on the developer machine.
"""
import ctypes
import os
import re
import sys
from collections import namedtuple

from . import runner

ProcRow = namedtuple("ProcRow", "pid ppid rss_bytes cpu_seconds")

_CPU_TIME = re.compile(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$")

WINDOWS_TABLE_SCRIPT = (
    "Get-CimInstance Win32_Process | ForEach-Object { "
    "'{0},{1},{2},{3}' -f $_.ProcessId,$_.ParentProcessId,$_.WorkingSetSize,"
    "([uint64]$_.KernelModeTime + [uint64]$_.UserModeTime) }"
)


def _parse_cpu_time(text):
    m = _CPU_TIME.match(text.strip())
    if not m:
        return 0.0
    days, hours, minutes, seconds = m.groups()
    return int(days or 0) * 86400 + int(hours or 0) * 3600 + int(minutes) * 60 + float(seconds)


def parse_ps_table(text):
    """Parse `ps -A -o pid=,ppid=,rss=,time=` output (rss in KiB)."""
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 4 or not parts[0].isdigit():
            continue
        rows.append(ProcRow(int(parts[0]), int(parts[1]), int(parts[2]) * 1024, _parse_cpu_time(parts[3])))
    return rows


def parse_windows_table(text):
    """Parse `pid,ppid,workingset_bytes,cpu_time_100ns` lines from WINDOWS_TABLE_SCRIPT."""
    rows = []
    for line in text.splitlines():
        parts = line.strip().split(",")
        if len(parts) != 4 or not all(p.strip().isdigit() for p in parts):
            continue
        rows.append(ProcRow(int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3]) / 1e7))
    return rows


def list_process_table():
    if sys.platform == "win32":
        res = runner.run_process(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT], timeout_s=60)
        return parse_windows_table(res.stdout)
    res = runner.run_process(["ps", "-A", "-o", "pid=,ppid=,rss=,time="], timeout_s=30)
    return parse_ps_table(res.stdout)


def descendants_of(rows, root_pid):
    children = {}
    for r in rows:
        children.setdefault(r.ppid, []).append(r.pid)
    found, stack = [], [root_pid]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in found:
                found.append(child)
                stack.append(child)
    return found


def tree_totals(root_pid):
    """(process_count, rss_bytes, cpu_seconds) summed over root and its descendants."""
    rows = list_process_table()
    ids = set(descendants_of(rows, root_pid)) | {root_pid}
    picked = [r for r in rows if r.pid in ids]
    return len(picked), sum(r.rss_bytes for r in picked), sum(r.cpu_seconds for r in picked)


# ---- own process memory -------------------------------------------------------------------------
class _Counters(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


def _windows_counters():
    counters = _Counters()
    counters.cb = ctypes.sizeof(_Counters)
    kernel32 = ctypes.windll.kernel32
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(_Counters), ctypes.c_ulong]
    ctypes.windll.psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
    return counters


def current_rss_bytes():
    if sys.platform == "win32":
        return int(_windows_counters().WorkingSetSize)
    try:
        with open("/proc/self/statm") as fh:
            return int(fh.read().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except OSError:
        res = runner.run_process(["ps", "-o", "rss=", "-p", str(os.getpid())], timeout_s=10)
        return int(res.stdout.strip() or 0) * 1024


def peak_rss_bytes():
    if sys.platform == "win32":
        return int(_windows_counters().PeakWorkingSetSize)
    import resource
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == "darwin" else peak * 1024)
