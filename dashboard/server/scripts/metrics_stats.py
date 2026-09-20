#!/usr/bin/env python3
import json
import sqlite3
import sys

database = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
messages = database.execute("SELECT value FROM capture_stats WHERE key = 'messages'").fetchone()
missed = database.execute("SELECT value FROM capture_stats WHERE key = 'missed_ttis'").fetchone()
ue_samples = database.execute("SELECT COUNT(*) FROM ue_mac").fetchone()[0]
rntis = [f"0x{row[0]:04X}" for row in database.execute("SELECT DISTINCT rnti FROM ue_mac ORDER BY rnti")]
print(json.dumps({
    "metrics": {
        "messages": int(messages[0]) if messages else 0,
        "ueSamples": ue_samples,
        "missedTtis": int(missed[0]) if missed else 0,
    },
    "rntis": rntis,
}))
