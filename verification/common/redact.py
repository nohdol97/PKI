"""Redaction of identifying values before anything is written to a result file.

STATUS: written only; never exercised against a real CLI/engine. Unit-tested with synthetic strings.

Two layers:
  1. Pattern rules: home paths, UNC paths, e-mail, IPs, URL hosts, proxy settings, well-known
     secret formats, key=value secrets, UUID-like account ids.
  2. Environment literals: the real username, hostname, home dir, cwd and temp dir of the machine
     running the harness, replaced wherever they occur.
After redaction `residual_literals` / `assert_clean` re-scan with a plain substring search so a
result file is never written while an environment literal is still inside it (fail closed).
Synthetic canary tokens, version numbers and sha256 hashes are deliberately NOT redacted.
"""
import getpass
import os
import re
import socket
import tempfile

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]", "::1")
SAFE_WINDOWS_PREFIXES = ("c:\\program files", "c:\\windows", "c:\\programdata", "c:/program files", "c:/windows")


class RedactionError(Exception):
    """A result still contains an environment-identifying literal after redaction."""


def environment_literals():
    """Return {literal: placeholder} for values that identify this machine or its user."""
    out = {}

    def add(value, placeholder):
        if value and isinstance(value, str) and len(value) >= 3:
            out[value] = placeholder

    try:
        add(getpass.getuser(), "<USER>")
    except Exception:  # getpass can fail without a passwd entry
        pass
    for name in ("USERNAME", "USER", "LOGNAME"):
        add(os.environ.get(name), "<USER>")
    for name in ("COMPUTERNAME", "HOSTNAME", "USERDOMAIN"):
        add(os.environ.get(name), "<HOST>")
    try:
        add(socket.gethostname(), "<HOST>")
        add(socket.gethostname().split(".")[0], "<HOST>")
    except Exception:
        pass
    add(os.path.expanduser("~"), "<HOME>")
    add(os.getcwd(), "<CWD>")
    add(tempfile.gettempdir(), "<TMP>")
    return out


_EMAIL = re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b")
_IPV4 = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_WIN_USER = re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s\"'<>|*?:]+")
_POSIX_USER = re.compile(r"(?:/private)?/(?:Users|home)/[^/\s\"'<>|*?:]+|/root(?=[/\s\"']|$)")
_UNC = re.compile(r"\\\\[^\\/\s\"'<>|]+(?:\\[^\s\"'<>|]*)?")
_DRIVE_PATH = re.compile(r"\b[A-Za-z]:[\\/][^\s\"'<>|*?]*")
_URL = re.compile(r"\b([A-Za-z][A-Za-z0-9+.\-]*)://([^/\s\"'<>?#]+)([^\s\"'<>]*)")
_PROXY = re.compile(r"(?i)\b((?:https?|all|no)_proxy)\s*=\s*\S+")
_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]{12,}"),
]
_KEY_VALUE = re.compile(
    r"(?i)\b(password|passwd|pwd|secret|token|api[_\-]?key|apikey|authorization)\b(\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|\S+)")


def _is_loopback(host):
    bare = host.rsplit("@", 1)[-1]
    if bare.startswith("["):
        return bare.startswith("[::1]")
    return bare.split(":")[0].lower() in ("127.0.0.1", "localhost")


class Redactor:
    def __init__(self, literals=None, include_environment=True):
        merged = {}
        if include_environment:
            merged.update(environment_literals())
        if literals:
            merged.update(literals)
        self.literals = {k: v for k, v in merged.items() if k and len(k) >= 3}
        ordered = sorted(self.literals, key=len, reverse=True)
        self._literal_res = [
            (re.compile(r"(?<![A-Za-z0-9])" + re.escape(lit) + r"(?![A-Za-z0-9])", re.IGNORECASE), self.literals[lit])
            for lit in ordered
        ]

    # ---- text -------------------------------------------------------------------------------
    def redact_text(self, text):
        if not isinstance(text, str) or not text:
            return text
        for rx, placeholder in self._literal_res:
            text = rx.sub(placeholder, text)
        text = _WIN_USER.sub("<HOME>", text)
        text = _POSIX_USER.sub("<HOME>", text)
        text = _UNC.sub("<UNC>", text)
        text = _PROXY.sub(lambda m: m.group(1) + "=<PROXY>", text)
        text = _URL.sub(self._url_sub, text)
        text = _EMAIL.sub("<EMAIL>", text)
        for rx in _SECRET_PATTERNS:
            text = rx.sub("<TOKEN>", text)
        text = _KEY_VALUE.sub(lambda m: m.group(1) + m.group(2) + "<SECRET>", text)
        text = _UUID.sub("<ID>", text)
        text = _IPV4.sub(self._ip_sub, text)
        snapshot = text
        text = _DRIVE_PATH.sub(lambda m: self._drive_sub(m, snapshot), text)
        return text

    @staticmethod
    def _url_sub(m):
        scheme, host, rest = m.group(1), m.group(2), m.group(3)
        if _is_loopback(host) or scheme.lower() in ("file", "c"):
            return m.group(0)
        return "{}://<URL-HOST>{}".format(scheme, rest)

    @staticmethod
    def _ip_sub(m):
        return m.group(0) if m.group(0).startswith("127.") else "<IP>"

    @staticmethod
    def _drive_sub(m, text):
        # Safe system prefixes may contain a space ("Program Files"), which the match stops at.
        window = text[m.start():m.start() + 24].lower()
        if window.startswith(SAFE_WINDOWS_PREFIXES):
            return m.group(0)
        return "<PATH>"

    # ---- objects ----------------------------------------------------------------------------
    def redact_obj(self, obj):
        if isinstance(obj, str):
            return self.redact_text(obj)
        if isinstance(obj, dict):
            return {self.redact_text(k) if isinstance(k, str) else k: self.redact_obj(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.redact_obj(v) for v in obj]
        return obj

    # ---- fail-closed check --------------------------------------------------------------------
    def residual_literals(self, text):
        """Environment literals still present (plain, case-insensitive substring search)."""
        lowered = text.lower()
        return [lit for lit in self.literals if lit.lower() in lowered
                and not self._is_placeholder_overlap(lit)]

    @staticmethod
    def _is_placeholder_overlap(lit):
        return lit.startswith("<")

    def assert_clean(self, text):
        found = self.residual_literals(text)
        if found:
            raise RedactionError(
                "{} identifying literal(s) remain after redaction; refusing to write".format(len(found)))
