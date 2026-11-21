#!/usr/bin/env python3
"""R04 kit entry point (Python side): plan, sanitize, and the follow-up notices.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. The measurement scripts are PowerShell under scripts/.
This kit does NOT build an installer (no product code yet). It needs a V01 skeleton installer artifact.

  plan             print the order of the scripts and what each needs (executes nothing)
  sanitize         second-pass masking of the PowerShell result (see sanitize_result.py)
  build-skeleton   notice only: R04-S1 (the V01 skeleton installer is not built here)
  second-installer notice only: R04-S2 (R04-C2 second installer with a Python/native module)
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import sanitize_result  # noqa: E402

NOTICE_EXIT = 3
NOTICES = {
    "build-skeleton": "미구현, 배포처 후속: R04-S1 Electron + Local API skeleton 설치 파일은 V01(#16)이 만든다. 이 키트는 설치 파일을 만들지 않고, 만들어진 설치 파일에 대해 측정·점검만 한다.",
    "second-installer": "미구현, 배포처 후속: R04-S2 R04-C2의 두 번째 설치 실험은 R03에서 통과한 후보의 Python/native 모듈을 담은 설치 파일이 있어야 한다. 그 설치 파일에는 같은 scripts/를 -IncludeCrashTest와 WorkerProcessNames 설정으로 쓴다.",
}
STEPS = [
    ("01-preflight.ps1", "clean machine check (no Node/Python/Docker/DB server)", "R04-C1"),
    ("02-install-silent.ps1", "silent install, installer/installed size, before-snapshot", "R04-C1, R04-C3"),
    ("08-roundtrip.ps1", "synthetic Local API round trip (browser/Electron screens are manual)", "R04-C1"),
    ("03-startup-time.ps1", "start-up time, N runs", "R04-C3"),
    ("04-idle-sampling.ps1", "idle CPU/RSS of the process tree", "R04-C3"),
    ("05-single-instance-stop.ps1", "single instance, graceful stop, worker orphans (-IncludeCrashTest)", "R04-C1, R04-C2"),
    ("07-signature-info.ps1", "Authenticode status of installer and binaries", "R04-C3"),
    ("06-uninstall-leftovers.ps1", "silent uninstall and leftover diff (run last)", "R04-C1"),
]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    sub.add_parser("build-skeleton")
    sub.add_parser("second-installer")
    sp = sub.add_parser("sanitize")
    sp.add_argument("--raw", required=True)
    sp.add_argument("--out", required=True)
    sp.add_argument("--redact", action="append", default=[])
    args = ap.parse_args(argv)
    if args.command in NOTICES:
        print(NOTICES[args.command])
        return NOTICE_EXIT
    if args.command == "plan":
        print("Run on a clean Windows 11 (VM snapshot), in PowerShell, from the scripts/ folder. Needs config.json and a V01 installer.")
        for n, (name, what, crit) in enumerate(STEPS, 1):
            print("{}. {:30} {}  [{}]".format(n, name, what, crit))
        print("then: python run.py sanitize --raw <r04-result>/raw/result-raw.json --out <folder>   (on any machine with Python; paste only <folder>/result.*)")
        print("Manual items (SmartScreen, tray, browser/Electron screens, signing/update decisions): CHECKLIST_MANUAL.md")
        return 0
    return sanitize_result.main(["--raw", args.raw, "--out", args.out] + sum([["--redact", x] for x in args.redact], []))


if __name__ == "__main__":
    sys.exit(main())
