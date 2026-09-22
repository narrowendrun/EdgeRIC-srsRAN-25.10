# Roadmap — post-wave-3

**Written 2026-09-22, after the first OTA run with a UE attached and passing traffic.**

Waves 1a–3 are implemented and now validated against real data. This file records what they
actually delivered, what went wrong along the way, what the first real run revealed, and what to
do next.

Companion to [STATUS.md](STATUS.md) (handover detail) and [plans/](plans/README.md) (design
rationale).

---

## 1. Validation run

`logs/runs/20260922T195130Z8C9C` — 405 s, one UE passing sustained traffic, one idle.

| | |
|---|---|
| Messages / UE samples | 795,023 / 704,850 |
| RNTIs | 0x4601 (idle), 0x4602 (loaded) |
| Traffic (0x4602) | 36.1 MB DL, **421 MB UL**, peak 15.0 / 15.6 Mbps |
| `metrics.sqlite3` | 65 MB, **92 bytes/row**, 11 MB/min |
| `edgeric.log` | **1,008 bytes** |
| `raw_tti` | 0 rows |

This is the first run where every wave was exercised end to end on a healthy stack.

---

## 2. What the waves delivered, measured

### Wave 1a — correctness

The manifest race is fixed and confirmed twice on real runs: stats are written correctly at
finalize, with `statsComputedAt` equal to `endedAt` and no repair pass. The reconciler correctly
marked the abandoned Sep 22 run `interrupted`.

### Wave 1b — recorder schema v2

**MCS is real.** Restricted to TTIs where PRBs were actually allocated (64,527 rows):

```
0x4602   dl_mcs 0-25, avg 15.0
         distribution: mcs=16 16.3%, 15 15.9%, 17 12.8%, 14 11.5%, 13 10.4%, 18 8.0%
```

A distribution centred on 13–18 is link adaptation doing its job — not the flat `mcs=0` of the
earlier failed-attach runs. The scheduling columns work too: `dl_prbs` peaks at 51,
`dl_buffer` peaks at 1.88 MB under load, and `sum_mac_delay` separates the loaded UE (11.9 ms)
from the idle one (1.2 ms).

**Storage is down 3.2×.** 92 bytes/row against a projected 98. SQLite went from 34.7 MB/min (v1,
with raw payloads) to 11 MB/min. Dropping the collector firehose took `edgeric.log` from ~11 MB
per run to **1 KB**. Whole-run disk rate: ~2.3 GB/hour → **~640 MB/hour**.

### Wave 2 — registry and worker

Chart data was byte-identical to wave 1b across every archive and window. `/api/health` stayed at
6.7 ms against a 1.4 s query. Summaries fold out of a single range scan.

### Wave 3 — selectable telemetry

Metric selection, numeric/chart modes and persistence all work. The `unavailable` path degrades v1
archives correctly.

**The min/max design decision is vindicated on real data.** Taking extremes from buckets rather
than raw rows would have been badly wrong:

| 0x4602 | raw rows | bucket means | error |
|---|---|---|---|
| SNR min | **−65.53 dB** | 16.33 dB | 82 dB |
| dlMcs max | **25** | 6 | 19 |
| dlPrbs max | **51** | 31.8 | 19 |

---

## 3. What went wrong, and what it cost

Honest accounting — all three were process failures, not design failures.

**A stale dashboard produced a phantom bug.** During the Sep 22 runs the dashboard was still
serving the wave-1a build while the recorder was v2. Wave 1a read chart bounds from `raw_tti`,
which v2 leaves empty, so charts were blank despite 953 rows sitting in `ue_mac`. Time was spent
suspecting the recorder and the gNB before the version mismatch was spotted.

> **Fix forward:** the dashboard should display the build/commit it is running. A stale process is
> currently invisible. See item R3.

**The MongoDB diagnosis was wrong twice before it was right.** Stray `mongod` processes from my own
tests stayed listening, so `pgrep` matched them and two failures read as successes. I told you
"mongod runs fine on this kernel" — the opposite of the truth — and then recommended a kernel
downgrade partly on that basis. Only a controlled A/B on separate ports settled it. Recorded in
[../../MONGODB-KERNEL-ISSUE.md](../../MONGODB-KERNEL-ISSUE.md).

> **Lesson:** when a test's verdict comes from process detection, bind the check to the specific
> port or PID under test, and clear the field between runs.

**A `pkill -f dist-server/index.js` took down the live dashboard**, because it matched the
systemd-managed process too. Kill by port, not by command pattern.

---

## 4. What real traffic revealed — we diverge from srsRAN's own reporting

**The rule: match what the srsRAN gNB reports in its own metrics. Do not invent semantics.**

srsRAN's per-period metrics line is the reference:

```
 pci rnti | cqi  ri  mcs  brate   ok  nok  (%)  dl_bs | pusch  rsrp  ri  mcs  brate  ok  nok  (%)  bsr  ta  phr
   1 4602 |  11 1.0   18   5.8k    1    0   0%      0 |  28.1 -21.4   1   27   146k   3    0   0%    0 290n  -6
```

Measured over the same 343 s window of run `20260922T195130Z8C9C`, UE 0x4602, comparing 3,424
parsed srsRAN rows against our `ue_mac`:

| Metric | srsRAN reports | ours today | ours with the right condition |
|---|---|---|---|
| DL MCS | **14.52** (all rows) / **15.48** (rows with a transmission) | **1.42** ✗ | **14.99** ✓ `WHERE dl_prbs > 0` |
| DL BLER | **1.760%** (ok 63,587 / nok 1,139) | **1.757%** ✓ | no change needed |

### 4.1 BLER already matches — leave it alone

`nack / (ack + nack)` is exactly srsRAN's `nok / (ok + nok)`. Ours reads 1.757% against srsRAN's
1.760%; the 0.003 pp gap is window-edge alignment, not a formula difference. **No work required.**

### 4.2 MCS does not match, because we average over TTIs that had no transmission

srsRAN averages MCS over PDSCHs it actually transmitted. We average over every TTI, and the gNB
reports `dl_mcs = 0` when nothing was scheduled — which is 91% of TTIs. That drags the number from
~15 to 1.42.

The numeric tile currently shows **1.42**. srsRAN would show **~15**. This is a straightforward
bug against the reference, not a design question.

Affects everything only defined when an allocation happened: `dlMcs`, `ulMcs`, `dlPrbs`, `ulPrbs`,
`dlTbs`, `ulTbs`.

### 4.3 SNR has the same shape of problem

srsRAN prints `n/a` in the `pusch` column when there was no PUSCH that period. We record an SNR
value on every TTI regardless, including the 545,913 TTIs with no UL activity, and fold them all
into the statistics:

```
  TTIs with a PUSCH    n=158,937   avg snr 22.50
  TTIs without         n=545,913   avg snr 25.84
```

Counting SNR only where srsRAN would report it changes the average from 24.97 to **22.51**.

CQI is different — srsRAN reports it every period whether or not anything was scheduled, because
it is a UE report rather than a scheduling decision. No change there.

### 4.4 An unexplained outlier — do not act on it yet

`snr < -40 dB` occurs in 90 of 704,850 rows and drags the reported minimum to −65.53 dB. It is
**not** a no-measurement sentinel: it appears at 0.013% both with and without UL activity. srsRAN
publishes no minimum for us to compare against, so there is no reference to match and no
justification for filtering it. Excluding no-PUSCH TTIs (4.3) leaves min = −36.57 dB, which is
more plausible but still unexplained. Worth understanding before touching.

## 5. Roadmap

### R1 — Match srsRAN's reporting semantics — **DONE**

> Implemented on `r1-srsran-semantics`. Verified on run `20260922T195130Z8C9C`, UE 0x4602:
> DL MCS went **1.42 → 15.0** against srsRAN's 15.48, and DL BLER stayed at 1.757% against
> srsRAN's 1.760%. SNR is now PUSCH-conditioned (24.97 → 22.51), and `dlSchedRate` reports 9.4%.
> Ten tests, including a parity test that parses `gnb.log` and asserts against it.


Add a per-metric `definedWhen` predicate to the registry so aggregates count only the TTIs srsRAN
would count:

| Metrics | Predicate | Rationale |
|---|---|---|
| `dlMcs`, `dlPrbs`, `dlTbs` | `dl_prbs > 0` | srsRAN averages over transmitted PDSCHs |
| `ulMcs`, `ulPrbs`, `ulTbs` | `ul_prbs > 0` | same, PUSCH side |
| `snr` | `ul_crc_ok + ul_crc_fail > 0` | srsRAN prints `n/a` with no PUSCH |
| `cqi` | none | srsRAN reports it every period |
| `dlBler`, `ulBler` | none | **already matches srsRAN exactly** |

Also surface a `schedRate` metric (fraction of TTIs with an allocation) — it is the context that
makes a conditioned MCS interpretable, and it is what a scheduler comparison will actually want.

Acceptance test: parse `gnb.log` for a run and assert our aggregates land within a small tolerance
of srsRAN's own per-period numbers. That comparison is scripted in this session's history and
should become a permanent test — it is the only check that keeps us honest against the reference.

### R1b — Throughput denominator — **DONE**

> The final bucket of every window is partial, and was divided by the nominal bucket width:
> measured 0.027 Mbps where the true rate was 0.081, a 3x under-report on exactly the bucket the
> numeric tile shows as the live value. On a live run the recorder's commit lag compounds it.
> Now divides by the span actually covered, capped at the newest sample. Parity tests cover DL and
> UL throughput, CQI and SNR against srsRAN's own `brate`, `cqi` and `pusch` columns.

### R8 — Sample weighting — **DECIDED: weight by samples**

Every qualifying TTI counts once toward a window average, which is what the code already did, so
this closed with documentation rather than a change. The Metric notes tab explains what it means
and why the tile and the gNB log differ. Original analysis below.



Per-bucket values agree with srsRAN (per-second aligned, SNR ratio 1.0012). The **window
summary** does not, because we weight every sample equally while averaging srsRAN's log rows
weights every metrics period equally. On run `20260922T200524Z2489`, UE 0x4602:

| | srsRAN | ours (sample-weighted) |
|---|---|---|
| SNR | 26.90 dB | 24.42 dB |
| DL MCS | 7.72 | 7.00 |
| CQI | 7.65 | 7.66 |

PUSCH counts range 1–559 per second, so busy periods dominate a sample-weighted mean — and they
have lower SNR. CQI is unaffected because it is reported uniformly.

srsRAN publishes no window aggregate, so neither is "what srsRAN reports":

- **sample-weighted** (current) answers *what SNR did data actually move at*
- **time-weighted** (mean of per-period values) answers *what did the channel look like*, and is
  what you get by eyeballing the gNB log

Not picked unilaterally. Affects the numeric tiles' min/max/avg only; charts are unaffected.

### R2 — Understand the SNR outlier before doing anything about it

See 4.4. Do not add percentile or clamping logic on a hunch; there is no srsRAN reference for a
minimum, and inventing one is exactly what we are trying to avoid. Find out what −65.53 dB means
first. R1's SNR predicate may make it moot.

### R3 — Surface the running build

Display the git commit and build time of the running server in the UI, and warn when
`dist-server` on disk is newer than the running process. This is a small change that would have
saved the confusion in section 3, and it will matter more as waves land during live sessions.

### R4 — Wave 4, the plan 5 remainder

- **5.2 log retention.** *Downgraded — I previously called this "the largest operational risk",
  which was wrong.* Measured: 642 MB/hour against 3.39 TB free. That is **220 days** of continuous
  recording to fill the disk, and a 4-hour session costs 0.076% of free space. Wave 1b's 3.6x
  reduction turned this from a risk into housekeeping. Retention is still worth having so the
  archive stays navigable, but it does not gate anything and a disk guard is not urgent.
- **5.5 tests.** Still none. R1 and R2 change aggregation semantics, which is exactly the code a
  test suite should pin down before it changes. Consider doing this *before* R1.
- **5.3 gNB config tab** — the YAML is already archived per run; needs an endpoint and a tab.
- **5.4 de-hardcode the RF panel** — `serial`, `mimo` and the ARFCN magic number.
- **5.1 fix B, incremental fetch** — measure before building. The worker thread may have made this
  unnecessary.

### R5 — Run comparison

The research goal is comparing scheduling algorithms, which means comparing *runs*. Each run is a
self-contained SQLite file with identical schema, so this is mostly a UI and query problem: select
two runs, overlay their series, diff their summary statistics. This is the first item that serves
the actual experiment rather than the observability around it.

### R6 — The control plane

Waves 1–3 built observability. The stated goal is a custom scheduling algorithm. The pieces
already exist: `ipc:///tmp/control_weights` and `ipc:///tmp/control_mcs` are in the metric
catalog, and `scheduling_muapp.py` already reads `scheduling_algorithm` from Redis.

A dashboard surface for algorithm selection and live parameter tuning is the natural next step,
and is the right use of Redis here — small, mutable, shared state, worthless once the run ends.
See [plans/06-why-sqlite-not-redis.md](plans/06-why-sqlite-not-redis.md) section 4. The run
manifest should record which algorithm and parameters were active, or R5 comparisons will not be
interpretable.

### R7 — Operational hardening

- Pin the kernel and watch for an nvidia kernel based on ≥ 7.0.14 (see MONGODB-KERNEL-ISSUE.md).
- A preflight check in the dashboard: MongoDB reachable, UDR active, disk free above a threshold —
  surfaced before **Start all** rather than discovered through a failed experiment.

---

## 6. Suggested order

1. **R1**, with the srsRAN-comparison test written first so the change is pinned to the reference.
2. **R3** — small, and it removes a live source of confusion.
3. **R5**, then **R6** — the research payload, once the numbers match srsRAN.
4. **R2**, **R4** — neither gates anything. Retention when the archive gets unwieldy.

R1 is the only item that changes what the dashboard *means*. Waves 1–3 got the data captured and
displayed correctly; R1 makes it agree with the gNB.

---

## 7. Merge status

All four waves are on `wave-3-telemetry`, unmerged, stacked linearly on `main` (`3fed1d8`). Now
that they are validated on a real run:

```bash
git checkout main && git merge --ff-only wave-3-telemetry && git push origin main
```
