"""Embedding worker stub for sentence-transformers (R03-S5).

STATUS: STUB, NEVER EXECUTED. No model is downloaded or loaded. Exits 3, which embedding_bench.py reports as
`미구현, 배포처 후속: R03-S5`.

PLAN (unconfirmed): sentence-transformers 6.3.0 is torch based (Windows torch wheel 126.7 MB, OSS_EVALUATION 4.5),
the largest packaging cost. The loading and encoding calls (and whether bge-m3 needs trust_remote_code or extra
options) have NO evidence in OSS_EVALUATION and are not guessed here.

Protocol and expectations: see embedding_bench.py (JSON Lines in/out, first output line is the `loaded` event
with the load time and the vector dimension). The operator finishes this file on site after reading the pinned
package's documentation, replaces the NotImplementedError below, and records the HF commit SHA of each model.
Network access for the model download requires the site's approval.
"""
import sys

MISSING = "library calls for loading the model and encoding batches are unconfirmed (no evidence in OSS_EVALUATION)"


def main():
    raise NotImplementedError("R03-S5 sentence-transformers worker: " + MISSING)


if __name__ == "__main__":
    try:
        main()
    except NotImplementedError as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.exit(3)
