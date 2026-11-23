#!/usr/bin/env python3
"""Local-files site runner (I02B-R44, S23): the W1~W12 scenarios of the I02-B spec on the Windows installer.

STATUS: WRITTEN OFF-SITE, NEVER EXECUTED on Windows. Off-site only the refusals, `prepare` and the record form ran (unit tests).
The installed app has no `pnpm` and no workspace, so this runner runs on the repository's Python and looks at the installed
app from outside: a person walks the scenarios on the installed app (RUNBOOK.md), then closes it, and `record` reads the
canonical database read-only.

  prepare --app <install dir> --folder <empty folder> [--state <file>]
          makes the scenario files of W1~W12 in the folder (synthetic text only) and the state file (default: next to the folder)
  record  --app <install dir> --folder <folder> --data-dir <data dir> --out <result.json> [--state <file>] [--answers <file>]
          opens the canonical database read-only and writes one verdict per scenario (pass, fail, inconclusive) with the OS, the
          app version and the file system type. It records no file name and no text of a file.

A "Windows installer" is judged here (I02B-R44): `sys.platform == "win32"` and the `--app` folder holds an installed executable.
Otherwise the runner prints a notice that starts with `배포처 후속` and ends with 3 (the exit values of verification/v02-site-flow/run.py).

Exit values: 0 ok, 1 a record could not be written, 2 config error, 3 `배포처 후속` notice.
"""
import argparse
import json
import os
import platform as platform_module
import sqlite3
import sys

OK_EXIT, WRITE_EXIT, CONFIG_EXIT, NOTICE_EXIT = 0, 1, 2, 3
NOTICE = ("배포처 후속: S23 Windows 11 설치본이 아닌 환경의 실행은 배포처 결과로 기록하지 않는다. "
          "R04의 설치 파일로 설치한 Windows 11에서 --app에 설치 폴더를 주고 다시 실행한다(I02B-R44, 이유: {code}).")
SCENARIOS = ["W%d" % n for n in range(1, 13)]
VERDICTS = ("pass", "fail", "inconclusive")


class Refusal(Exception):
    """The notice (starts with `배포처 후속`); `code` names why."""

    def __init__(self, code):
        super().__init__(NOTICE.format(code=code))
        self.code = code


def gate(app, platform=None):
    """No refusal for a Windows machine whose `--app` folder holds an installed executable; else a Refusal."""
    if (platform or sys.platform) != "win32":
        raise Refusal("not-windows")
    if not app or not os.path.isdir(app):
        raise Refusal("app-missing")
    names = [n for n in os.listdir(app) if n.lower().endswith(".exe") and "uninstall" not in n.lower()]
    if not names:
        raise Refusal("exe-missing")


# ---- prepare: synthetic scenario files ----------------------------------------------------------------------------------

def _marker(n, kind="inside"):
    return "LF-%s-W%02d-%s" % (kind, n, os.urandom(6).hex())


def _write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)


def prepare(folder):
    """Makes the scenario files in `folder` and returns the state (the markers). The folder must be empty."""
    if os.path.exists(folder) and os.listdir(folder):
        raise ValueError("the folder must be empty")
    os.makedirs(folder, exist_ok=True)
    state = {"scenarios": {}}
    for n in range(1, 13):
        key = "W%d" % n
        marker = _marker(n)
        entry = {"marker": marker}
        base = os.path.join(folder, "w%02d" % n)
        text = "# synthetic %s\n\n%s\n" % (key, marker)
        if n == 1:   # rename, move, replace-by-save: the one source must follow the file
            _write(os.path.join(base, "before.md"), text)
        elif n == 2:  # a junction or symlink the person makes to a folder outside (RUNBOOK); the outside file holds this marker
            entry["outsideMarker"] = _marker(n, "outside")
            _write(os.path.join(base, "inside.md"), text)
            outside = os.path.normpath(folder) + "-outside"
            _write(os.path.join(outside, "outside.md"), "# outside\n\n%s\n" % entry["outsideMarker"])
        elif n == 5:  # a long path, a name that ends in a dot or a space, a reserved name
            deep = base
            for part in ("d" * 60, "e" * 60, "f" * 60, "g" * 60):
                deep = os.path.join(deep, part)
            try:
                _write(os.path.join(deep, "long.md"), text)
            except OSError:
                pass  # a system that cannot make it is itself the observation: W5 stays inconclusive
        elif n == 7:  # case-only rename and Hangul names in both normal forms
            _write(os.path.join(base, "Case.md"), text)
            _write(os.path.join(base, "가나다.md"), text + "nfc\n")
            _write(os.path.join(base, "가나다.md"), text + "nfd\n")
        elif n == 8:  # a temporary Office file next to a document
            _write(os.path.join(base, "doc.md"), text)
            _write(os.path.join(base, "~$doc.md"), "temporary\n")
        else:         # W3, W4, W6, W9, W10, W11, W12: the person makes the situation (RUNBOOK); one file marks the folder
            _write(os.path.join(base, "note.md"), text)
        state["scenarios"][key] = entry
    return state


# ---- record: read the database, never write it ----------------------------------------------------------------------------

def _count(db, marker):
    """Versions whose text holds the marker, and how many of those sources were deleted (a tombstone)."""
    like = "%" + marker + "%"
    sources = db.execute("SELECT DISTINCT source_id FROM source_versions WHERE body LIKE ?", (like,)).fetchall()
    dead = 0
    for (sid,) in sources:
        if db.execute("SELECT 1 FROM tombstones WHERE source_id = ?", (sid,)).fetchone():
            dead += 1
    return len(sources), dead


def _decide(db, key, entry):
    """A verdict from the database where the scenario can be judged from it; None where only the person can say."""
    live, dead = _count(db, entry["marker"])
    if key == "W1":   # the source followed the renamed or moved file: one source, not deleted
        return "inconclusive" if live == 0 else ("pass" if (live, dead) == (1, 0) else "fail")
    if key == "W2":   # nothing of the outside folder became a source
        outside_live, _ = _count(db, entry["outsideMarker"])
        if outside_live > 0:
            return "fail"
        return "pass" if live > 0 else "inconclusive"
    return None


def record(state, db_path, answers, environment):
    """The record: one verdict per scenario and the environment. A verdict the database can give wins over an answer."""
    con = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True)
    try:
        items = {}
        for key in SCENARIOS:
            decided = _decide(con, key, state["scenarios"][key])
            given = answers.get(key)
            items[key] = decided or (given if given in VERDICTS else "inconclusive")
    finally:
        con.close()
    return {"kit": "local-files", "os": environment.get("os", platform_module.platform()),
            "appVersion": environment.get("appVersion", "unknown"),
            "fileSystem": environment.get("fileSystem", "unknown"), "items": items}


def app_version(app):
    for rel in ("resources/app/package.json",):
        try:
            with open(os.path.join(app, *rel.split("/")), encoding="utf-8") as handle:
                version = json.load(handle).get("version")
            if isinstance(version, str):
                return version
        except (OSError, ValueError):
            continue
    return "unknown"


def filesystem_type(path):
    """NEVER EXECUTED: the volume's file system name on Windows, `unknown` elsewhere."""
    try:
        import ctypes  # noqa: PLC0415 - Windows only
        name = ctypes.create_unicode_buffer(32)
        root = os.path.splitdrive(os.path.abspath(path))[0] + "\\"
        if ctypes.windll.kernel32.GetVolumeInformationW(root, None, 0, None, None, None, name, 32):
            return name.value
    except Exception:  # noqa: BLE001 - any failure is "unknown"
        pass
    return "unknown"


# ---- command line --------------------------------------------------------------------------------------------------------------

def _state_path(args):
    return args.state or (os.path.normpath(args.folder) + ".local-files-state.json")


def main(argv=None, platform=None):
    parser = argparse.ArgumentParser(prog="run.py", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("prepare", "record"):
        p = sub.add_parser(action)
        p.add_argument("--app", required=True)
        p.add_argument("--folder", required=True)
        p.add_argument("--state")
        if action == "record":
            p.add_argument("--data-dir", required=True)
            p.add_argument("--out", required=True)
            p.add_argument("--answers")
    args = parser.parse_args(argv)
    try:
        gate(args.app, platform)
    except Refusal as refusal:
        print(refusal)
        return NOTICE_EXIT
    state_file = _state_path(args)
    if args.action == "prepare":
        try:
            state = prepare(args.folder)
        except (OSError, ValueError) as error:
            print("config error: %s" % error, file=sys.stderr)
            return CONFIG_EXIT
        with open(state_file, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        print("prepared %d scenarios; state: %s" % (len(state["scenarios"]), state_file))
        return OK_EXIT
    try:
        with open(state_file, encoding="utf-8") as handle:
            state = json.load(handle)
        answers = {}
        if args.answers:
            with open(args.answers, encoding="utf-8") as handle:
                answers = json.load(handle)
        result = record(state, os.path.join(args.data_dir, "pki.sqlite"), answers, {
            "os": platform_module.platform(), "appVersion": app_version(args.app), "fileSystem": filesystem_type(args.folder)})
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(result, handle, ensure_ascii=False, indent=2)
    except (OSError, ValueError, sqlite3.Error) as error:
        print("could not record: %s" % type(error).__name__, file=sys.stderr)
        return WRITE_EXIT
    print("recorded: %s" % args.out)
    return OK_EXIT


if __name__ == "__main__":
    sys.exit(main())
