#!/usr/bin/env python3
"""Export a recorded run to tidy CSV for offline analysis.

Applies the same per-metric conditions the dashboard uses, read from the run's own
metrics-schema.json, so a CSV produced here agrees with what the dashboard displayed and with
the srsRAN gNB's own metrics. Deriving MCS without those conditions gives roughly 1.4 where the
gNB reports 15, because it writes 0 on TTIs it did not schedule.

    python3 export_run.py logs/runs/<run-id> --bucket 1.0 -o run.csv

Columns: timestamp (ISO, bucket start), rnti, then one per metric. A metric is blank for a bucket
in which it was undefined -- that is a gap, not a zero.
"""
import argparse
import csv
import datetime
import json
import sqlite3
import sys
from pathlib import Path


def build_select(metric: dict, covered_us: str) -> str | None:
    cols = metric["columns"]
    when = metric["definedWhen"] or "1"
    agg = metric["aggregation"]
    if agg == "avg":
        return f'AVG(CASE WHEN {when} THEN {cols[0]} END) * {metric["scale"]} AS "{metric["key"]}"'
    if agg == "rate":
        return f'SUM({cols[0]}) * 8.0 / {covered_us} AS "{metric["key"]}"'
    if agg == "ratio":
        num, den = cols
        return (f'CASE WHEN SUM({num}) + SUM({den}) > 0 '
                f'THEN SUM({num}) * 100.0 / (SUM({num}) + SUM({den})) END AS "{metric["key"]}"')
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--bucket", type=float, default=1.0, help="bucket width in seconds (default 1.0)")
    parser.add_argument("-o", "--output", type=Path, help="CSV path (default: stdout)")
    parser.add_argument("--metrics", help="comma-separated metric keys (default: all available)")
    args = parser.parse_args()

    schema_path = args.run_dir / "metrics-schema.json"
    db_path = args.run_dir / "metrics.sqlite3"
    if not db_path.exists():
        print(f"no metrics.sqlite3 in {args.run_dir}", file=sys.stderr)
        return 1
    if not schema_path.exists():
        print(f"no metrics-schema.json in {args.run_dir} -- recorded before schemas were written; "
              f"copy one from a newer run if the database has the same columns", file=sys.stderr)
        return 1

    schema = json.loads(schema_path.read_text())
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    present = {row[1] for row in db.execute("PRAGMA table_info(ue_mac)")}

    wanted = args.metrics.split(",") if args.metrics else None
    metrics = [m for m in schema["metrics"]
               if (wanted is None or m["key"] in wanted)
               and all(c in present for c in m["columns"])]
    if not metrics:
        print("no requested metric is available in this run's database", file=sys.stderr)
        return 1

    bucket_us = int(args.bucket * 1_000_000)
    selects = [s for s in (build_select(m, str(bucket_us)) for m in metrics) if s]
    sql = f"""
        SELECT CAST(timestamp_us / {bucket_us} AS INTEGER) * {bucket_us} AS bucket_us, rnti,
               {', '.join(selects)}
        FROM ue_mac GROUP BY bucket_us, rnti ORDER BY bucket_us, rnti
    """
    rows = db.execute(sql).fetchall()

    handle = args.output.open("w", newline="") if args.output else sys.stdout
    writer = csv.writer(handle)
    writer.writerow(["timestamp", "rnti"] + [m["key"] for m in metrics])
    for row in rows:
        stamp = datetime.datetime.fromtimestamp(row[0] / 1e6, datetime.timezone.utc).isoformat()
        values = ["" if v is None else (round(v, m["precision"]) if isinstance(v, float) else v)
                  for v, m in zip(row[2:], metrics)]
        writer.writerow([stamp, f"0x{row[1]:04X}"] + values)
    if args.output:
        handle.close()
        print(f"wrote {len(rows)} rows for {len(metrics)} metrics to {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
