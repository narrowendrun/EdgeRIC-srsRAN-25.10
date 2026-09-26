"""Built-in policies. They select candidates; srsRAN allocates resources."""

from .base import EligibilityScheduler, UeMetrics, top


class FixedWeight(EligibilityScheduler):
    name = "Fixed Weight"

    def select(self, metrics: UeMetrics, limit: int):
        chosen = sorted(metrics)[:limit]
        return chosen, chosen


class MaxCqi(EligibilityScheduler):
    name = "Max CQI"

    def select(self, metrics: UeMetrics, limit: int):
        ranked = [(float(value.get("CQI", 0)), rnti) for rnti, value in metrics.items()]
        chosen = top(ranked, limit)
        return chosen, chosen


class MaxWeight(EligibilityScheduler):
    name = "Max Weight"

    def select(self, metrics: UeMetrics, limit: int):
        dl = top([(float(v.get("CQI", 0)) * max(float(v.get("dl_buffer", 0)), 1), r) for r, v in metrics.items()], limit)
        ul = top([(float(v.get("CQI", 0)) * max(float(v.get("ul_buffer", 0)), 1), r) for r, v in metrics.items()], limit)
        return dl, ul


class ProportionalFair(EligibilityScheduler):
    name = "Proportional Fair"

    def __init__(self):
        self.reset()

    def reset(self):
        self.dl_average: dict[int, float] = {}
        self.ul_average: dict[int, float] = {}

    def select(self, metrics: UeMetrics, limit: int):
        alpha = 0.01
        dl_ranked, ul_ranked = [], []
        for rnti, value in metrics.items():
            dl_rate = max(float(value.get("dl_tbs", 0)), 0.0)
            ul_rate = max(float(value.get("ul_tbs", 0)), 0.0)
            dl_avg = self.dl_average.get(rnti, max(dl_rate, 1.0))
            ul_avg = self.ul_average.get(rnti, max(ul_rate, 1.0))
            instantaneous = max(float(value.get("CQI", 0)), 0.01)
            dl_ranked.append((instantaneous / max(dl_avg, 1.0), rnti))
            ul_ranked.append((instantaneous / max(ul_avg, 1.0), rnti))
            self.dl_average[rnti] = (1 - alpha) * dl_avg + alpha * dl_rate
            self.ul_average[rnti] = (1 - alpha) * ul_avg + alpha * ul_rate
        return top(dl_ranked, limit), top(ul_ranked, limit)


class RoundRobin(EligibilityScheduler):
    name = "Round Robin"

    def __init__(self):
        self.reset()

    def reset(self):
        self.offset = 0

    def select(self, metrics: UeMetrics, limit: int):
        rntis = sorted(metrics)
        if not rntis:
            return [], []
        chosen = [rntis[(self.offset + index) % len(rntis)] for index in range(min(limit, len(rntis)))]
        self.offset = (self.offset + 1) % len(rntis)
        return chosen, chosen


BUILTINS = [FixedWeight, MaxCqi, MaxWeight, ProportionalFair, RoundRobin]
