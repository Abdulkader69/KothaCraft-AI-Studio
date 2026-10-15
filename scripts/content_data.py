"""Aggregates the day tables from scripts/content/part*.py into one ordered list."""
import importlib
import pathlib

DAYS: list = []
_parts = sorted(pathlib.Path(__file__).resolve().parent.joinpath("content").glob("part*.py"))
for _p in _parts:
    _mod = importlib.import_module(f"content.{_p.stem}")
    DAYS.extend(_mod.DAYS)
DAYS.sort(key=lambda d: d[0])
