#!/usr/bin/env python3
"""Regenerate eval/golden from the scenario definitions (deterministic, stdlib only).

Usage: python3 eval/golden/tools/generate.py eval/golden
The committed JSONL is the source of truth; this script exists to keep evidence spans exact.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import builder  # noqa: E402
import scen_a  # noqa: E402
import scen_b  # noqa: E402
import scen_c  # noqa: E402

SEAL_NOTE = ("The eval split is sealed by convention only: this repository is public, so the labels are "
             "readable by anyone. Do not tune on instances listed under 'eval'; any tuning that touched them "
             "must be disclosed with the result.")
# Everything except the last instance of each scenario (last two for schedule_dependency_delay) is dev.
EVAL_INSTANCES = {"S01-I3", "S01-I4", "S02-I3", "S03-I3", "S04-I3", "S05-I3", "S06-I3", "S07-I3",
                  "S08-I3", "S09-I3", "S10-I3", "S11-I3"}


def main(out_dir):
    w = builder.World()
    for fn in (scen_a.s01, scen_a.s02, scen_a.s03, scen_b.s04, scen_b.s05, scen_b.s06, scen_b.s07,
               scen_c.s08, scen_c.s09, scen_c.s10, scen_c.s11):
        fn(w)
    dev = {i for i in w.instances if i not in EVAL_INSTANCES}
    w.write(out_dir, dev, SEAL_NOTE)
    print("records:", len(w.records), {k: sum(1 for r in w.records if r["source_type"] == k)
                                       for k in ("mail", "wiki", "messenger")})
    print("labels:", {k: len(v) for k, v in w.labels.items()})
    print("instances:", len(w.instances), "dev:", len(dev), "eval:", len(w.instances) - len(dev))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "eval/golden")
