"""Deterministic analysis helpers for the normalized HARQ event ledger."""

from dataclasses import dataclass
import sqlite3
from typing import Iterable, Sequence


SUCCESS_OUTCOMES = frozenset({"ack", "crc_ok", "ack_on_timeout"})
FAILURE_OUTCOMES = frozenset({"nack", "crc_fail", "dtx_timeout", "retx_timeout"})


@dataclass(frozen=True)
class HarqEvent:
    sequence_id: int
    timestamp_us: int
    cell_index: int
    du_ue_index: int
    rnti: int
    direction: str
    tx_slot: int
    feedback_slot: int
    harq_id: int
    attempt_number: int
    is_retransmission: bool
    ndi: bool
    outcome: str
    tbs_bytes: int

    @property
    def is_initial_attempt(self) -> bool:
        return self.attempt_number == 0 and not self.is_retransmission

    @property
    def succeeded(self) -> bool:
        return self.outcome in SUCCESS_OUTCOMES


@dataclass(frozen=True)
class SlotObservation:
    native_slot: int
    timestamp_us: int
    numerology: int
    slot_duration_ns: int


@dataclass(frozen=True)
class SuccessProbability:
    successes: int
    failures: int
    total_transmissions: int
    probability: float | None


@dataclass(frozen=True)
class AoiPoint:
    native_slot: int
    timestamp_us: int
    attempted: bool
    success: bool
    age_slots: int
    age_ns: int


def load_harq_events(
    database: sqlite3.Connection,
    *,
    cell_index: int | None = None,
    du_ue_index: int | None = None,
    rnti: int | None = None,
    direction: str | None = None,
    initial_only: bool = False,
) -> list[HarqEvent]:
    """Load a stable, slot-ordered slice of the immutable HARQ ledger."""
    predicates: list[str] = []
    parameters: list[int | str] = []
    for column, value in (
        ("cell_index", cell_index),
        ("du_ue_index", du_ue_index),
        ("rnti", rnti),
        ("direction", direction),
    ):
        if value is not None:
            predicates.append(f"{column} = ?")
            parameters.append(value)
    if initial_only:
        predicates.append("attempt_number = 0 AND is_retransmission = 0")
    where = f" WHERE {' AND '.join(predicates)}" if predicates else ""
    rows = database.execute(
        "SELECT sequence_id, timestamp_us, cell_index, du_ue_index, rnti, direction, "
        "tx_slot, feedback_slot, harq_id, attempt_number, is_retransmission, ndi, outcome, tbs_bytes "
        f"FROM harq_outcome{where} ORDER BY tx_slot, sequence_id",
        parameters,
    )
    return [
        HarqEvent(
            sequence_id=row[0], timestamp_us=row[1], cell_index=row[2], du_ue_index=row[3],
            rnti=row[4], direction=row[5], tx_slot=row[6], feedback_slot=row[7],
            harq_id=row[8], attempt_number=row[9], is_retransmission=bool(row[10]),
            ndi=bool(row[11]), outcome=row[12], tbs_bytes=row[13],
        )
        for row in rows
    ]


def load_ue_slots(
    database: sqlite3.Connection,
    rnti: int,
    *,
    start_slot: int | None = None,
    end_slot: int | None = None,
) -> list[SlotObservation]:
    """Load only slots where the UE was present, excluding disconnected time.

    Presence is keyed by RNTI because TtiMetrics does not yet carry cell/DU UE identity for each
    slot. Callers must use this only for current single-cell runs and split RNTI lifecycles if a
    future archive can reuse the same RNTI during one run.
    """
    predicates = ["u.rnti = ?"]
    parameters: list[int] = [rnti]
    if start_slot is not None:
        predicates.append("s.native_slot >= ?")
        parameters.append(start_slot)
    if end_slot is not None:
        predicates.append("s.native_slot <= ?")
        parameters.append(end_slot)
    rows = database.execute(
        "SELECT s.native_slot, s.timestamp_us, s.numerology, s.slot_duration_ns "
        "FROM ue_slot_observation u JOIN slot_observation s USING (native_slot) "
        f"WHERE {' AND '.join(predicates)} ORDER BY s.native_slot",
        parameters,
    )
    return [SlotObservation(*row) for row in rows]


def success_probability(
    events: Iterable[HarqEvent], *, initial_only: bool = True
) -> SuccessProbability:
    """Compute TB success probability; absence of transmissions yields None, never zero."""
    selected = [event for event in events if not initial_only or event.is_initial_attempt]
    successes = sum(event.succeeded for event in selected)
    failures = sum(event.outcome in FAILURE_OUTCOMES for event in selected)
    if successes + failures != len(selected):
        unknown = sorted({event.outcome for event in selected} - SUCCESS_OUTCOMES - FAILURE_OUTCOMES)
        raise ValueError(f"unrecognized terminal HARQ outcomes: {unknown}")
    total = successes + failures
    return SuccessProbability(
        successes=successes,
        failures=failures,
        total_transmissions=total,
        probability=successes / total if total else None,
    )


def derive_aoi(
    events: Iterable[HarqEvent],
    observed_slots: Sequence[SlotObservation],
    *,
    initial_age_slots: int = 1,
) -> list[AoiPoint]:
    """Derive retrospective slot AoI over slots where the UE was present.

    Each returned value is a(t+1), after applying the initial-transmission outcome for slot t.
    A slot succeeds if at least one initial TB in that slot succeeds. Unscheduled slots and failed
    initial attempts both increase age. Capture sequence gaps must be checked separately before an
    archive is accepted for scientific analysis.
    """
    if initial_age_slots < 1:
        raise ValueError("initial_age_slots must be at least one")
    slots = list(observed_slots)
    if any(current.native_slot <= previous.native_slot for previous, current in zip(slots, slots[1:])):
        raise ValueError("observed_slots must be strictly increasing")

    initial_events = [event for event in events if event.is_initial_attempt]
    attempts_by_slot: dict[int, list[HarqEvent]] = {}
    for event in initial_events:
        attempts_by_slot.setdefault(event.tx_slot, []).append(event)

    points: list[AoiPoint] = []
    age_slots = initial_age_slots
    age_ns = initial_age_slots * slots[0].slot_duration_ns if slots else 0
    for slot in slots:
        attempts = attempts_by_slot.get(slot.native_slot, [])
        succeeded = any(event.succeeded for event in attempts)
        if succeeded:
            age_slots = 1
            age_ns = slot.slot_duration_ns
        else:
            age_slots += 1
            age_ns += slot.slot_duration_ns
        points.append(
            AoiPoint(
                native_slot=slot.native_slot,
                timestamp_us=slot.timestamp_us,
                attempted=bool(attempts),
                success=succeeded,
                age_slots=age_slots,
                age_ns=age_ns,
            )
        )
    return points
