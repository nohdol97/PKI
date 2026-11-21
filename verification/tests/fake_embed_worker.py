"""Fake embedding worker for tests: speaks the JSON Lines worker protocol with hashed bag-of-words vectors.

Protocol (stdin JSONL in, stdout JSONL out):
  in : {"id": str, "text": str, "kind": "query"|"passage"}
  out: first {"event":"loaded","seconds":float,"dim":int}, then {"id": str, "vector": [floats]}
Never a real model.
"""
import hashlib
import json
import re
import sys
import time

DIM = 64


def vec(text):
    v = [0.0] * DIM
    for tok in re.findall(r"\w+", text.lower()):
        h = int(hashlib.sha256(tok.encode("utf-8")).hexdigest(), 16)
        v[h % DIM] += 1.0
    return v


def main():
    t0 = time.time()
    print(json.dumps({"event": "loaded", "seconds": time.time() - t0, "dim": DIM}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        msg = json.loads(line)
        print(json.dumps({"id": msg["id"], "vector": vec(msg["text"])}), flush=True)


if __name__ == "__main__":
    main()
