"""Environment fingerprint: OS version, CLI versions, CPU/RAM class. Nothing identifying.

STATUS: written only; never exercised against a real CLI. The CLI version probe runs
`<binary> --version` only (no prompt, no model call) through common.runner.
"""
import ctypes
import os
import platform
import re
import sys

from . import runner

_VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.]+)?")


def bucket_cpu(n):
    for limit in (2, 4, 8, 16):
        if n is not None and n <= limit:
            return "<={} cores".format(limit)
    return ">16 cores" if n else "unknown"


def bucket_ram(num_bytes):
    if not num_bytes:
        return "unknown"
    gb = num_bytes / (1024 ** 3)
    for limit in (8, 16, 32, 64):
        if gb <= limit:
            return "<={} GB".format(limit)
    return ">64 GB"


def parse_version(text):
    m = _VERSION.search(text or "")
    return m.group(0) if m else None


def classify_binary_location(path):
    """Kind of install location. Never returns any part of the path itself."""
    low = path.replace("/", "\\").lower()
    if "\\users\\" in low or low.startswith("\\users\\") or "\\home\\" in low:
        return "user-profile"
    if low.startswith("c:\\program files") or "\\program files" in low:
        return "program-files"
    if low.startswith("\\usr\\") or low.startswith("\\bin\\") or low.startswith("\\opt\\"):
        return "system-bin"
    return "other"


def _total_ram_bytes():
    try:
        if sys.platform == "win32":
            class MemStatus(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
            st = MemStatus()
            st.dwLength = ctypes.sizeof(MemStatus)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
            return int(st.ullTotalPhys)
        if sys.platform == "darwin":
            res = runner.run_process(["sysctl", "-n", "hw.memsize"], timeout_s=5)
            return int(res.stdout.strip()) if res.returncode == 0 else None
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except Exception:
        return None


def environment_fingerprint():
    return {
        "os": platform.system(),
        "os_release": platform.release(),
        "os_version": platform.version(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpu_class": bucket_cpu(os.cpu_count()),
        "ram_class": bucket_ram(_total_ram_bytes()),
    }


def cli_version(binary_path):
    """`<binary> --version` only. Returns the version token or None."""
    res = runner.run_process([binary_path, "--version"], timeout_s=30)
    return parse_version(res.stdout + res.stderr) if res.returncode == 0 else None
