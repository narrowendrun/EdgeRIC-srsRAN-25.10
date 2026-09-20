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

SCHEMA_VERSION = 2

# Every scalar MacUeMetrics field, in ue_mac column order after the key columns.
# Delay fields are stored as microsecond integers rather than millisecond REALs: a REAL costs
# 8 bytes per row unconditionally, a small integer 1-3.
METRIC_COLUMNS = [
    "snr", "cqi",
    "dl_mcs", "ul_mcs", "dl_prbs", "ul_prbs", "dl_tbs", "ul_tbs", "dl_buffer", "ul_buffer",
    "dl_acked_bytes", "ul_ok_bytes",
    "dl_harq_ack", "dl_harq_nack", "ul_crc_ok", "ul_crc_fail",
    "ce_delay_us", "crc_delay_us", "pucch_harq_delay_us", "pusch_harq_delay_us",
    "sr_to_pusch_delay_us", "sum_mac_delay_us",
]
UE_MAC_COLUMNS = ["raw_tti_id", "timestamp_us", "tti_index", "rnti"] + METRIC_COLUMNS
INSERT_UE_MAC = (
    f"INSERT INTO ue_mac({', '.join(UE_MAC_COLUMNS)}) "
    f"VALUES ({', '.join('?' * len(UE_MAC_COLUMNS))})"
)


def ue_mac_row(raw_tti_id, timestamp_us: int, tti_index: int, ue) -> tuple:
    """Project one UeMetrics message into an ue_mac row."""
    mac = ue.mac
    return (
        raw_tti_id, timestamp_us, tti_index, int(ue.rnti),
        float(mac.snr), int(mac.cqi),
        int(mac.dl_mcs), int(mac.ul_mcs), int(mac.dl_prbs), int(mac.ul_prbs),
        int(mac.dl_tbs), int(mac.ul_tbs), int(mac.dl_buffer), int(mac.ul_buffer),
        int(mac.dl_acked_bytes), int(mac.ul_ok_bytes),
        int(mac.dl_harq_ack), int(mac.dl_harq_nack), int(mac.ul_crc_ok), int(mac.ul_crc_fail),
        round(mac.avg_ce_delay_ms * 1000), round(mac.avg_crc_delay_ms * 1000),
        round(mac.avg_pucch_harq_delay_ms * 1000), round(mac.avg_pusch_harq_delay_ms * 1000),
        round(mac.avg_sr_to_pusch_delay_ms * 1000), round(mac.avg_sum_mac_delay_ms * 1000),
    )


def ensure_columns(database: sqlite3.Connection) -> bool:
    """Add any ue_mac columns a pre-v2 database is missing.

    Only reachable when the recorder restarts into a run whose database an older build
    created -- CREATE TABLE IF NOT EXISTS would leave it short and every insert would fail.
    Every added column carries a non-null default so ADD COLUMN is legal.

    Returns True when the table still carries v1's `raw_tti_id INTEGER NOT NULL`. SQLite cannot
    relax a column constraint in place, so the caller writes 0 rather than NULL for "no raw row"
    on such a table; raw_tti ids start at 1, so 0 is unambiguous.
    """
    info = list(database.execute("PRAGMA table_info(ue_mac)"))
    present = {row[1] for row in info}
    for column in METRIC_COLUMNS:
        if column in present:
            continue
        kind = "REAL" if column == "snr" else "INTEGER"
        database.execute(f"ALTER TABLE ue_mac ADD COLUMN {column} {kind} NOT NULL DEFAULT 0")
        print(f"Added missing ue_mac column: {column}", flush=True)
    # PRAGMA table_info columns: (cid, name, type, notnull, dflt_value, pk)
    return any(row[1] == "raw_tti_id" and row[3] == 1 for row in info)


def open_database(path: Path) -> tuple[sqlite3.Connection, bool]:
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
            id                   INTEGER PRIMARY KEY,
            raw_tti_id           INTEGER,
            timestamp_us         INTEGER NOT NULL,
            tti_index            INTEGER NOT NULL,
            rnti                 INTEGER NOT NULL,
            snr                  REAL    NOT NULL DEFAULT 0,
            cqi                  INTEGER NOT NULL DEFAULT 0,
            dl_mcs               INTEGER NOT NULL DEFAULT 0,
            ul_mcs               INTEGER NOT NULL DEFAULT 0,
            dl_prbs              INTEGER NOT NULL DEFAULT 0,
            ul_prbs              INTEGER NOT NULL DEFAULT 0,
            dl_tbs               INTEGER NOT NULL DEFAULT 0,
            ul_tbs               INTEGER NOT NULL DEFAULT 0,
            dl_buffer            INTEGER NOT NULL DEFAULT 0,
            ul_buffer            INTEGER NOT NULL DEFAULT 0,
            dl_acked_bytes       INTEGER NOT NULL DEFAULT 0,
            ul_ok_bytes          INTEGER NOT NULL DEFAULT 0,
            dl_harq_ack          INTEGER NOT NULL DEFAULT 0,
            dl_harq_nack         INTEGER NOT NULL DEFAULT 0,
            ul_crc_ok            INTEGER NOT NULL DEFAULT 0,
            ul_crc_fail          INTEGER NOT NULL DEFAULT 0,
            ce_delay_us          INTEGER NOT NULL DEFAULT 0,
            crc_delay_us         INTEGER NOT NULL DEFAULT 0,
            pucch_harq_delay_us  INTEGER NOT NULL DEFAULT 0,
            pusch_harq_delay_us  INTEGER NOT NULL DEFAULT 0,
            sr_to_pusch_delay_us INTEGER NOT NULL DEFAULT 0,
            sum_mac_delay_us     INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS observed_rnti (rnti INTEGER PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS idx_raw_tti_timestamp ON raw_tti(timestamp_us);
        CREATE INDEX IF NOT EXISTS idx_ue_mac_timestamp_rnti ON ue_mac(timestamp_us, rnti);
        """
    )
    legacy_raw_id = ensure_columns(database)
    database.execute(
        "INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    database.execute("PRAGMA optimize")
    database.commit()
    return database, legacy_raw_id


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
    parser.add_argument(
        "--store-raw",
        action="store_true",
        help="Also persist the full protobuf payload for every TTI. Roughly triples database "
             "size and nothing currently reads it; enable only to recover a field ue_mac "
             "does not project.",
    )
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
    database, legacy_raw_id = open_database(database_path)
    # v1 tables declared raw_tti_id NOT NULL; see ensure_columns.
    no_raw_id = 0 if legacy_raw_id else None

    context = zmq.Context()
    subscriber = context.socket(zmq.SUB)
    subscriber.setsockopt(zmq.RCVHWM, 100_000)
    subscriber.setsockopt(zmq.RCVTIMEO, 500)
    subscriber.setsockopt_string(zmq.SUBSCRIBE, "")
    subscriber.connect(args.address)

    messages = missed_ttis = parse_errors = pending = ue_samples = 0
    observed_rntis: set[int] = set()
    last_tti = None
    last_timestamp_us = 0
    first_timestamp_us = 0
    last_commit = time.monotonic()
    raw_note = "storing raw payloads" if args.store_raw else "ue_mac only"
    print(
        f"Metrics recorder for {run_id} connected to {args.address}; "
        f"writing {database_path} (schema v{SCHEMA_VERSION}, {raw_note})",
        flush=True,
    )

    def commit_stats():
        values = {
            "messages": messages,
            "missed_ttis": missed_ttis,
            "parse_errors": parse_errors,
            "ue_samples": ue_samples,
            "first_timestamp_us": first_timestamp_us,
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
            if not first_timestamp_us:
                first_timestamp_us = timestamp_us
            tti_index = int(message.tti_index)
            if last_tti is not None:
                delta = (tti_index - last_tti) % 10_000
                if delta > 1:
                    missed_ttis += delta - 1
            last_tti = tti_index

            raw_tti_id = no_raw_id
            if args.store_raw:
                received_at_us = time.time_ns() // 1000
                cursor = database.execute(
                    "INSERT INTO raw_tti(timestamp_us, received_at_us, tti_index, payload) "
                    "VALUES (?, ?, ?, ?)",
                    (timestamp_us, received_at_us, tti_index, sqlite3.Binary(payload)),
                )
                raw_tti_id = cursor.lastrowid

            database.executemany(
                INSERT_UE_MAC,
                [ue_mac_row(raw_tti_id, timestamp_us, tti_index, ue) for ue in message.ues],
            )
            ue_samples += len(message.ues)
            for ue in message.ues:
                rnti = int(ue.rnti)
                if rnti not in observed_rntis:
                    observed_rntis.add(rnti)
                    database.execute("INSERT OR IGNORE INTO observed_rnti(rnti) VALUES (?)", (rnti,))

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
        print(
            f"Metrics recorder stopped: {messages} messages, {ue_samples} UE samples, "
            f"{missed_ttis} inferred missing TTIs",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
