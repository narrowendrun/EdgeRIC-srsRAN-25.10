"""Scheduler registry. Add a plugin class here; the runner stays unchanged."""

from .builtin import BUILTINS

ALGORITHMS = {scheduler.name: scheduler for scheduler in BUILTINS}


def create(name: str):
    try:
        return ALGORITHMS[name]()
    except KeyError as error:
        raise ValueError(f"unknown scheduler {name!r}; available: {', '.join(ALGORITHMS)}") from error
