#!/usr/bin/env python3
"""EdgeRIC scheduler runner: plugin policy -> binary UL/DL eligibility."""

import argparse
import signal
import time

import redis

from edgeric_messenger import cleanup, get_metrics_multi, send_scheduling_eligibility
from scheduler_plugins import ALGORITHMS, create

DEFAULT_ALGORITHM = "Proportional Fair"
ALGORITHM_KEY = "scheduling_algorithm"
EPOCH_KEY = "scheduling_policy_epoch"
LIMIT_KEY = "scheduling_max_ues"

# Kept as an explicit literal so the dashboard's registry drift test can audit it.
algorithm_mapping = {
    "Fixed Weight": "FixedWeight",
    "Max CQI": "MaxCqi",
    "Max Weight": "MaxWeight",
    "Proportional Fair": "ProportionalFair",
    "Round Robin": "RoundRobin",
}


def selected_policy(client, override, default_limit):
    if override:
        return override, 1, default_limit
    values = client.mget(ALGORITHM_KEY, EPOCH_KEY, LIMIT_KEY)
    algorithm = values[0] or DEFAULT_ALGORITHM
    try:
        epoch = max(int(values[1] or 1), 1)
    except ValueError:
        epoch = 1
    try:
        limit = max(min(int(values[2] or default_limit), 8), 1)
    except ValueError:
        limit = default_limit
    return algorithm, epoch, limit


def main():
    parser = argparse.ArgumentParser(description="EdgeRIC eligibility scheduler")
    parser.add_argument("--redis-host", default="127.0.0.1")
    parser.add_argument("--redis-port", type=int, default=6379)
    parser.add_argument("--algorithm", choices=tuple(ALGORITHMS))
    parser.add_argument("--max-selected", type=int, default=2)
    parser.add_argument("--policy-poll-ms", type=int, default=50)
    args = parser.parse_args()

    client = redis.Redis(host=args.redis_host, port=args.redis_port, db=0, decode_responses=True)
    client.ping()
    client.setnx(ALGORITHM_KEY, DEFAULT_ALGORITHM)
    client.setnx(EPOCH_KEY, 1)
    client.setnx(LIMIT_KEY, max(min(args.max_selected, 8), 1))

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    active_name = None
    active_epoch = 0
    scheduler = None
    limit = args.max_selected
    next_poll = 0.0
    decisions = 0
    print(f"[EdgeRIC] scheduler runner ready; available={list(ALGORITHMS)}", flush=True)

    try:
        while not stopping:
            metrics = get_metrics_multi()
            if not metrics:
                continue

            now = time.monotonic()
            if now >= next_poll or scheduler is None:
                name, epoch, limit = selected_policy(client, args.algorithm, args.max_selected)
                next_poll = now + args.policy_poll_ms / 1000.0
                if name not in ALGORITHMS:
                    print(f"[EdgeRIC] refusing unknown scheduler {name!r}; failing open", flush=True)
                    continue
                if name != active_name or epoch != active_epoch:
                    scheduler = create(name)
                    active_name, active_epoch = name, epoch
                    print(f"[EdgeRIC] policy epoch={epoch} algorithm={name!r} max_ues={limit}", flush=True)

            dl, ul = scheduler.select(metrics, min(limit, len(metrics)))
            send_scheduling_eligibility(dl, ul, active_name, active_epoch)
            decisions += 1
            if decisions % 2000 == 0:
                print(f"[EdgeRIC] decisions={decisions} epoch={active_epoch} DL={dl} UL={ul}", flush=True)
    finally:
        cleanup()
        print(f"[EdgeRIC] scheduler stopped after {decisions} decisions", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
