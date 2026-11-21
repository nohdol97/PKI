#!/usr/bin/env python3
"""Project the RAW PowerShell result onto the allowlisted pasteable schema (R04), on any machine with Python 3.

STATUS: NEVER EXECUTED on a real PowerShell output (written only). Unit-tested with synthetic JSON only.

The PowerShell scripts write `raw/result-raw.json` (NOT pasteable). This tool keeps ONLY what the pasteable schema
(common/results.py, schema version 2) allows: check ids, fact keys and metric names from the fixed registries in
common/results.py, verdicts from the fixed vocabulary, known reason codes, numbers, booleans and strings from the fixed
vocabulary or the one strict value kind a key declares (version, known model family, hash). Every other field (free
text, names, paths, unregistered keys, list items and count keys, `observed`/`note`/`data` blobs) is DROPPED and only
counted in `dropped_fields`. So hostnames, folder names of other software, usernames and so on cannot reach the pasteable file
even if a PowerShell script collected them. The raw file is also copied to `<out>/raw/` (local only, never paste).
The regex redactor then runs as a second layer, and the write fails closed on any remaining environment literal
of THIS machine plus every --redact literal.
"""
import argparse
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

from common import results  # noqa: E402
from common.redact import RedactionError, Redactor  # noqa: E402

KIT = "r04-windows-installer"
RAW_CHECK_KEYS = {"id", "verdict", "facts", "codes"}


def project_raw(raw):
    """Return (pasteable_obj, dropped_field_count). Never raises on odd content: odd content is dropped."""
    dropped = 0
    out = {"schema_version": results.SCHEMA_VERSION, "kit": KIT, "mode": "real",
           "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "environment": results.project_environment(raw.get("environment") or {}), "checks": [], "metrics": {}, "notes": []}
    for key, value in (raw.get("environment") or {}).items():
        if out["environment"].get(key) != value:
            dropped += 1
    for key in raw:
        if key not in ("schema_version", "kit", "mode", "created", "environment", "checks", "metrics", "notes", "raw"):
            dropped += 1
    for check in raw.get("checks") or []:
        if not isinstance(check, dict) or not results.check_id_allowed(check.get("id")):
            dropped += 1
            continue
        dropped += len(set(check) - RAW_CHECK_KEYS)
        verdict = check.get("verdict")
        if verdict not in results.VERDICTS:
            dropped += 1
            verdict = "INCONCLUSIVE"  # an unreadable verdict never becomes a passing one
        facts, problems = results.project_facts(check.get("facts"))
        dropped += len(problems)
        codes = [c for c in (check.get("codes") or []) if isinstance(c, str) and c in results.CODES]
        dropped += len(check.get("codes") or []) - len(codes)
        out["checks"].append({"id": check["id"], "verdict": verdict, "facts": facts, "codes": codes})
    for name, m in (raw.get("metrics") or {}).items():
        if (name in results.METRIC_NAMES and isinstance(m, dict)
                and isinstance(m.get("value"), (int, float)) and not isinstance(m.get("value"), bool)):
            unit = m.get("unit") if m.get("unit") in results.UNITS else ""
            out["metrics"][name] = {"value": m["value"], "unit": unit}
        else:
            dropped += 1
    for note in raw.get("notes") or []:
        if isinstance(note, str) and note in results.CODES:
            out["notes"].append(note)
        else:
            dropped += 1
    if dropped:
        out["notes"].append("r04_free_text_dropped")
    out["dropped_fields"] = dropped
    return out, dropped


def sanitize(raw_path, out_dir, literals):
    try:
        with open(raw_path, encoding="utf-8-sig") as fh:
            raw = json.load(fh)
        if not isinstance(raw, dict):
            raise ValueError("not an object")
    except (OSError, ValueError) as exc:
        raise ValueError("raw result is not readable JSON ({})".format(type(exc).__name__))
    obj, _dropped = project_raw(raw)
    redactor = Redactor(literals={x: "<REDACTED>" for x in literals})
    paths = results.write_result_obj(obj, out_dir, redactor)
    raw_dir = os.path.join(out_dir, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    with open(raw_path, encoding="utf-8-sig") as fh:
        raw_text = fh.read()
    with open(os.path.join(raw_dir, "result-raw.json"), "w", encoding="utf-8") as fh:
        fh.write(redactor.redact_text(raw_text))
    results.write_raw_files(out_dir, {"README": ""}, redactor)  # adds README_NEVER_PASTE.txt
    return paths


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, help="raw\\result-raw.json written by the PowerShell scripts")
    ap.add_argument("--out", required=True, help="folder for the pasteable result.json + result.md (and a local raw/ copy)")
    ap.add_argument("--redact", action="append", default=[], help="extra literal that must not appear (repeatable)")
    args = ap.parse_args(argv)
    try:
        jpath, _mpath = sanitize(args.raw, args.out, args.redact)
    except (ValueError, RedactionError) as exc:
        print("refused: {}".format(exc), file=sys.stderr)
        return 1
    print("wrote {} and result.md (pasteable). Do NOT paste anything under raw/.".format(os.path.basename(jpath)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
