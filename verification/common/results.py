"""Result file writer shared by all three kits: one sanitized result.json + result.md.

STATUS: written only; never exercised against a real CLI/engine/installer.

Rules enforced here (spec R02-R9):
  * every string is redacted before it is written;
  * if an environment literal (hostname, username, home dir ...) is still present after
    redaction, nothing is written and RedactionError is raised (fail closed);
  * a dry-run result writes nothing;
  * raw text is truncated.
"""
import datetime
import json
import os

from .redact import Redactor

SCHEMA_VERSION = 1
VERDICTS = ("PASS", "FAIL", "BLOCKED", "INCONCLUSIVE", "NOT_RUN", "NOT_APPLICABLE")
NEVER_EXECUTED_NOTICE = (
    "Kit status: written off-site. If mode is 'real' this file came from a site run; if the notice "
    "'unit tests are not site evidence' is the only context you have, nothing was executed.")


def validate_result(obj):
    """Return a list of schema error strings; empty list means valid."""
    errors = []
    if not isinstance(obj, dict):
        return ["result must be an object"]
    for key, typ in (("schema_version", int), ("kit", str), ("mode", str), ("checks", list),
                     ("metrics", dict), ("raw", dict), ("environment", dict)):
        if key not in obj:
            errors.append("missing key '{}'".format(key))
        elif not isinstance(obj[key], typ):
            errors.append("key '{}' must be {}".format(key, typ.__name__))
    if obj.get("schema_version") not in (None, SCHEMA_VERSION) and isinstance(obj.get("schema_version"), int):
        errors.append("unsupported schema_version")
    for i, check in enumerate(obj.get("checks", []) if isinstance(obj.get("checks"), list) else []):
        if not isinstance(check, dict):
            errors.append("checks[{}] must be an object".format(i))
            continue
        for key in ("id", "criterion", "verdict", "observed"):
            if not isinstance(check.get(key), str):
                errors.append("checks[{}].{} must be a string".format(i, key))
        if isinstance(check.get("verdict"), str) and check["verdict"] not in VERDICTS:
            errors.append("checks[{}].verdict '{}' not in vocabulary".format(i, check["verdict"]))
    return errors


def render_markdown(obj):
    lines = ["# {} result".format(obj["kit"]), "",
             "- mode: {}".format(obj["mode"]),
             "- created (UTC): {}".format(obj.get("created", "")),
             "- schema_version: {}".format(obj["schema_version"]), ""]
    env = obj.get("environment") or {}
    if env:
        lines += ["## Environment", ""] + ["- {}: {}".format(k, v) for k, v in env.items()] + [""]
    lines += ["## Checks", "", "| id | verdict | criterion | observed |", "|---|---|---|---|"]
    for c in obj["checks"]:
        cells = [c["id"], c["verdict"], c["criterion"], c["observed"]]
        lines.append("| " + " | ".join(x.replace("|", "\\|").replace("\n", " ") for x in cells) + " |")
        if c.get("note"):
            lines.append("|  |  | note | {} |".format(c["note"].replace("|", "\\|").replace("\n", " ")))
    if obj.get("metrics"):
        lines += ["", "## Metrics", "", "| name | value | unit |", "|---|---|---|"]
        for name, m in obj["metrics"].items():
            lines.append("| {} | {} | {} |".format(name, m.get("value"), m.get("unit") or ""))
    if obj.get("notes"):
        lines += ["", "## Notes", ""] + ["- " + n for n in obj["notes"]]
    if obj.get("raw"):
        lines += ["", "## Raw (redacted, truncated)", ""]
        for name, text in obj["raw"].items():
            lines += ["### " + name, "", "```text", text, "```", ""]
    lines += ["", "> " + NEVER_EXECUTED_NOTICE, ""]
    return "\n".join(lines)


class ResultBuilder:
    def __init__(self, kit, out_dir, redactor=None, mode="real"):
        self.kit = kit
        self.out_dir = out_dir
        self.mode = mode
        self.redactor = redactor or Redactor()
        self._checks, self._metrics, self._raw, self._notes, self._env = [], {}, {}, [], {}

    def add_check(self, check_id, criterion, verdict, observed, note="", data=None):
        if verdict not in VERDICTS:
            raise ValueError("verdict must be one of {}".format(VERDICTS))
        check = {"id": check_id, "criterion": criterion, "verdict": verdict, "observed": observed, "note": note}
        if data is not None:
            check["data"] = data
        self._checks.append(check)

    def add_metric(self, name, value, unit=None):
        self._metrics[name] = {"value": value, "unit": unit}

    def add_raw(self, name, text, max_chars=4000):
        self._raw[name] = text if len(text) <= max_chars else text[:max_chars] + "\n...[truncated]"

    def add_note(self, text):
        self._notes.append(text)

    def set_environment(self, env):
        self._env = dict(env)

    def merge_from(self, path):
        """Keep checks/metrics/raw/notes of an earlier (already redacted) result.json whose ids are not
        re-added in this run, so several subcommands accumulate into one result file."""
        try:
            with open(path, encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, ValueError):
            return False
        if validate_result(old) or old.get("kit") != self.kit:
            return False
        have = {c["id"] for c in self._checks}
        self._checks = [c for c in old["checks"] if c["id"] not in have] + self._checks
        for key, store in (("metrics", self._metrics), ("raw", self._raw)):
            for name, value in old.get(key, {}).items():
                store.setdefault(name, value)
        self._notes = [n for n in old.get("notes", []) if n not in self._notes] + self._notes
        merged_env = dict(old.get("environment", {}))
        merged_env.update(self._env)
        self._env = merged_env
        return True

    def build(self):
        return {
            "schema_version": SCHEMA_VERSION, "kit": self.kit, "mode": self.mode,
            "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "environment": self._env, "checks": self._checks, "metrics": self._metrics,
            "raw": self._raw, "notes": self._notes,
        }

    def write(self):
        """Write result.json + result.md, or return None in dry-run mode. Fails closed on residue."""
        if self.mode == "dry-run":
            return None
        return write_result_obj(self.build(), self.out_dir, self.redactor)


def write_result_obj(obj, out_dir, redactor):
    """Redact, validate and write a complete result object. Raises RedactionError / ValueError, writing nothing."""
    obj = redactor.redact_obj(obj)
    errors = validate_result(obj)
    if errors:
        raise ValueError("result failed schema validation: " + "; ".join(errors))
    json_text = json.dumps(obj, ensure_ascii=False, indent=2)
    md_text = render_markdown(obj)
    for text in (json_text, md_text):
        redactor.assert_clean(text)
    os.makedirs(out_dir, exist_ok=True)
    json_path = os.path.join(out_dir, "result.json")
    md_path = os.path.join(out_dir, "result.md")
    with open(json_path, "w", encoding="utf-8") as fh:
        fh.write(json_text)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md_text)
    return json_path, md_path
