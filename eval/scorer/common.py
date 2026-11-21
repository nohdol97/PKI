"""Small JSON/JSONL helpers shared by validate.py and score.py."""
import json


def load_jsonl(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ValueError("%s:%d: invalid JSON (%s)" % (path, n, exc))
    return rows


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)
