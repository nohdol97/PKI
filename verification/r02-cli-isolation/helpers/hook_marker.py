"""Writes a marker file. Planted as a project hook command so a loaded hook becomes observable.

STATUS: written only; never run by a real CLI.
"""
import sys

with open(sys.argv[1], "w", encoding="utf-8") as fh:
    fh.write("HOOK_RAN")
