"""Pure state machine for variance-weighted deficit (VWD) scheduling.

This module intentionally has no ZMQ, Redis, or protobuf dependency.  The live
muApp and archive replay can therefore use exactly the same scheduling math.
HARQ results are consumed causally, at their feedback slot; the archive may
also build a separate retrospective transmission-slot AoI trace.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from math import sqrt
from typing import Iterable, Literal, Mapping

Direction = Literal["dl", "ul"]
Outcome = Literal[
    "ack", "nack", "crc_ok", "crc_fail", "dtx_timeout", "retx_timeout", "ack_on_timeout"
]


@dataclass(frozen=True)
class VwdTarget:
    """Fixed target statistics for one target epoch."""

    mean_success_rate: float
    temporal_variance: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.mean_success_rate <= 1.0:
            raise ValueError("mean_success_rate must be in [0, 1]")
        if self.temporal_variance <= 0.0:
            raise ValueError("temporal_variance must be positive")


@dataclass(frozen=True)
class ResolvedAttempt:
    """Terminal native HARQ result delivered to the scheduler."""

    sequence_id: int
    direction: Direction
    rnti: int
    tx_slot: int
    feedback_slot: int
    attempt_number: int
    outcome: Outcome

    @property
    def is_initial(self) -> bool:
        return self.attempt_number == 0

    @property
    def succeeded(self) -> bool:
        return self.outcome in {"ack", "crc_ok", "ack_on_timeout"}


@dataclass
class _UeState:
    epoch_slot: int
    age_slots: int = 1
    successes_in_epoch: int = 0
    attempts: deque[int] = field(default_factory=deque)


class VwdScheduler:
    """Causal VWD ranking over fixed target epochs.

    Changing targets starts a new epoch instead of retroactively substituting a
    new target into the paper's ``t * mu - cumulative_successes`` expression.
    """

    def __init__(
        self,
        direction: Direction,
        targets: Mapping[int, VwdTarget],
        max_selected: int,
        probability_window: int,
        epoch_slot: int = 0,
    ) -> None:
        if direction not in {"dl", "ul"}:
            raise ValueError("direction must be 'dl' or 'ul'")
        if max_selected <= 0:
            raise ValueError("max_selected must be positive")
        if probability_window <= 0:
            raise ValueError("probability_window must be positive")
        self.direction = direction
        self.max_selected = max_selected
        self.probability_window = probability_window
        self.targets = dict(targets)
        self._state = {
            rnti: _UeState(epoch_slot=epoch_slot, attempts=deque(maxlen=probability_window))
            for rnti in self.targets
        }
        self._last_slot: int | None = None
        self._last_event_sequence: int | None = None

    def start_target_epoch(self, slot: int, targets: Mapping[int, VwdTarget]) -> None:
        """Install fixed targets and reset only target-dependent deficit state."""

        previous = self._state
        self.targets = dict(targets)
        self._state = {}
        for rnti in self.targets:
            old = previous.get(rnti)
            attempts = deque(old.attempts if old else (), maxlen=self.probability_window)
            self._state[rnti] = _UeState(
                epoch_slot=slot,
                age_slots=old.age_slots if old else 1,
                attempts=attempts,
            )

    def observe_slot(self, slot: int, outcomes: Iterable[ResolvedAttempt] = ()) -> None:
        """Advance causal age and apply feedback available in ``slot`` exactly once."""

        if self._last_slot is not None and slot < self._last_slot:
            raise ValueError("slots must be observed monotonically")
        events = list(outcomes)
        validated_sequence = self._last_event_sequence
        for event in events:
            if validated_sequence is not None:
                if event.sequence_id == validated_sequence:
                    continue
                if event.sequence_id < validated_sequence:
                    raise ValueError("HARQ event sequence reordered")
                if event.sequence_id > validated_sequence + 1:
                    raise ValueError("HARQ event sequence gap")
            validated_sequence = event.sequence_id

        elapsed = 0 if self._last_slot is None else slot - self._last_slot
        if elapsed:
            for state in self._state.values():
                state.age_slots += elapsed
        self._last_slot = slot

        for event in events:
            if self._last_event_sequence is not None:
                if event.sequence_id == self._last_event_sequence:
                    # Idempotent replay of the most recently applied terminal event.
                    continue
            self._last_event_sequence = event.sequence_id
            if event.direction != self.direction or not event.is_initial:
                continue
            state = self._state.get(event.rnti)
            if state is None:
                continue
            success = int(event.succeeded)
            state.attempts.append(success)
            if success:
                # Feedback can arrive after a target refresh for a TB sent under the previous
                # target. It still refreshes causal AoI and informs the rolling channel estimate,
                # but it must not reduce the new target epoch's service deficit.
                if event.tx_slot >= state.epoch_slot:
                    state.successes_in_epoch += 1
                state.age_slots = 1

    def success_probability(self, rnti: int) -> float | None:
        attempts = self._state[rnti].attempts
        return sum(attempts) / len(attempts) if attempts else None

    def deficit(self, rnti: int, slot: int) -> float:
        target = self.targets[rnti]
        state = self._state[rnti]
        epoch_time = max(0, slot - state.epoch_slot + 1)
        return (
            epoch_time * target.mean_success_rate - state.successes_in_epoch
        ) / sqrt(target.temporal_variance)

    def select(self, slot: int, eligible_rntis: Iterable[int]) -> list[int]:
        """Return the top-M eligible UEs with deterministic RNTI tie-breaking."""

        eligible = [rnti for rnti in eligible_rntis if rnti in self.targets]
        eligible.sort(key=lambda rnti: (-self.deficit(rnti, slot), rnti))
        return eligible[: self.max_selected]

    def snapshot(self, slot: int) -> dict[int, dict[str, float | int | None]]:
        return {
            rnti: {
                "deficit": self.deficit(rnti, slot),
                "age_slots": state.age_slots,
                "success_probability": self.success_probability(rnti),
                "resolved_initial_attempts": len(state.attempts),
                "successes_in_epoch": state.successes_in_epoch,
            }
            for rnti, state in self._state.items()
        }
