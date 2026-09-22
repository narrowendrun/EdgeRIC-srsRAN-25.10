# Dashboard implementation plans

Written 2026-09-19 after a read-only audit of `dashboard/` (~1550 lines), `edgeric/metrics_recorder.py`,
`edgeric/protobufs/metrics.proto`, and the two runs in `logs/runs/`.

Nothing in these plans has been implemented. Each file is self-contained and can be approved,
deferred, or rejected on its own.

## Ordering

| # | Plan | Why this position | Rough size |
|---|------|-------------------|-----------|
| 1 | [Correctness and crash safety](01-correctness-and-crash-safety.md) | Every run recorded today loses its manifest stats. Independent of the telemetry work; no design decisions. | ~150 lines changed |
| 2 | [Recorder schema v2](02-recorder-schema-v2.md) | **Blocks the telemetry overhaul** — MCS is not currently captured at all. Also halves database size. | ~120 lines changed |
| 3 | [Metric registry](03-metric-registry.md) | Pure refactor, no behaviour change. Makes plan 4 small. | ~200 lines, mostly new |
| 4 | [Telemetry section](04-telemetry-section.md) | The overhaul you asked for: metric picker, numeric vs chart display. | ~450 lines, mostly new |
| 5 | [Follow-ups](05-followups.md) | Worker-thread query offload, log retention, gNB config tab, de-hardcoding, tests. | Pick and choose |
| — | [Why SQLite, not Redis](06-why-sqlite-not-redis.md) | Decision record answering the storage question. No work attached. | — |
| 7 | [Scheduler control and notes](07-scheduler-control-and-notes.md) | Redis scheduler dropdown, sample-weighting decision, metric notes tab. | ~320 lines |

Plans 1 and 2 are worth doing before the next OTA session regardless of whether the telemetry
work proceeds — see "Why now" in each.

## Implementation waves

Four waves, plus a prerequisite. Sequential — one codebase, hard dependencies (2 → 3 → 4), one
reviewer. Each wave ends in a state you could stop at and be better off, with wave 2 the honest
exception (its benefit is structural, not visible).

### Wave 0 — Make the work revertible

`dashboard/`, `edgeric/metrics_recorder.py` and `gnb_rf_x310_tdd_n78_20mhz.yml` were untracked, so
a "wave" was not a meaningful boundary — nothing to revert, diff, or bisect into. Also untracked
the 2,739 `edgeric/venv/` files and 1,255 `__pycache__` files (about half of the 8,154 tracked
files), which were burying every real diff in bytecode churn.

Done. Everything below assumes you can roll back a wave that misbehaves mid-session.

### Wave 1 — Trust the data

Plans **1** and **2**, plus item 1 of **5.2** (drop the collector firehose from log capture).

Two internal checkpoints, because the risk profiles differ sharply:

- **1a** — plan 1. Dashboard server only; cannot corrupt recorded data. Verify, then proceed.
- **1b** — plan 2 + 5.2 item 1. Touches the recorder, the one component where a mistake costs an
  OTA session. Finish with one short verification run to confirm MCS lands.

Ends deployable with the UI unchanged but: run statistics recorded correctly, MCS / PRBs / buffers
/ TBS captured for the first time, databases ~66% smaller, disk rate down from ~38 MB/min to
roughly a third. **~280 lines.**

### Wave 2 — Invisible infrastructure

Plan **3** (metric registry) + plan **5.1 fix A** (worker-thread query offload).

No visible payoff by design — the dashboard should look pixel-identical when this lands, and its
acceptance test is a before/after screenshot diff. Kept separate from wave 3 so that when
something looks wrong you know whether the refactor or the feature caused it.

The worker thread belongs here rather than in wave 4 because **plan 4 adds a second summary query
per poll**, making event-loop blocking worse before plan 5 would make it better. Unblock the loop
first. **~260 lines.**

### Wave 3 — The telemetry overhaul

Plan **4**. Metric picker, numeric tiles with live/min/max/avg, chart grouping. Waves 1–2 exist to
make this a small, safe diff. **~450 lines, mostly new files.**

### Wave 4 — Polish

Remainder of plan **5**: retention and disk guard, gNB config tab, de-hardcoding the RF panel,
tests, small cleanups. Batches A/B/C in that plan are already grouped by theme.

### Why four

Five (one per plan) would split plan 3 into a wave that delivers nothing on its own. Three
(merging 2 into 3) would lose the "prove nothing changed" checkpoint that makes the refactor safe.
Four is the smallest count where every boundary is a real milestone.


## Principles carried through all five

1. **Capture is not display.** The recorder always writes every field it parses. Metric selection
   is a read-side concern only. This keeps archives complete, comparable, and reproducible, and
   removes any possibility of the UI and the recorder disagreeing about what is being captured.
2. **One registry, many consumers.** A single declarative list of metrics drives the recorder
   columns, the SQL projection, the chart cards, the numeric tiles, and the picker. No metric is
   ever named in more than one place.
3. **No new dependencies.** Everything below is achievable with what is already in
   `package.json` and `edgeric/requirements.txt`.
4. **Old archives keep working.** Readers detect available columns rather than assuming them, so
   the two runs already in `logs/runs/` stay viewable.

## Constraints to respect

- `edgeric-dashboard.service` runs under `ProtectSystem=strict` with `ReadOnlyPaths=$PROJECT_ROOT`
  and `ReadWritePaths=$PROJECT_ROOT/logs`. The server may only write under `logs/`.
- `node:sqlite` (`DatabaseSync`) has **no async API** in Node 22. Every query blocks the event loop.
  Query cost is a latency budget for the whole server, not just for charts.
- `tsconfig.server.json` sets `rootDir: "server"`, so server code cannot import from a sibling
  `shared/` directory without also changing `outDir` layout and the `ExecStart=` line in
  `systemd/edgeric-dashboard.service.in`. Plan 3 works around this rather than fighting it.
- The dashboard unit's `ExecStart` points at `dist-server/index.js`. Keep that path stable.

## Measurements these plans are based on

Taken from `logs/runs/20260918T230906Z4648` (a 14-minute run, 2 UEs):

| Thing | Value |
|---|---|
| Run directory total | 535 MB |
| `metrics.sqlite3` | 438 MB |
| — of which `raw_tti.payload` BLOBs | 239 MB (55%) |
| `edgeric.log` | 121 MB |
| Effective rate | ~38 MB/min, ~2.3 GB/hour |
| `ue_mac` rows | 1,504,194 |
| 5m chart query (warm) | 0.265 s, scanning 596,162 rows |
| 1h chart query (warm) | 0.684 s, scanning 1,504,194 rows |
| Chart poll interval | 2 s (`src/hooks/useMetrics.ts:23`) |
| SQLite write ceiling (v2 schema, benchmarked) | 470,721 rows/s — **235× the real load** |
| v2 row size (benchmarked) | 98 bytes/row → ~148 MB for the reference run |
