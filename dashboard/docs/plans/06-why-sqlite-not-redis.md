# Plan 6 — Decision record: SQLite, not Redis, for metrics

**Question asked:** should the metric store be Redis instead of SQLite, or does it not matter?

**Answer:** it matters, and SQLite is the right choice. Redis would solve one real problem
(the blocked event loop) that has a cheaper fix, and would cost you the thing that makes this
archive useful for research.

**Recorded 2026-09-19** so this does not get re-litigated later.

---

## 1 — SQLite is nowhere near being a bottleneck

I built the plan 2 v2 schema and wrote through it with the recorder's exact pattern — WAL,
`synchronous=NORMAL`, commit every 250 rows or 250 ms:

| | Value |
|---|---|
| Benchmark write rate | **470,721 rows/s** (235,361 TTI/s) |
| Measured real ingest (run `20260918T230906Z4648`) | **1,988 rows/s** (2,197 msg/s) |
| **Headroom** | **235×** |

The write path runs at 0.4% of capacity. Redis would be faster in absolute terms, but choosing a
database to optimise something running at 0.4% utilisation is not engineering, it is shopping.

### This also settles the missed-TTI question

Run `20260918T233126Z2F69` inferred 38,658 missed TTIs out of 466,412 messages (8.3%). It is
tempting to read that as "the recorder can't keep up, we need something faster." With 235× write
headroom, that is not what is happening. The gaps come from somewhere in the ZMQ publish path —
publisher-side conflation, `RCVHWM` drops under a burst, or the gNB genuinely skipping TTIs — or
from protobuf parse time, not from the disk write. **Swapping the database would not move this
number.** Worth investigating on its own; see the note at the end.

## 2 — The one thing Redis would genuinely fix, and the cheaper fix for it

`node:sqlite`'s `DatabaseSync` has no async API, so every chart query blocks the whole Node event
loop for 0.265 s (5 m window) to 0.684 s (1 h window). A Redis client is async over a socket, so
the query would happen in another process and Node would stay responsive. That is a real
advantage and it is the only one on this list.

But it is an advantage of *being in another process*, not of *being Redis*. A
`node:worker_threads` worker holding its own `DatabaseSync` handle gets exactly the same benefit
for ~60 lines and no new daemon. That is now fix A in plan 5.1.

Worth noting Redis is also single-threaded: a `TS.RANGE … AGGREGATION avg` over 596,162 samples
is the same algorithmic work, it just blocks the Redis server instead of your dashboard. The win
is isolation, which the worker thread gives you for free.

## 3 — What you would lose

These are the ones that actually matter for a scheduling-research workflow.

**One self-contained file per run.** `logs/runs/<id>/metrics.sqlite3` can be `scp`'d to a laptop,
attached to a paper, opened with `sqlite3`, loaded by pandas, or diffed against another run.
Redis has no per-run artifact — persistence is a single global RDB/AOF snapshot of the entire
dataset. Exporting one run means writing an export tool, and you would probably export it to…
SQLite or CSV.

**Ad-hoc SQL.** You are going to want to ask questions like *"what was the MCS distribution when
DL buffer occupancy was above 50 kB?"* or *"give me the 95th percentile of PUSCH HARQ delay per
UE per minute."* That is a `SELECT` against a file. RedisTimeSeries gives you range queries with a
fixed aggregator set (`avg`, `min`, `max`, `sum`, `count`, …) and no joins. For evaluating a custom
scheduler this is the difference between an afternoon and a week.

**Bounded memory.** Redis is in-memory first. The reference run would be roughly 150 MB resident,
permanently, for every run you want to keep browsable. SQLite's 148 MB sits on disk and pages in
on demand. You already have a disk-growth problem (plan 5.2); converting it into a RAM problem is
not an improvement.

**Zero operational surface.** SQLite is a file. Redis is a daemon, a systemd unit, a port, a
memory limit, an eviction policy, a persistence policy, and a version to track. And the only
variant worth considering here — **RedisTimeSeries** — is not in the stock Ubuntu `redis-server`
package; it needs Redis Stack, which is a separate install. Plain Redis strings, hashes or streams
would be *worse* than SQLite for this workload, not better.

Against your stated goal — *"the simplest approach to solving problems rather than adding
unnecessary complexity"* — this is the whole argument.

## 4 — Redis already has a place in this stack, and it is the right one

It is already a declared dependency (`edgeric/requirements.txt`: `redis>=4.0.0`), though
`redis-server` is **not currently installed on this machine**. The one use is in the scheduling
muApp:

```
edgeric/muapp-scheduling/scheduling_muapp.py:381
    selected_algorithm = redis_db.get('scheduling_algorithm')
```

```bash
redis-cli SET scheduling_algorithm "Max CQI"
```

A single mutable key, polled by the scheduler, letting you switch algorithms at runtime without a
restart. That is a genuinely good fit: tiny, mutable, shared across processes, and worthless once
the run ends. It is currently optional — the code catches `ConnectionError`, warns, and continues.

**When you write your custom scheduler, this is where Redis earns its keep:** algorithm selection
and live parameter tuning (weights, thresholds, target BLER) that you want to change mid-run from
a shell or from the dashboard. That is a control plane, and it is the opposite of a metrics
archive in every relevant property.

If you want that surfaced in the dashboard later — a dropdown that sets `scheduling_algorithm`
and a few tunable parameter fields — that is a clean, small feature, and it is the correct reason
to install Redis on this box.

## 5 — When this decision should be revisited

Genuinely, if any of these become true:

- **Multiple independent processes need the live metric stream at low latency.** Today that is
  already solved better: `ipc:///tmp/metrics_data` is a ZMQ PUB socket, and the collector, the
  recorder, and any muApp all subscribe independently. Redis pub/sub would be a lateral move.
- **Ingest exceeds ~50,000 rows/s.** That is 25× your current load and would mean roughly 50 UEs.
  At that point re-measure rather than assume.
- **You need the dashboard to serve many concurrent viewers.** Single-user lab bench today.

None of these are close.

## Decision

**Keep SQLite.** Proceed with plans 2 through 4 as written. Take plan 5.1 fix A (worker thread) as
the answer to the event-loop problem. Revisit Redis as a *control plane* when the custom scheduler
lands, not as a metric store.

---

## Side note worth its own investigation

The 8.3% missed-TTI rate on run `20260918T233126Z2F69` versus 0.6% on run
`20260918T230906Z4648` is unexplained and is not a storage problem. Candidates, cheapest to check
first:

1. `missed_ttis` is inferred from `tti_index` gaps at the subscriber
   (`metrics_recorder.py:147-150`). Since the gNB publishes a *conflated latest-value* stream —
   the metric catalog says so explicitly in `metrics-query.ts:109` — some gap is expected by
   design and is not loss at all.
2. `RCVHWM` is 100,000 (`metrics_recorder.py:99`); a burst beyond that drops silently.
3. Protobuf `ParseFromString` on the main receive loop, at ~2,200 msg/s.

Worth an hour with a counter on each stage before drawing conclusions. Adding it to plan 5 as a
diagnostic rather than a fix, since right now we do not know which of the three it is — or whether
it is a problem at all.
