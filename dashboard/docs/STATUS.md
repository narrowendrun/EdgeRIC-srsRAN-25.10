# Dashboard status — 2026-09-19

Where the dashboard work stands, what was verified, and what to do next at the lab.

Companion to [docs/plans/](plans/README.md), which holds the design rationale. This file is the
handover: read it first.

---

## 1. Current state

Four waves are implemented, each on its own branch, stacked linearly. `wave-3-telemetry`
contains all four commits, so merging it into `main` brings everything.

| Branch | Commit | Contents |
|---|---|---|
| `main` | `3fed1d8` | Baseline: dashboard as it was before this work |
| `wave-1a-correctness` | `c038c61` | Run stats, bounded log reads, crash safety |
| `wave-1b-recorder-v2` | `e062d9b` | Schema v2, MCS capture, raw payloads opt-in |
| `wave-2-registry-worker` | `842a43e` | Metric registry, worker-thread queries |
| `wave-3-telemetry` | `3812763` | Selectable telemetry, numeric + chart modes |

Total against `main`: **29 files, +1225 / −278**. Nothing is merged. Any wave can be dropped by
resetting to the previous branch tip.

Working tree is clean, both tsconfigs typecheck, and `npm run build` succeeds.

### The running dashboard is behind the build

`dist/` and `dist-server/` on disk are built from wave 3, but the systemd process started before
that build and is still serving wave 2 in memory:

```
sudo systemctl restart edgeric-dashboard.service
```

The recorder needs nothing — its unit file is unchanged and it re-execs per run.

---

## 2. What the audit found

The original read-only audit of `dashboard/` (~1550 lines), the recorder, and the two archived
runs. Structure was sound — clean layering, typechecks clean, good input validation. The problems
were localized:

- **Run statistics were silently discarded.** Every run finalized with `messages: 0`.
- **`/api/runs/:id/log` read whole files into memory.** 116 MB `edgeric.log` → ~350 MB allocation.
- **Unhandled `error` events** on capture children and write streams could kill the server.
- **Runs only closed through the dashboard.** A gNB crash left `active-run.json` behind and the
  next experiment's metrics landed in the previous run's database.
- **MCS was never recorded.** The metric most wanted as a numeric readout had no data behind it.
- **`raw_tti.payload` was 239 MB of a 438 MB database** and nothing read it.
- **Synchronous SQLite on the event loop**, polled every 2 s.
- **~2.3 GB/hour of disk growth** with no retention.

---

## 3. What each wave delivered

### Wave 1a — correctness and crash safety (`c038c61`)

`finalize()` now waits for the recorder unit to go inactive before reading its database. The
failure was a race: the recorder is `PartOf` the collector, so systemd stops it as a propagated
job still holding an exclusive lock for its WAL checkpoint when `systemctl stop` returned. The
read failed and `if (!result.ok) return null` threw the failure away.

Manifests gained `statsComputedAt`, distinguishing "never computed" from "computed and genuinely
zero", and `list()` repairs any finalized run lacking it, once per process.

Also: bounded archived log reads via `tail -c`, `error` listeners on capture children and
streams, a 5 s reconciler that finalizes runs the stack left behind, and removal of the unused
`isSafeRunId`.

**Verified.** The 418 MB archive repaired itself from `0 / 0 / []` to **1,662,340 messages /
1,504,194 UE samples / 0x4601, 0x4602**. The 116 MB log now reads in 32 ms at +7 MB RSS. A planted
active run with all units down finalized as `interrupted` after ~15 s.

**Then confirmed in the wild.** Run `20260920T040515ZBDEB`, recorded during a UI check, has
`endedAt` and `statsComputedAt` at the *identical* timestamp and no repair line in the journal —
669,845 messages written correctly at finalize, not patched afterwards. Before wave 1a this would
have read `0`.

### Wave 1b — recorder schema v2 (`e062d9b`)

`ue_mac` went from 8 to 21 metric columns: MCS, PRBs, TBS and buffer occupancy per direction, plus
six MAC delay breakdowns stored as microsecond integers rather than millisecond REALs (8 bytes per
row unconditionally vs 1–3).

Raw protobuf payloads moved behind `--store-raw`, default off. The recorder maintains its own
`ue_samples` counter and an `observed_rnti` table, so `metrics_stats.py` is key lookups rather than
scans. Chart bounds moved from `raw_tti` to `ue_mac`.

Run capture no longer tails `edgeric-collector.service` — its per-TTI output was the 116 MB
`edgeric.log`, duplicating unstructured what SQLite already holds. The live terminal's EdgeRIC tab
still streams the collector straight from journald, so only archive bloat was lost.

**Verified** end to end against a synthetic ZMQ publisher: schema v2 with 27 columns, MCS captured
across its full published range, delay scaling correct (2.825 ms → 2825 µs), `raw_tti` empty by
default and populated under `--store-raw` (104 vs 223 bytes/row), and both v1 archives still
charting and reporting stats unchanged.

### Wave 2 — registry and worker threads (`842a43e`)

`server/metrics-registry.ts` declares all 20 metrics once — key, label, unit, column, aggregation
kind, display defaults, chart grouping — and drives the SQL, the cards and the legends. It is
deliberately dependency-free so both NodeNext and Bundler resolution accept it.

Chart queries moved to a persistent worker thread, with an in-process fallback if it cannot start.

Series now carry per-UE `last / min / max / avg`.

**Verified.** Chart data is **byte-identical to wave 1b** across 3 runs × 2 windows — the
acceptance test for a refactor that should change nothing. With a ~1.4 s query in flight
`/api/health` stayed at 6.7 ms worst case, a ratio of 0.005.

### Wave 3 — selectable telemetry (`3812763`)

`TelemetrySection` replaces `ChartsSection`. Pick any of the 20 metrics, choose per metric between
a live number (with window min/max/avg) and a chart. Selection persists in `localStorage` under a
versioned key; unknown keys are dropped on load.

`?metrics=a,b,c` on both metric endpoints, validated against the registry. Pre-v2 archives report
missing keys under `unavailable` and the picker greys them out.

**Verified.** Every component server-renders without error against live API data. A v1 archive
asked for MCS serves only what it has. A quoted SQL payload in `?metrics=` is discarded and the
table survives. Query cost scales with selection: 1 metric 0.41 s, 6 metrics 0.60 s, 20 metrics
0.75 s at a 1h window.

---

## 4. Bugs found while implementing, not in the plans

Three things the plans did not anticipate, all found by testing rather than review:

1. **v1 migration crash loop.** `ensure_columns()` adds missing columns via `ALTER TABLE`, but
   v1's `raw_tti_id INTEGER NOT NULL` survives the migration and SQLite cannot relax a column
   constraint in place. With `--store-raw` off every insert then failed on a NOT NULL violation.
   Reachable if the recorder ever restarted into a run an older build had started. Fixed by
   writing `0` rather than `NULL` on a legacy table — `raw_tti` ids start at 1, so 0 is
   unambiguous.

2. **The bounds fix was load-bearing, not cosmetic.** On a v2 database the old
   `MIN/MAX(timestamp_us) FROM raw_tti` returns `(None, None)` because the table is empty. Every
   chart would have been blank. Verified directly.

3. **The min/max trap is much larger on real data than expected.** Plan 3.5 warned that computing
   summaries from buckets reports the lowest bucket *mean*. On run `20260918T230906Z4648`:

   | 0x4602 SNR | |
   |---|---|
   | True minimum (raw rows) | **−65.53 dB** |
   | Lowest bucket mean | **−31.01 dB** |

   A 34 dB error. CQI shows the same pattern. The implementation takes raw-row extremes for
   instantaneous metrics and bucket extremes for throughput and BLER, verified against direct SQL.

---

## 5. Deviations from the plans

| Plan | Planned | Done instead | Why |
|---|---|---|---|
| 1.4 | Extract the control handler into a named function | Inline `try/finally` | Express 5's bare `Request` widens `req.params` to `string \| string[]`, breaking validation |
| 2.5 | Add `availableColumns` in wave 1b | Deferred to wave 2 | Would have been dead code until the registry used it |
| 2.3 | No migration needed (fresh DB per run) | Added `ensure_columns()` | True except for a mid-run recorder restart — see bug 1 |
| 3.5 | A second aggregate query for summaries | Folded `MIN`/`MAX`/`SUM`/`COUNT` into the bucket query | Benchmarked 38% faster; three range scans became one. 5m 578→325 ms, 1h 1352→720 ms |

All are recorded in the plan files themselves.

---

## 6. Not yet verified — the one real gap

> **RESOLVED 2026-09-22.** Validated on `logs/runs/20260922T195130Z8C9C` with a UE passing
> 421 MB of uplink traffic. MCS, PRBs, buffers and MAC delays all confirmed against real data.
> See [ROADMAP.md](ROADMAP.md) for what that run revealed. The original text is kept below for
> the record.


**No UE has been connected since wave 1b landed.** So the whole chain has been proved *except*
that the real gNB populates `dl_mcs` and the other new columns. Proto3 returns zero for absent
fields rather than erroring, so a mis-wired publisher shows as a column of zeros, not a failure.
Everything so far used a synthetic publisher, which proves the recorder's projection but not the
gNB's side of it.

Two smaller items also need a live stack:

- The reconciler staying quiet during a legitimate single-module restart. The logic is a `busy`
  flag plus a three-consecutive-check debounce, and restarting the gNB alone keeps the collector
  active so the all-inactive condition never holds — but it deserves a real check.
- Visual layout of the new tiles and picker. Components were server-rendered to prove they do not
  throw, but that says nothing about whether tiles wrap sensibly or the picker looks cramped.
  Headless browser checks were not possible here: the snap Chromium is AppArmor-blocked from DBus.

---

## 7. Next steps at the lab

### Step 1 — bring up wave 3

```bash
sudo systemctl restart edgeric-dashboard.service
```

Open http://100.73.81.66:4173. Expect the **Metrics (7)** button beside the window selector, and a
first load showing throughput and SNR as charts with MCS and BLER as numbers. That differs from
the old view on purpose; the defaults are one object in `src/hooks/useTelemetryPrefs.ts`.

### Step 2 — the MCS check (the important one)

Start the stack, connect the COTS UE, pass some OTA traffic, then **Stop all** and:

```bash
sqlite3 logs/runs/<newest>/metrics.sqlite3 \
  "SELECT value FROM metadata WHERE key='schema_version';
   SELECT COUNT(*) FROM raw_tti;
   SELECT rnti, dl_mcs, ul_mcs, dl_prbs, ul_prbs, dl_buffer, sum_mac_delay_us
     FROM ue_mac WHERE rnti > 0 LIMIT 10;
   SELECT * FROM observed_rnti;"
```

Expect `2`, `0`, non-zero MCS in roughly 0–28, plausible PRB counts, and your RNTIs. **A column of
all zeros means the gNB is not publishing that field** — not that the recorder is broken. Compare
against the gNB's own view in the live terminal's gNB tab.

### Step 3 — the other two live checks

- Restart *just the gNB* from Bench details. No new run should appear in the archive.
- **Start all** → **Stop all**. The new run should show non-zero messages immediately, with no
  `Repaired metric stats` line in `journalctl -u edgeric-dashboard`.

### Step 4 — exercise the picker

Tick and untick metrics, flip modes, reload the page to confirm persistence, then open a **v1
archive** (either 18 Sep run) and confirm MCS and the scheduling metrics are greyed out as "not
recorded in this run".

### Step 5 — merge, or report back

If it all behaves:

```bash
git checkout main && git merge --ff-only wave-3-telemetry && git push origin main
```

`wave-3-telemetry` contains all four commits, so this brings everything.

---

## 8. What is left — wave 4

Plan 5's remainder, none of it blocking:

- **5.1 fix B, incremental fetch.** Worth it only if the worker thread proves insufficient with
  more UEs on long windows. Measure first.
- **5.2 log retention and a disk guard.** Still the largest outstanding risk. Wave 1b cut the
  SQLite side (438 MB → ~148 MB projected) and dropped the collector firehose, but there is still
  no rotation, no pruning and no free-space check before a run starts.
- **5.3 gNB config tab.** The YAML is already archived per run; it needs an endpoint and a fourth
  terminal tab.
- **5.4 de-hardcode the RF panel.** `serial`, `mimo` and the ARFCN→frequency magic number will
  silently lie the moment the config changes. The NR-ARFCN formula is in the plan.
- **5.5 tests.** There are still none. Node 22's built-in runner adds no dependency. The SQL
  generation and the summary semantics are the highest-value targets — the min/max trap is exactly
  the kind of bug a test would have caught before real data did.

---

## 9. Operational notes

Things worth knowing, learned the hard way during this work:

- **Do not `pkill -f dist-server/index.js`.** It matches the systemd-managed dashboard as well as
  any test server. Kill by port instead: `ss -lptnH "sport = :4183"`.
- **Passwordless sudo covers only** `edgeric-gnb`, `edgeric-collector` and `edgeric-open5gs`.
  Starting or restarting `edgeric-dashboard` needs a real password, so it cannot be done from a
  non-interactive shell.
- **A test dashboard runs cleanly on alternate ports**, which is how all of this was verified
  without disturbing the live one:
  ```bash
  PROJECT_ROOT=/home/narend/code/EdgeRIC-srsRAN-25.10 DASHBOARD_PORT=4183 \
    OPEN5GS_PROXY_PORT=4184 DASHBOARD_HOST=127.0.0.1 \
    node --disable-warning=ExperimentalWarning dist-server/index.js
  ```
- **The archive holds three runs**, two v1 (18 Sep) and one v2-era but UE-less (20 Sep). Keep the
  v1 pair: they are the regression fixture for backward compatibility.
