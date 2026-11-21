"""Load, lint and render the R02 argv profiles (profiles.json).

STATUS: NEVER EXECUTED against a real CLI/engine/installer (written only); no profile has ever been executed against a real CLI.

Rules enforced by `lint_profiles` (spec R02-R3):
  * argv is a list of str (a shell string is rejected), argv[0] is the CLI name and not a shell;
  * every flag that takes a value is followed by a value that is not itself a known flag
    (an empty string is accepted only for flags listed in `empty_value_ok`, e.g. --tools "");
  * only the known {placeholders} appear, and rendering replaces them element by element.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_PATH = os.path.join(HERE, "profiles.json")
PLACEHOLDERS = {"schema_json", "schema_file", "result_file", "cwd", "model"}
SHELLS = {"sh", "bash", "zsh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"}
_PLACEHOLDER_RE = re.compile(r"\{([a-z_]+)\}")


class ProfileError(Exception):
    pass


def lint_profiles(data):
    errors = []
    value_flags = data.get("value_flags", {})
    all_flags = set(data.get("valueless_flags", []))
    for flags in value_flags.values():
        all_flags.update(flags)
    empty_ok = set(data.get("empty_value_ok", []))
    seen = set()
    for p in data.get("profiles", []):
        name = p.get("name", "<unnamed>")
        if name in seen:
            errors.append("{}: duplicate profile name".format(name))
        seen.add(name)
        argv = p.get("argv")
        if not isinstance(argv, list):
            errors.append("{}: argv must be a list, not a shell string".format(name))
            continue
        if not all(isinstance(a, str) for a in argv):
            errors.append("{}: every argv element must be a string".format(name))
            continue
        if not argv or argv[0] in SHELLS or argv[0] != p.get("cli"):
            errors.append("{}: argv[0] must be the CLI name and never a shell".format(name))
        if p.get("kind") not in ("contained", "control"):
            errors.append("{}: kind must be contained or control".format(name))
        if not p.get("source"):
            errors.append("{}: source is required".format(name))
        for i, token in enumerate(argv):
            if token in value_flags.get(p.get("cli"), []):
                if i + 1 >= len(argv):
                    errors.append("{}: {} has no value".format(name, token))
                    continue
                nxt = argv[i + 1]
                if nxt in all_flags:
                    errors.append("{}: {} is followed by flag {} (no value)".format(name, token, nxt))
                if nxt == "" and token not in empty_ok:
                    errors.append("{}: {} has an empty value".format(name, token))
            for ph in _PLACEHOLDER_RE.findall(token):
                if ph not in PLACEHOLDERS:
                    errors.append("{}: unknown placeholder {{{}}}".format(name, ph))
    return errors


def load_profiles(path=DEFAULT_PATH):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    errors = lint_profiles(data)
    if errors:
        raise ProfileError("profile file failed lint:\n  " + "\n  ".join(errors))
    return data


def get_profile(data, name):
    for p in data["profiles"]:
        if p["name"] == name:
            return p
    raise ProfileError("unknown profile: " + name)


def render_argv(profile, values):
    """Replace {placeholders} element by element. The result is never joined into one string."""
    def sub(token):
        def one(m):
            key = m.group(1)
            if key not in PLACEHOLDERS:
                raise ProfileError("unknown placeholder {" + key + "}")
            return values[key]
        return _PLACEHOLDER_RE.sub(one, token)
    return [sub(t) for t in profile["argv"]]
