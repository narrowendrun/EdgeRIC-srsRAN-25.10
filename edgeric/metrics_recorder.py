#!/usr/bin/env python3
"""Persist received EdgeRIC TTI protobufs and chart-ready MAC fields."""

import argparse
import json
import signal
import sqlite3
import time
from pathlib import Path

import zmq

import metrics_pb2


def open_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(path)
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA synchronous=NORMAL")
    database.execute("PRAGMA temp_store=MEMORY")
    database.executescript(
        """
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS raw_tti (
            id INTEGER PRIMARY KEY,
            timestamp_us INTEGER NOT NULL,
            received_at_us INTEGER NOT NULL,
            tti_index INTEGER NOT NULL,
            payload BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ue_mac (
            id INTEGER PRIMARY KEY,
            raw_tti_id INTEGER NOT NULL REFERENCES raw_tti(id) ON DELETE CASCADE,
            timestamp_us INTEGER NOT NULL,
            tti_index INTEGER NOT NULL,
            rnti INTEGER NOT NULL,
            snr REAL NOT NULL,
            cqi INTEGER NOT NULL,
            dl_acked_bytes INTEGER NOT NULL,
            ul_ok_bytes INTEGER NOT NULL,
            dl_harq_ack INTEGER NOT NULL,
            dl_harq_nack INTEGER NOT NULL,
            ul_crc_ok INTEGER NOT NULL,
            ul_crc_fail INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_raw_tti_timestamp ON raw_tti(timestamp_us);
        CREATE INDEX IF NOT EXISTS idx_ue_mac_timestamp_rnti ON ue_mac(timestamp_us, rnti);
        """
    )
    database.execute("INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '1')")
    database.execute("PRAGMA optimize")
    database.commit()
    return database


def wait_for_run(active_file: Path, stop_requested) -> tuple[str, Path] | None:
    announced = False
    while not stop_requested():
        try:
            active = json.loads(active_file.read_text(encoding="utf-8"))
            run_id = active["runId"]
            run_dir = Path(active["runDir"]).resolve()
            if run_dir.is_dir() and run_dir.name == run_id:
                return run_id, run_dir
        except (OSError, KeyError, TypeError, ValueError):
            if not announced:
                print(f"Metrics recorder waiting for an active run at {active_file}", flush=True)
                announced = True
        time.sleep(0.5)
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Record EdgeRIC metrics to a per-run SQLite database")
    parser.add_argument("--address", default="ipc:///tmp/metrics_data")
    parser.add_argument("--active-run-file", required=True)
    parser.add_argument("--batch-size", type=int, default=250)
    args = parser.parse_args()

    stopping = False

    def request_stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    selected = wait_for_run(Path(args.active_run_file), lambda: stopping)
    if not selected:
        return 0
    run_id, run_dir = selected
    database_path = run_dir / "metrics.sqlite3"
    database = open_database(database_path)

    context = zmq.Context()
    subscriber = context.socket(zmq.SUB)
    subscriber.setsockopt(zmq.RCVHWM, 100_000)
    subscriber.setsockopt(zmq.RCVTIMEO, 500)
    subscriber.setsockopt_string(zmq.SUBSCRIBE, "")
    subscriber.connect(args.address)

    messages = missed_ttis = parse_errors = pending = 0
    last_tti = None
    last_timestamp_us = 0
    last_commit = time.monotonic()
    print(f"Metrics recorder for {run_id} connected to {args.address}; writing {database_path}", flush=True)

    def commit_stats():
        values = {
            "messages": messages,
            "missed_ttis": missed_ttis,
            "parse_errors": parse_errors,
            "last_timestamp_us": last_timestamp_us,
        }
        database.executemany(
            "INSERT INTO capture_stats(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            values.items(),
        )
        database.commit()

    try:
        while not stopping:
            try:
                payload = subscriber.recv()
            except zmq.Again:
                if pending:
                    commit_stats()
                    pending = 0
                    last_commit = time.monotonic()
                continue

            message = metrics_pb2.TtiMetrics()
            try:
                message.ParseFromString(payload)
            except Exception as error:
                parse_errors += 1
                print(f"Unable to parse TTI metrics: {error}", flush=True)
                continue

            timestamp_us = int(message.timestamp_us) or int(time.time_ns() // 1000)
            last_timestamp_us = timestamp_us
            received_at_us = time.time_ns() // 1000
            tti_index = int(message.tti_index)
            if last_tti is not None:
                delta = (tti_index - last_tti) % 10_000
                if delta > 1:
                    missed_ttis += delta - 1
            last_tti = tti_index

            cursor = database.execute(
                "INSERT INTO raw_tti(timestamp_us, received_at_us, tti_index, payload) VALUES (?, ?, ?, ?)",
                (timestamp_us, received_at_us, tti_index, sqlite3.Binary(payload)),
            )
            database.executemany(
                """
                INSERT INTO ue_mac(
                    raw_tti_id, timestamp_us, tti_index, rnti, snr, cqi,
                    dl_acked_bytes, ul_ok_bytes, dl_harq_ack, dl_harq_nack,
                    ul_crc_ok, ul_crc_fail
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        cursor.lastrowid, timestamp_us, tti_index, int(ue.rnti), float(ue.mac.snr), int(ue.mac.cqi),
                        int(ue.mac.dl_acked_bytes), int(ue.mac.ul_ok_bytes),
                        int(ue.mac.dl_harq_ack), int(ue.mac.dl_harq_nack),
                        int(ue.mac.ul_crc_ok), int(ue.mac.ul_crc_fail),
                    )
                    for ue in message.ues
                ],
            )
            messages += 1
            pending += 1
            now = time.monotonic()
            if pending >= args.batch_size or now - last_commit >= 0.25:
                commit_stats()
                pending = 0
                last_commit = now
    finally:
        commit_stats()
        database.execute("PRAGMA optimize")
        database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        database.close()
        subscriber.close(linger=0)
        context.term()
        print(f"Metrics recorder stopped: {messages} messages, {missed_ttis} inferred missing TTIs", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
