#!/usr/bin/env python3
"""Persist received EdgeRIC TTI protobufs and chart-ready MAC fields."""

import argparse
import json
import signal
import sqlite3
import time
from pathlib import Path

import zmq

try:
    import metrics_pb2
except ModuleNotFoundError:  # Allow importing helpers as edgeric.metrics_recorder in tests/tools.
    from . import metrics_pb2

SCHEMA_VERSION = 4

# Projected MacUeMetrics fields, in ue_mac column order after the key columns.
# Delay fields are stored as microsecond integers plus explicit validity bits. This keeps old DB
# columns backward compatible while distinguishing an absent native optional from a true zero.
METRIC_COLUMNS = [
    "snr", "cqi",
    "dl_mcs", "ul_mcs", "dl_prbs", "ul_prbs", "dl_tbs", "ul_tbs", "dl_buffer", "ul_buffer",
    "dl_acked_bytes", "ul_ok_bytes",
    "dl_harq_ack", "dl_harq_nack", "ul_crc_ok", "ul_crc_fail",
    "ce_delay_us", "crc_delay_us", "pucch_harq_delay_us", "pusch_harq_delay_us",
    "sr_to_pusch_delay_us", "sum_mac_delay_us",
    "ce_delay_valid", "crc_delay_valid", "pucch_harq_delay_valid", "pusch_harq_delay_valid",
    "sr_to_pusch_delay_valid",
]
UE_MAC_COLUMNS = ["raw_tti_id", "timestamp_us", "tti_index", "native_slot", "rnti"] + METRIC_COLUMNS
INSERT_UE_MAC = (
    f"INSERT INTO ue_mac({', '.join(UE_MAC_COLUMNS)}) "
    f"VALUES ({', '.join('?' * len(UE_MAC_COLUMNS))})"
)

HARQ_EVENT_COLUMNS = [
    "sequence_id", "timestamp_us", "cell_index", "du_ue_index", "rnti", "direction", "tx_slot",
    "feedback_slot", "harq_id", "attempt_number", "is_retransmission", "ndi", "outcome",
    "tbs_bytes",
]
INSERT_HARQ_EVENT = (
    f"INSERT INTO harq_outcome({', '.join(HARQ_EVENT_COLUMNS)}) "
    f"VALUES ({', '.join('?' * len(HARQ_EVENT_COLUMNS))}) "
    "ON CONFLICT(sequence_id) DO NOTHING"
)

HARQ_DIRECTIONS = {"DL": "dl", "UL": "ul"}
HARQ_OUTCOMES = {
    "ACK": "ack",
    "NACK": "nack",
    "CRC_OK": "crc_ok",
    "CRC_FAIL": "crc_fail",
    "DTX_TIMEOUT": "dtx_timeout",
    "RETX_TIMEOUT": "retx_timeout",
    "ACK_ON_TIMEOUT": "ack_on_timeout",
}


def _enum_name(message, field_name: str) -> str:
    """Return an enum field's symbolic name without depending on generated wrapper names."""
    value = getattr(message, field_name)
    if isinstance(value, str):
        return value
    field = message.DESCRIPTOR.fields_by_name[field_name]
    enum_value = field.enum_type.values_by_number.get(int(value))
    if enum_value is None:
        raise ValueError(f"unknown {field_name} enum value {value}")
    return enum_value.name


def _canonical_enum(name: str, supported: dict[str, str], field_name: str) -> str:
    """Accept concise enum names and generated names carrying a common prefix."""
    for suffix, canonical in supported.items():
        if name == suffix or name.endswith(f"_{suffix}"):
            return canonical
    raise ValueError(f"unsupported HARQ {field_name} {name!r}")


def harq_event_row(timestamp_us: int, event) -> tuple:
    """Project one terminal HarqEvent into the normalized v3 ledger row."""
    direction = _canonical_enum(_enum_name(event, "direction"), HARQ_DIRECTIONS, "direction")
    outcome = _canonical_enum(_enum_name(event, "outcome"), HARQ_OUTCOMES, "outcome")
    attempt_number = int(event.attempt_number)
    is_retransmission = bool(event.is_retransmission)
    if attempt_number < 0:
        raise ValueError("HARQ attempt_number cannot be negative")
    if (attempt_number == 0) == is_retransmission:
        raise ValueError(
            "HARQ attempt_number and is_retransmission disagree "
            f"({attempt_number}, {is_retransmission})"
        )
    if direction == "dl" and outcome not in {
        "ack", "nack", "dtx_timeout", "retx_timeout", "ack_on_timeout"
    }:
        raise ValueError(f"DL HARQ event has incompatible outcome {outcome!r}")
    if direction == "ul" and outcome not in {"crc_ok", "crc_fail", "dtx_timeout", "retx_timeout"}:
        raise ValueError(f"UL HARQ event has incompatible outcome {outcome!r}")
    if int(event.feedback_slot) < int(event.tx_slot):
        raise ValueError("HARQ feedback_slot cannot precede tx_slot")
    return (
        int(event.sequence_id), int(timestamp_us), int(event.cell_index), int(event.du_ue_index),
        int(event.rnti), direction, int(event.tx_slot), int(event.feedback_slot), int(event.harq_id), attempt_number,
        int(is_retransmission), int(event.ndi), outcome, int(event.tbs_bytes),
    )


def insert_harq_events(database: sqlite3.Connection, timestamp_us: int, events) -> tuple[int, int]:
    """Insert events idempotently and return their (stored, rejected) counts."""
    stored = rejected = 0
    for event in events:
        try:
            row = harq_event_row(timestamp_us, event)
        except (AttributeError, KeyError, TypeError, ValueError):
            rejected += 1
            continue
        try:
            cursor = database.execute(INSERT_HARQ_EVENT, row)
        except sqlite3.IntegrityError:
            rejected += 1
            continue
        stored += max(cursor.rowcount, 0)
    return stored, rejected


def ue_mac_row(raw_tti_id, timestamp_us: int, tti_index: int, native_slot: int, ue) -> tuple:
    """Project one UeMetrics message into an ue_mac row."""
    mac = ue.mac
    delay_fields = (
        "avg_ce_delay_ms", "avg_crc_delay_ms", "avg_pucch_harq_delay_ms",
        "avg_pusch_harq_delay_ms", "avg_sr_to_pusch_delay_ms",
    )
    delay_present = tuple(mac.HasField(field) for field in delay_fields)
    delay_us = tuple(
        round(getattr(mac, field) * 1000) if present else 0
        for field, present in zip(delay_fields, delay_present)
    )
    return (
        raw_tti_id, timestamp_us, tti_index, native_slot, int(ue.rnti),
        float(mac.snr), int(mac.cqi),
        int(mac.dl_mcs), int(mac.ul_mcs), int(mac.dl_prbs), int(mac.ul_prbs),
        int(mac.dl_tbs), int(mac.ul_tbs), int(mac.dl_buffer), int(mac.ul_buffer),
        int(mac.dl_acked_bytes), int(mac.ul_ok_bytes),
        int(mac.dl_harq_ack), int(mac.dl_harq_nack), int(mac.ul_crc_ok), int(mac.ul_crc_fail),
        *delay_us,
        0,  # Deprecated synthetic sum: retained only as a backward-compatible DB column.
        *(int(present) for present in delay_present),
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
    if "native_slot" not in present:
        # Historical rows predate absolute native slots, so their value must remain unknown.
        database.execute("ALTER TABLE ue_mac ADD COLUMN native_slot INTEGER")
        print("Added missing ue_mac column: native_slot", flush=True)
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
            native_slot          INTEGER NOT NULL,
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
            sum_mac_delay_us     INTEGER NOT NULL DEFAULT 0,
            ce_delay_valid          INTEGER NOT NULL DEFAULT 0 CHECK (ce_delay_valid IN (0, 1)),
            crc_delay_valid         INTEGER NOT NULL DEFAULT 0 CHECK (crc_delay_valid IN (0, 1)),
            pucch_harq_delay_valid  INTEGER NOT NULL DEFAULT 0 CHECK (pucch_harq_delay_valid IN (0, 1)),
            pusch_harq_delay_valid  INTEGER NOT NULL DEFAULT 0 CHECK (pusch_harq_delay_valid IN (0, 1)),
            sr_to_pusch_delay_valid INTEGER NOT NULL DEFAULT 0 CHECK (sr_to_pusch_delay_valid IN (0, 1))
        );
        CREATE TABLE IF NOT EXISTS capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS observed_rnti (rnti INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS slot_observation (
            native_slot        INTEGER PRIMARY KEY,
            message_sequence_id INTEGER NOT NULL UNIQUE,
            timestamp_us       INTEGER NOT NULL,
            tti_index          INTEGER NOT NULL,
            numerology         INTEGER NOT NULL CHECK (numerology >= 0),
            slot_duration_ns   INTEGER NOT NULL CHECK (slot_duration_ns > 0),
            scheduler_policy_epoch INTEGER NOT NULL DEFAULT 0,
            scheduler_algorithm TEXT NOT NULL DEFAULT '',
            scheduler_control_active INTEGER NOT NULL DEFAULT 0 CHECK (scheduler_control_active IN (0, 1)),
            dl_eligible_rntis TEXT NOT NULL DEFAULT '[]',
            ul_eligible_rntis TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE IF NOT EXISTS ue_slot_observation (
            -- TtiMetrics currently has no top-level cell/DU UE identity. This presence map is
            -- therefore deliberately scoped to the workbench's current single-cell OTA runs.
            native_slot INTEGER NOT NULL,
            rnti        INTEGER NOT NULL,
            PRIMARY KEY (native_slot, rnti),
            FOREIGN KEY (native_slot) REFERENCES slot_observation(native_slot)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS harq_outcome (
            id                INTEGER PRIMARY KEY,
            sequence_id       INTEGER NOT NULL UNIQUE,
            timestamp_us      INTEGER NOT NULL,
            cell_index        INTEGER NOT NULL,
            du_ue_index       INTEGER NOT NULL,
            rnti              INTEGER NOT NULL,
            direction         TEXT    NOT NULL CHECK (direction IN ('dl', 'ul')),
            tx_slot           INTEGER NOT NULL,
            feedback_slot     INTEGER NOT NULL,
            harq_id           INTEGER NOT NULL,
            attempt_number    INTEGER NOT NULL CHECK (attempt_number >= 0),
            is_retransmission INTEGER NOT NULL CHECK (is_retransmission IN (0, 1)),
            ndi               INTEGER NOT NULL CHECK (ndi IN (0, 1)),
            outcome           TEXT    NOT NULL CHECK (
                outcome IN (
                    'ack', 'nack', 'crc_ok', 'crc_fail', 'dtx_timeout', 'retx_timeout',
                    'ack_on_timeout'
                )
            ),
            tbs_bytes         INTEGER NOT NULL CHECK (tbs_bytes >= 0),
            CHECK (
                (attempt_number = 0 AND is_retransmission = 0) OR
                (attempt_number > 0 AND is_retransmission = 1)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_raw_tti_timestamp ON raw_tti(timestamp_us);
        CREATE INDEX IF NOT EXISTS idx_ue_mac_timestamp_rnti ON ue_mac(timestamp_us, rnti);
        CREATE INDEX IF NOT EXISTS idx_ue_slot_observation_rnti_slot
            ON ue_slot_observation(rnti, native_slot);
        CREATE INDEX IF NOT EXISTS idx_slot_observation_timestamp
            ON slot_observation(timestamp_us, native_slot);
        CREATE INDEX IF NOT EXISTS idx_harq_outcome_rnti_direction_tx
            ON harq_outcome(rnti, direction, tx_slot);
        CREATE INDEX IF NOT EXISTS idx_harq_outcome_ue_slot
            ON harq_outcome(cell_index, du_ue_index, direction, tx_slot);
        CREATE INDEX IF NOT EXISTS idx_harq_outcome_feedback_slot
            ON harq_outcome(feedback_slot);
        """
    )
    legacy_raw_id = ensure_columns(database)
    slot_columns = {row[1] for row in database.execute("PRAGMA table_info(slot_observation)")}
    additions = {
        "scheduler_policy_epoch": "INTEGER NOT NULL DEFAULT 0",
        "scheduler_algorithm": "TEXT NOT NULL DEFAULT ''",
        "scheduler_control_active": "INTEGER NOT NULL DEFAULT 0",
        "dl_eligible_rntis": "TEXT NOT NULL DEFAULT '[]'",
        "ul_eligible_rntis": "TEXT NOT NULL DEFAULT '[]'",
    }
    for column, declaration in additions.items():
        if column not in slot_columns:
            database.execute(f"ALTER TABLE slot_observation ADD COLUMN {column} {declaration}")
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


def read_active_run(active_file: Path) -> tuple[str, Path] | None:
    try:
        active = json.loads(active_file.read_text(encoding="utf-8"))
        run_id = active["runId"]
        run_dir = Path(active["runDir"]).resolve()
        if run_dir.is_dir() and run_dir.name == run_id:
            return run_id, run_dir
    except (OSError, KeyError, TypeError, ValueError):
        pass
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Record EdgeRIC metrics to a per-run SQLite database")
    parser.add_argument("--address", default="ipc:///tmp/metrics_data")
    parser.add_argument("--active-run-file", required=True)
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--scheduler-state-file", default="/tmp/edgeric_scheduler_state.json")
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

    messages = missed_ttis = parse_errors = contract_errors = pending = ue_samples = 0
    harq_events_seen = harq_events_stored = harq_event_errors = 0
    harq_sequence_gaps = harq_sequence_reorders = 0
    message_sequence_gaps = message_sequence_reorders = duplicate_messages = 0
    observed_rntis: set[int] = set()
    last_tti = None
    last_message_sequence_id = None
    last_harq_sequence_id = None
    first_message_sequence_id = None
    last_timestamp_us = 0
    first_timestamp_us = 0
    sequence_starts_at_zero = 1
    last_commit = time.monotonic()
    next_run_check = 0.0
    last_scheduler_state = None
    last_scheduler_state_write = 0.0
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
            "contract_errors": contract_errors,
            "ue_samples": ue_samples,
            "harq_events_seen": harq_events_seen,
            "harq_events_stored": harq_events_stored,
            "harq_event_errors": harq_event_errors,
            "harq_sequence_gaps": harq_sequence_gaps,
            "harq_sequence_reorders": harq_sequence_reorders,
            "message_sequence_gaps": message_sequence_gaps,
            "message_sequence_reorders": message_sequence_reorders,
            "duplicate_messages": duplicate_messages,
            "first_message_sequence_id": first_message_sequence_id or 0,
            "last_message_sequence_id": last_message_sequence_id or 0,
            "first_timestamp_us": first_timestamp_us,
            "last_timestamp_us": last_timestamp_us,
            "sequence_starts_at_zero": sequence_starts_at_zero,
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

            now = time.monotonic()
            if now >= next_run_check:
                next_run_check = now + 0.05
                next_run = read_active_run(Path(args.active_run_file))
                if next_run and next_run[0] != run_id:
                    commit_stats()
                    database.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    database.close()
                    run_id, run_dir = next_run
                    database_path = run_dir / "metrics.sqlite3"
                    database, legacy_raw_id = open_database(database_path)
                    no_raw_id = 0 if legacy_raw_id else None
                    messages = missed_ttis = parse_errors = contract_errors = pending = ue_samples = 0
                    harq_events_seen = harq_events_stored = harq_event_errors = 0
                    harq_sequence_gaps = harq_sequence_reorders = 0
                    message_sequence_gaps = message_sequence_reorders = duplicate_messages = 0
                    observed_rntis = set()
                    last_tti = last_message_sequence_id = last_harq_sequence_id = None
                    first_message_sequence_id = None
                    last_timestamp_us = first_timestamp_us = 0
                    sequence_starts_at_zero = 0
                    last_commit = now
                    print(f"Metrics recorder rotated losslessly to {run_id}: {database_path}", flush=True)

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
            native_slot = int(message.native_slot)
            numerology = int(message.numerology)
            slot_duration_ns = int(message.slot_duration_ns)
            message_sequence_id = int(message.message_sequence_id)
            scheduler_policy_epoch = int(message.scheduler_policy_epoch)
            scheduler_algorithm = str(message.scheduler_algorithm)
            scheduler_control_active = bool(message.scheduler_control_active)
            dl_eligible = [int(value) for value in message.dl_eligible_rntis]
            ul_eligible = [int(value) for value in message.ul_eligible_rntis]
            expected_slot_duration_ns = 1_000_000 // (1 << numerology) if 0 <= numerology <= 4 else 0
            if slot_duration_ns <= 0 or slot_duration_ns != expected_slot_duration_ns:
                contract_errors += 1
                pending += 1
                if contract_errors == 1:
                    print(
                        "Metrics publisher is missing or has invalid native slot metadata; "
                        "refusing messages that cannot support trustworthy AoI",
                        flush=True,
                    )
                continue
            if first_message_sequence_id is None:
                first_message_sequence_id = message_sequence_id
            if last_message_sequence_id is not None:
                if message_sequence_id > last_message_sequence_id + 1:
                    message_sequence_gaps += message_sequence_id - last_message_sequence_id - 1
                elif message_sequence_id <= last_message_sequence_id:
                    message_sequence_reorders += 1
            last_message_sequence_id = max(last_message_sequence_id or 0, message_sequence_id)
            if last_tti is not None:
                delta = (tti_index - last_tti) % 10_000
                if delta > 1:
                    missed_ttis += delta - 1
            last_tti = tti_index

            cursor = database.execute(
                "INSERT INTO slot_observation("
                "native_slot, message_sequence_id, timestamp_us, tti_index, numerology, slot_duration_ns, "
                "scheduler_policy_epoch, scheduler_algorithm, scheduler_control_active, "
                "dl_eligible_rntis, ul_eligible_rntis"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                (native_slot, message_sequence_id, timestamp_us, tti_index, numerology, slot_duration_ns,
                 scheduler_policy_epoch, scheduler_algorithm, int(scheduler_control_active),
                 json.dumps(dl_eligible), json.dumps(ul_eligible)),
            )
            if cursor.rowcount == 0:
                duplicate_messages += 1
                messages += 1
                pending += 1
                continue

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
                [ue_mac_row(raw_tti_id, timestamp_us, tti_index, native_slot, ue) for ue in message.ues],
            )
            database.executemany(
                "INSERT OR IGNORE INTO ue_slot_observation(native_slot, rnti) VALUES (?, ?)",
                [(native_slot, int(ue.rnti)) for ue in message.ues],
            )
            harq_events = message.harq_events
            for event in harq_events:
                sequence_id = int(event.sequence_id)
                if last_harq_sequence_id is not None:
                    if sequence_id > last_harq_sequence_id + 1:
                        harq_sequence_gaps += sequence_id - last_harq_sequence_id - 1
                    elif sequence_id <= last_harq_sequence_id:
                        harq_sequence_reorders += 1
                last_harq_sequence_id = max(last_harq_sequence_id or 0, sequence_id)
            stored, rejected = insert_harq_events(database, timestamp_us, harq_events)
            harq_events_seen += len(harq_events)
            harq_events_stored += stored
            harq_event_errors += rejected
            ue_samples += len(message.ues)
            for ue in message.ues:
                rnti = int(ue.rnti)
                if rnti not in observed_rntis:
                    observed_rntis.add(rnti)
                    database.execute("INSERT OR IGNORE INTO observed_rnti(rnti) VALUES (?)", (rnti,))

            messages += 1
            pending += 1
            now = time.monotonic()
            scheduler_state = (
                scheduler_policy_epoch, scheduler_algorithm, scheduler_control_active,
                tuple(dl_eligible), tuple(ul_eligible),
            )
            if scheduler_state != last_scheduler_state or now - last_scheduler_state_write >= 1.0:
                state_path = Path(args.scheduler_state_file)
                temporary = state_path.with_suffix(state_path.suffix + ".tmp")
                temporary.write_text(json.dumps({
                    "policyEpoch": scheduler_policy_epoch,
                    "algorithm": scheduler_algorithm,
                    "controlActive": scheduler_control_active,
                    "dlEligibleRntis": dl_eligible,
                    "ulEligibleRntis": ul_eligible,
                    "nativeSlot": native_slot,
                    "observedAt": timestamp_us,
                }), encoding="utf-8")
                temporary.replace(state_path)
                last_scheduler_state = scheduler_state
                last_scheduler_state_write = now
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
            f"{harq_events_stored}/{harq_events_seen} HARQ events stored, "
            f"{harq_event_errors} invalid HARQ events, {contract_errors} contract errors, "
            f"{message_sequence_gaps} message/{harq_sequence_gaps} HARQ sequence gaps, "
            f"{missed_ttis} inferred missing TTIs",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
