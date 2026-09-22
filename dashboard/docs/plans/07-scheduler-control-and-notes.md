# Plan 7 — Scheduler control, sample weighting, and a metric notes tab

Three things, requested together. The guiding constraint is **wrap what exists, build nothing new**.

---

## 0. What already exists — do not rebuild any of this

`edgeric/muapp-scheduling/scheduling_muapp.py` is complete and working:

| | |
|---|---|
| Algorithms | `Fixed Weight`, `Max CQI`, `Max Weight`, `Proportional Fair`, `Round Robin` |
| Selection | polls `redis_db.get('scheduling_algorithm')` — one plain string key, db 0 |
| Redis | `localhost:6379`, `decode_responses=True`, so the value is a UTF-8 string |
| Output | already computes weights and calls `send_scheduling_weight()` back to the gNB |
| Switch latency | one episode batch, `--episodes` default 1000 TTIs ≈ 1 s |
| If Redis is down | falls back to a fixed `Proportional Fair` and stops reading the key |

So the entire control mechanism is there. What is missing is only a way to **see** the current
value and **change** it without a shell.

**Prerequisite, one-off:** `sudo apt-get install redis-server` (not currently installed) and
`sudo systemctl enable --now redis-server`. The muApp is launched by hand today
(`sudo python3 scheduling_muapp.py`); this plan does not change that — see A5.

---

## Part A — Scheduler control in the dashboard

### A1. Reach Redis with `redis-cli`, not a Node client

The server already shells out to `systemctl`, `journalctl`, `tail`, `pgrep` and `git` through one
`run()` helper. Reading and writing a single string key fits that pattern exactly:

```ts
run('/usr/bin/redis-cli', ['-h', '127.0.0.1', '-p', '6379', 'GET', 'scheduling_algorithm'])
run('/usr/bin/redis-cli', ['-h', '127.0.0.1', '-p', '6379', 'SET', 'scheduling_algorithm', name])
```

No npm dependency, no connection pool, no lifecycle. `redis-cli` ships with `redis-tools`, pulled
in by `redis-server`. The dashboard's systemd sandbox permits this — `ProtectSystem=strict` still
allows executing binaries, and the unit sets no network restrictions.

*Rejected:* the `redis` npm package. A proper client is the right call for high-frequency or
transactional work. This is one key, read every 2 s alongside the existing status poll.

### A2. Registry for algorithms, mirroring the metric registry

```ts
// server/scheduler-registry.ts  — dependency-free, imported by server and client
export const SCHEDULING_ALGORITHMS = [
  'Fixed Weight', 'Max CQI', 'Max Weight', 'Proportional Fair', 'Round Robin',
] as const
export const SCHEDULER_REDIS_KEY = 'scheduling_algorithm'
```

These strings must match `algorithm_mapping` in `scheduling_muapp.py` exactly — an unknown value
makes the muApp print "Unknown algorithm" and idle. A comment in both files should say so.

Same discipline as the metric keys: **the dropdown offers only these, and the POST handler
validates against this list**, so nothing from a request reaches Redis unchecked.

### A3. Server

Fold the read into the existing `getStatus()` so it rides the 2 s status poll rather than adding
another timer:

```ts
scheduler: {
  available: boolean       // redis-cli succeeded
  algorithm: string | null // current value, null when unset
  known: boolean           // value is one we recognise
  muappRunning: boolean    // pgrep, same as the gnb/collector checks
}
```

`muappRunning` uses the existing `processRunning()` helper with the pattern
`python(3)? .*scheduling_muapp\.py`, matching what `kill_all.sh` already keys on.

One new route:

```
POST /api/scheduler   { "algorithm": "Max CQI" }
```

Guarded by `sameOrigin()` like `/api/control`, rejecting anything not in the registry. Returns the
new value so the UI can confirm rather than assume.

### A4. UI

A small **Scheduler** cell in the existing status summary grid, so it sits with the other live
state rather than becoming its own section:

```
┌─ Scheduler ──────────────────┐
│ ● Max CQI                    │
│ [ Proportional Fair      ▾ ] │
│ muApp running · switch ~1 s  │
└──────────────────────────────┘
```

- The lamp follows `muappRunning` and `available`: green when both hold, degraded when Redis is up
  but the muApp is not running (the value is being stored and nothing is reading it), inactive when
  Redis is unreachable.
- The dropdown is disabled unless Redis is reachable, with the reason in the cell.
- After a successful POST, refresh status rather than optimistically updating — the muApp may not
  pick it up for up to an episode, and the displayed value should be the truth in Redis.
- If Redis holds a value outside the registry (someone set it by hand), show it verbatim and mark
  it unknown rather than silently correcting it.

### A5. Explicitly out of scope

**Starting and stopping the muApp from the dashboard.** That needs a systemd unit plus a sudoers
entry, and the muApp currently wants `sudo` for its own reasons. Keep launching it by hand. The
dashboard reports whether it is running, which is the "watch over it" half of the request.

Worth doing later if switching algorithms becomes routine; it is a self-contained follow-up.

### A6. Record the algorithm in the run manifest — recommended, separable

Small, and it is what makes the dropdown useful for actual experiments. Without it, two runs are
indistinguishable afterwards and no comparison is interpretable.

Because the dropdown makes mid-run switching possible, a single field is not enough:

```ts
schedulerTimeline: Array<{ at: string; algorithm: string | null }>
```

One entry written when the run starts (whatever Redis currently holds) and one appended on every
successful POST while a run is active. That answers both "which algorithm was this run" and "when
did it change", and it is the input the run-comparison work (ROADMAP R5) will need.

Cut this if you want the smallest possible change; but then note that runs recorded before it
lands cannot be attributed to an algorithm.

---

## Part B — Sample weighting (ROADMAP R8): decided, no code change

**Decision: weight by samples.** Every qualifying TTI counts once toward a metric's window
average.

This is what the code already does — `avg = SUM(column) / COUNT(rows)` over TTIs passing the
metric's `definedWhen` predicate. So **R8 closes with no implementation**, only documentation.

Worth stating plainly what it means, because it is why the tile and the gNB log disagree:

- A sample-weighted mean answers *what did the radio look like while data was actually moving*.
- Averaging srsRAN's log rows weights every 100 ms period equally and answers *what did the channel
  look like over time*.

On run `20260922T200524Z2489` those are 24.42 dB and 26.90 dB for SNR, because PUSCH counts run
from 1 to 559 per second and busy seconds have lower SNR. Neither is "wrong" and srsRAN publishes
no window aggregate of its own; we are choosing, and the Notes tab should say so.

Per-bucket chart values are unaffected — they already agree with srsRAN (per-second aligned,
ratio 1.0012).

**Work:** update ROADMAP R8 to closed, and cover it in Part C.

---

## Part C — A "Metric notes" tab

A third top-level tab beside **Live workbench** and **Run archive**.

### C1. Generate it from the registry

Every mechanical fact is already declared in `server/metrics-registry.ts`: label, unit, column,
aggregation kind, `definedWhen`, precision, scale. **Derive the notes from it** so prose cannot
drift from behaviour — the single most important design decision in this part.

Per metric, rendered from the registry:

| shown | derived from |
|---|---|
| Name, unit | `label`, `unit` |
| Source | `column` / `numerator` + `denominator` in `ue_mac` |
| How it is combined | `agg` → "mean per bucket", "bytes ÷ elapsed time", "share of events" |
| Counted on | `definedWhen` rendered in words, or "every TTI" |
| Displayed as | `defaultMode`, `precision`, `domain` |

Add one optional `note?: string` to `MetricDef` for the handful that need a sentence a formula
cannot give — MCS, SNR, BLER, throughput, `schedRate`. Leave the obvious ones (CQI, buffers)
without.

### C2. Static prose alongside it

Short sections the registry cannot supply:

1. **The reference.** srsRAN's own metrics log is the authority; `srsran-parity.test.ts` asserts
   against it. Include the column map: our `dlBler` ↔ srsRAN `(%)`, `dlMbps` ↔ `brate`, `snr` ↔
   `pusch`, `dlMcs` ↔ `mcs`.
2. **Why some metrics skip TTIs.** The gNB writes `mcs = 0` when nothing was scheduled and prints
   `n/a` for SNR with no PUSCH; averaging those in drags MCS from ~15 to 1.4. Give that number, it
   makes the point instantly.
3. **How averages are weighted** — Part B, and why the tile and the gNB log differ.
4. **Bucketing.** Windows are downsampled to a few hundred buckets, so peaks are bounded by bucket
   width: srsRAN's 100 ms periods saw 17.4 Mbps where a 900 ms bucket saw 15.8. Narrow the window
   for finer resolution.
5. **Gaps are not zeros.** A bucket with no qualifying TTI omits the metric, so a chart line breaks
   rather than dipping to the floor.
6. **Capture is not display.** Every metric is recorded for every run regardless of what is
   selected; selection is a display filter.

### C3. Shape

Read-only, no data fetching beyond the registry, grouped by the existing metric groups. Reuse
`.paper-note` and the existing type scale; no new CSS tokens. The tab label should say what it is
— **"Metric notes"** rather than "Notes", since it is specifically about how numbers are derived.

---

## Order and size

| Step | Work | Notes |
|---|---|---|
| 1 | Install and enable `redis-server` | one-off, on the bench |
| 2 | Part C, the notes tab | pure addition, no behaviour change, ~150 lines |
| 3 | Part B, close R8 in docs | a paragraph |
| 4 | A2 + A3, registry and server | ~80 lines |
| 5 | A4, the UI cell | ~60 lines |
| 6 | A6, manifest timeline | ~30 lines, separable |

Part C first because it is risk-free and it forces the registry to carry everything the notes
need, which Part A's UI copy then benefits from.

## Verification

- With Redis stopped: the cell shows unavailable, the dropdown is disabled, nothing else breaks.
- With Redis up but the muApp not running: degraded lamp, dropdown still works, value persists —
  confirm with `redis-cli GET scheduling_algorithm`.
- With both up: switch algorithms, confirm the muApp logs `Running: <name>` within ~1 s, and that
  the dashboard shows the new value after its next poll.
- Set a junk value by hand (`redis-cli SET scheduling_algorithm "Nonsense"`) and confirm the
  dashboard shows it as unknown rather than hiding it.
- POST an algorithm not in the registry and confirm it is rejected.
- Notes tab: every registry metric appears, and the derived condition matches `definedWhen`.

## Risks

Low throughout. The only shared state is one Redis string that something else already owns, and
the dashboard is not becoming responsible for the muApp's lifecycle. The main hazard is the
algorithm names drifting out of step with `algorithm_mapping` in the muApp — worth a comment in
both files, and a candidate for a test that reads the Python and asserts the lists match.
