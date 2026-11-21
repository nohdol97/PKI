#!/usr/bin/env python3
"""Second-pass sanitizer for the PowerShell result.json (R04), runnable on any machine with Python 3.

STATUS: written off-site, never run on a real PowerShell output. Unit-tested with synthetic JSON only.

Reads the raw result.json produced by the .ps1 scripts (UTF-8, with or without BOM), masks identifying
values (hostnames, usernames, home paths, e-mail, IPs, URL hosts, secrets, plus --redact literals),
validates the schema, refuses to write when an environment literal remains, and writes result.json and
result.md to the output folder. Copy only that output folder's result files into an issue.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
VERIF = os.path.dirname(HERE)
if VERIF not in sys.path:
    sys.path.insert(0, VERIF)

from common.redact import RedactionError, Redactor  # noqa: E402,F401
from common.results import write_result_obj  # noqa: E402


def sanitize(raw_path, out_dir, literals):
    try:
        with open(raw_path, encoding="utf-8-sig") as fh:
            obj = json.load(fh)
    except (OSError, ValueError) as exc:
        raise ValueError("raw result is not readable JSON ({})".format(type(exc).__name__))
    redactor = Redactor(literals={x: "<REDACTED>" for x in literals})
    return write_result_obj(obj, out_dir, redactor)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, help="result.json written by the PowerShell scripts")
    ap.add_argument("--out", required=True, help="folder for the sanitized result.json + result.md")
    ap.add_argument("--redact", action="append", default=[], help="extra literal to mask (repeatable)")
    args = ap.parse_args(argv)
    try:
        jpath, mpath = sanitize(args.raw, args.out, args.redact)
    except (ValueError, RedactionError) as exc:
        print("refused: {}".format(exc), file=sys.stderr)
        return 1
    print("wrote {} and {}".format(os.path.basename(jpath), os.path.basename(mpath)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
