#!/usr/bin/env python3
"""Summarise a run's metrics database for its manifest.

Reads counters the recorder maintains as it writes (schema v2), falling back to table scans
for databases written by an older build.
"""
import json
import sqlite3
import sys

database = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)


def stat(key: str, default: int = 0) -> int:
    row = database.execute("SELECT value FROM capture_stats WHERE key = ?", (key,)).fetchone()
    return int(row[0]) if row else default


ue_samples = stat("ue_samples")
if ue_samples == 0:
    # v1 database, or a v2 run that genuinely saw no UEs -- the scan settles it either way.
    ue_samples = database.execute("SELECT COUNT(*) FROM ue_mac").fetchone()[0]

try:
    rows = database.execute("SELECT rnti FROM observed_rnti ORDER BY rnti")
    rntis = [f"0x{row[0]:04X}" for row in rows]
except sqlite3.OperationalError:
    rntis = []
if not rntis:
    rows = database.execute("SELECT DISTINCT rnti FROM ue_mac ORDER BY rnti")
    rntis = [f"0x{row[0]:04X}" for row in rows]

print(json.dumps({
    "metrics": {
        "messages": stat("messages"),
        "ueSamples": ue_samples,
        "missedTtis": stat("missed_ttis"),
    },
    "rntis": rntis,
}))
