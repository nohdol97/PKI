"""Test path helper: puts verification/ on sys.path and loads kit modules by file path.

Kit directories use hyphens (r02-cli-isolation) and cannot be imported as packages,
so tests load their modules with importlib under unique names.
"""
import importlib.util
import os
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
VERIF_DIR = os.path.dirname(TESTS_DIR)
REPO_DIR = os.path.dirname(VERIF_DIR)
if VERIF_DIR not in sys.path:
    sys.path.insert(0, VERIF_DIR)


def load_kit_module(kit_dir: str, filename: str, alias: str):
    """Load verification/<kit_dir>/<filename> as module `alias` (kit dir is put on sys.path first)."""
    kit_path = os.path.join(VERIF_DIR, kit_dir)
    if kit_path not in sys.path:
        sys.path.insert(0, kit_path)
    spec = importlib.util.spec_from_file_location(alias, os.path.join(kit_path, filename))
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module
