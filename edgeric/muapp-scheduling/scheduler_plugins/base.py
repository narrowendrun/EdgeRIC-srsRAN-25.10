"""Small, stable interface for EdgeRIC eligibility scheduler plugins."""

from abc import ABC, abstractmethod
from typing import Mapping

UeMetrics = Mapping[int, Mapping[str, float]]


class EligibilityScheduler(ABC):
    name: str

    def reset(self) -> None:
        """Forget state when a new policy epoch starts."""

    @abstractmethod
    def select(self, metrics: UeMetrics, limit: int) -> tuple[list[int], list[int]]:
        """Return (DL eligible RNTIs, UL eligible RNTIs)."""


def top(values: list[tuple[float, int]], limit: int) -> list[int]:
    return [rnti for _, rnti in sorted(values, key=lambda item: (-item[0], item[1]))[:limit]]
