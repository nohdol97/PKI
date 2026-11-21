"""Regex redaction: the SECOND layer over the pasteable result (the first layer is the allowlist in results.py).

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only). Unit-tested with synthetic strings.

A denylist cannot be complete (reviewer R1-R6), so nothing relies on this alone: the pasteable result can only hold
harness-generated values (see results.py) and this module masks what could still slip in, then the write fails
closed if an environment literal (user, host, FQDN, parent domain, home, cwd, temp dir) remains.
Known limits, stated plainly: personal names in any script (e.g. Korean names), phone and resident numbers, and
company names are not detectable by pattern; use --redact <literal> for those and keep free text out of results.
Short literals (< 3 chars) are matched as whole words only.
"""
import getpass
import os
import re
import socket
import tempfile

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "[::1]", "::1")


class RedactionError(Exception):
    """A result still contains an environment-identifying literal after redaction."""


def environment_literals():
    """Return {literal: placeholder} for values that identify this machine or its user."""
    out = {}

    def add(value, placeholder):
        if value and isinstance(value, str) and len(value) >= 2:
            out[value] = placeholder

    try:
        add(getpass.getuser(), "<USER>")
    except Exception:  # getpass can fail without a passwd entry
        pass
    for name in ("USERNAME", "USER", "LOGNAME"):
        add(os.environ.get(name), "<USER>")
    for name in ("COMPUTERNAME", "HOSTNAME", "USERDOMAIN", "USERDNSDOMAIN", "LOGONSERVER", "USERDOMAIN_ROAMINGPROFILE"):
        add((os.environ.get(name) or "").lstrip("\\"), "<HOST>")
    try:
        host = socket.gethostname()
        add(host, "<HOST>")
        add(host.split(".")[0], "<HOST>")
        fqdn = socket.getfqdn()
        add(fqdn, "<HOST>")
        parts = fqdn.split(".")
        if len(parts) > 2:
            add(".".join(parts[1:]), "<DOMAIN>")
    except Exception:
        pass
    add(os.path.expanduser("~"), "<HOME>")
    add(os.getcwd(), "<CWD>")
    add(tempfile.gettempdir(), "<TMP>")
    return out


_NOTQ = r"[^\s@\"'<>(){}\[\],;]"
_EMAIL = re.compile(_NOTQ + r"+@" + _NOTQ + r"+\." + _NOTQ + r"{2,}")
_IPV4 = re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b")
_IPV6 = re.compile(r"(?<![\w:])[0-9A-Fa-f:]{4,}(?![\w:])")
_MAC = re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b")
_SID = re.compile(r"\bS-1-\d+(?:-\d+){2,}\b")
_UUID = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b")
_HEX_ID = re.compile(r"\b[0-9a-fA-F]{32}\b")
_HEX_KEY = re.compile(r"\b[0-9a-fA-F]{40,}\b")
_WIN_USER = re.compile(r"[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n\"'<>|*?:]+")
_POSIX_USER = re.compile(r"(?:/private)?/(?:Users|home)/[^/\s\"'<>|*?:]+|/root(?=[/\s\"']|$)")
_UNC = re.compile(r"\\\\[^\r\n\"'<>|]+|(?<![\w:/])//[A-Za-z0-9_.\-]+/[^\s\"'<>|]*")
_DRIVE_PATH = re.compile(r"\b[A-Za-z]:[\\/][^\r\n\"'<>|*?]*")
_REG_PATH = re.compile(r"\bHK(?:CU|LM|CR|U|CC)[:\\][^\r\n\"'<>|*?]*")
_POSIX_PATH = re.compile(r"(?<![\w/:.\-])/(?:[^\s\"'/<>|]+/)+[^\s\"'<>|]*")
_URL = re.compile(r"\b([A-Za-z][A-Za-z0-9+.\-]*)://([^/\s\"'<>?#]+)([^\s\"'<>]*)")
_PROXY = re.compile(r"(?i)\b((?:https?|all|no)_proxy)\s*[=:]\s*\S+")
_HOSTPORT = re.compile(r"(?<![\w.\-/:\"])(?:[A-Za-z0-9\-]+\.)*[A-Za-z][A-Za-z0-9\-]*:\d{2,5}\b")
_FQDN = re.compile(r"\b(?:[A-Za-z0-9\-]+\.){2,}[A-Za-z]{2,}\b")
_DN = re.compile(r"\b(?:CN|OU|DC)=[^,\s\"']+(?:,\s*(?:CN|OU|DC|O|C)=[^,\s\"']+)*")
_PEM = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)", re.S)
_SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"),
    re.compile(r"\bya29\.[0-9A-Za-z_\-]{10,}"),
    re.compile(r"\bGOCSPX-[0-9A-Za-z_\-]{10,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
]
_AUTH_HEADER = re.compile(r"(?i)\b(authorization|proxy-authorization)\b(\s*[:=]\s*)(?:(?:basic|bearer|token|digest)\s+)?[^\s\",;]+")
_BEARER = re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}")
_COOKIE = re.compile(r"(?i)\b(set-cookie|cookie)\b(\s*[:=]\s*)[^\r\n\"]*")
_SW = r"(?:password|passwd|pwd|secret|token|api[_\-]?key|apikey|access[_\-]?key|private[_\-]?key|credential|session[_\-]?id|sessionid)"
_KV_JSON = re.compile(r"(?i)(\"[^\"\n]*" + _SW + r"[^\"\n]*\"\s*:\s*)(\"(?:[^\"\\\n]|\\.)*\"|[^\s,}\]]+)")
_KV_PLAIN = re.compile(r"(?i)\b([A-Za-z0-9_.\-]*" + _SW + r"[A-Za-z0-9_.\-]*)(\s*[:=]\s*)(\"[^\"]*\"|'[^']*'|[^\s,;]+)")


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
        self.literals = {k: v for k, v in merged.items() if k and len(k) >= 2}
        ordered = sorted(self.literals, key=len, reverse=True)
        self._literal_res = [
            (re.compile(r"(?<![A-Za-z0-9])" + re.escape(lit) + r"(?![A-Za-z0-9])", re.IGNORECASE), self.literals[lit])
            for lit in ordered
        ]

    def redact_text(self, text):
        if not isinstance(text, str) or not text:
            return text
        for rx, placeholder in self._literal_res:
            text = rx.sub(placeholder, text)
        text = _PEM.sub("<PRIVATE-KEY>", text)
        text = _WIN_USER.sub("<HOME>", text)
        text = _POSIX_USER.sub("<HOME>", text)
        text = _UNC.sub("<UNC>", text)
        text = _REG_PATH.sub("<REGPATH>", text)
        text = _DRIVE_PATH.sub("<PATH>", text)
        text = _COOKIE.sub(lambda m: m.group(1) + m.group(2) + "<SECRET>", text)
        text = _AUTH_HEADER.sub(lambda m: m.group(1) + m.group(2) + "<SECRET>", text)
        text = _BEARER.sub("<SECRET>", text)
        text = _PROXY.sub(lambda m: m.group(1) + "=<PROXY>", text)
        text = _URL.sub(self._url_sub, text)
        text = _EMAIL.sub("<EMAIL>", text)
        for rx in _SECRET_PATTERNS:
            text = rx.sub("<TOKEN>", text)
        text = _KV_JSON.sub(lambda m: m.group(1) + '"<SECRET>"', text)
        text = _KV_PLAIN.sub(lambda m: m.group(1) + m.group(2) + "<SECRET>", text)
        text = _DN.sub("<DN>", text)
        text = _SID.sub("<SID>", text)
        text = _UUID.sub("<ID>", text)
        text = _HEX_KEY.sub("<TOKEN>", text)
        text = _HEX_ID.sub("<ID>", text)
        text = _MAC.sub("<MAC>", text)
        text = _IPV6.sub(self._ipv6_sub, text)
        text = _IPV4.sub(lambda m: m.group(0) if m.group(0).startswith("127.") else "<IP>", text)
        text = _HOSTPORT.sub(lambda m: m.group(0) if m.group(0).lower().startswith(("127.0.0.1:", "localhost:")) else "<HOST>:<PORT>", text)
        text = _FQDN.sub("<HOST>", text)
        text = _POSIX_PATH.sub("<PATH>", text)
        return text

    @staticmethod
    def _ipv6_sub(m):
        value = m.group(0)
        looks_v6 = ("::" in value or value.count(":") >= 3) and re.search(r"[0-9A-Fa-f]", value)
        return "<IP>" if looks_v6 and value != "::1" else value

    @staticmethod
    def _url_sub(m):
        scheme, host = m.group(1), m.group(2)
        if _is_loopback(host) or scheme.lower() == "file":
            return m.group(0)
        return "<URL>"

    def redact_obj(self, obj):
        if isinstance(obj, str):
            return self.redact_text(obj)
        if isinstance(obj, dict):
            return {self.redact_text(k) if isinstance(k, str) else k: self.redact_obj(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.redact_obj(v) for v in obj]
        return obj

    def residual_literals(self, text):
        """Environment literals still present: substring search, except literals shorter than 3 chars (whole words only)."""
        found = []
        for lit in self.literals:
            if lit.startswith("<"):
                continue
            if len(lit) < 3:
                if re.search(r"(?<![A-Za-z0-9])" + re.escape(lit) + r"(?![A-Za-z0-9])", text, re.IGNORECASE):
                    found.append(lit)
            elif lit.lower() in text.lower():
                found.append(lit)
        return found

    def assert_clean(self, text):
        found = self.residual_literals(text)
        if found:
            raise RedactionError("{} identifying literal(s) remain after redaction; refusing to write".format(len(found)))
