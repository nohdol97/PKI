"""Embedding worker stub for fastembed (R03-S5).

STATUS: STUB, NEVER EXECUTED. No model is downloaded or loaded. Exits 3, which embedding_bench.py reports as
`미구현, 배포처 후속: R03-S5`.

PLAN (unconfirmed): fastembed 0.9.1 runs on onnxruntime without torch (OSS_EVALUATION 4.5 runtime table).
Its built-in multilingual list has multilingual-e5-large and two paraphrase-multilingual models; e5-small/base
and bge-m3 are only reachable through `add_custom_model` (same table). The exact add_custom_model arguments
(ONNX file location, pooling, normalization) have NO evidence in OSS_EVALUATION and are not guessed here.

Protocol and expectations: see embedding_bench.py (JSON Lines in/out, first output line is the `loaded` event
with the load time and the vector dimension). The operator finishes this file on site after reading the pinned
package's documentation, replaces the NotImplementedError below, and records the HF commit SHA of each model.
Network access for the model download requires the site's approval.
"""
import sys

MISSING = "library calls for loading the model and encoding batches are unconfirmed (no evidence in OSS_EVALUATION)"


def main():
    raise NotImplementedError("R03-S5 fastembed worker: " + MISSING)


if __name__ == "__main__":
    try:
        main()
    except NotImplementedError as exc:
        sys.stderr.write(str(exc) + "\n")
        sys.exit(3)
