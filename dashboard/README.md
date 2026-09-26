# EdgeRIC Workbench Dashboard

The Workbench is a local Vite/React dashboard for the X310, srsRAN gNB, EdgeRIC and Open5GS stack. It provides service controls, live logs, selectable per-UE telemetry and a per-run archive. The dashboard and Open5GS WebUI proxy bind to the machine's Tailscale address.

## What it shows

- X310/RF configuration and external-reference status.
- Open5GS, EdgeRIC collector/recorder, gNB, connected UE and iperf3 status.
- Start, stop and restart controls for each module or the complete stack.
- Live Open5GS, EdgeRIC and gNB logs.
- Five-minute rolling windows by default, with 15-minute, 30-minute and one-hour options.
- A selectable set of per-UE metrics, each shown either as a live number with its
  window minimum, maximum and average, or as a time-series chart. The choice is per metric and
  is remembered in the browser.
- Throughput, SNR, CQI, BLER, MCS, PRBs, TBS, buffer occupancy and the MAC delay breakdown.
- Per-UE UL/DL terminal HARQ outcomes, resolved-initial-attempt success probability, and retrospective AoI in native slots and milliseconds.
- A protobuf-derived catalog of every EdgeRIC published metric and subscribed control.
- Archived runs with charts and individual component logs.

## Architecture

```text
gNB metrics PUB ──► metrics_recorder.py ──► logs/runs/<run-id>/metrics.sqlite3
                                              │
                                              ▼
dashboard server API ─────────────────────► live and archived charts

systemd journals + /var/log/open5gs/*.log ─► logs/runs/<run-id>/*.log
```

The existing `collector.py` remains responsible for readable EdgeRIC output and the current UE snapshot. `metrics_recorder.py` is a separate subscriber that projects native MAC fields into `ue_mac` and stores normalized `slot_observation`, `ue_slot_observation`, and immutable `harq_outcome` ledgers. It does **not** store the raw protobuf payload unless started
with `--store-raw`: nothing reads it, and it roughly triples database size.

EdgeRIC's gNB publisher uses a bounded, non-conflated queue. The recorder saves every message it receives; publisher-message and HARQ-event sequence numbers expose leading and interior loss. A final publisher/recorder drain watermark is still required to prove that no trailing events were lost at shutdown. Native slot duration is archived explicitly (the current 30 kHz SCS configuration uses 0.5 ms slots).

## Dependencies

Python dependencies are installed only in the project-root `.venv`:

```bash
cd /home/narend/code/EdgeRIC-srsRAN-25.10
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

React, Vite, Recharts and the dashboard server are JavaScript packages and are managed by npm in `dashboard/node_modules`:

```bash
cd /home/narend/code/EdgeRIC-srsRAN-25.10/dashboard
npm install
```

## Build and install

Build from the dashboard directory:

```bash
cd /home/narend/code/EdgeRIC-srsRAN-25.10/dashboard
npm run typecheck
npm run build
```

Then install or refresh the managed systemd services:

```bash
cd /home/narend/code/EdgeRIC-srsRAN-25.10
sudo ./dashboard/systemd/install.sh
```

The installer creates the writable `logs/runs` directory, builds the current dashboard source with the user's Node.js runtime, installs the SQLite recorder service and restarts the dashboard. Node.js 22 or newer is required because the metrics API uses `node:sqlite`. Run the installer again whenever a service template changes.

Open:

- Dashboard: `http://vriika-fiend:4173`
- Open5GS subscriber console: `http://vriika-fiend:4174`

## Run lifecycle

Using **Start all** creates a new run before Open5GS, EdgeRIC and the gNB start. Individual module restarts stay in the same run. **Stop all** stops the stack, flushes and checkpoints SQLite, stops log capture and finalizes the run manifest.

If a previous run marker exists while every module is stopped, the next **Start all** marks that run interrupted and creates a new run. Directly controlling services outside the dashboard does not define a new run boundary.

Each run is stored as:

```text
logs/runs/<run-id>/
  manifest.json
  metrics.sqlite3
  gnb.log
  edgeric.log
  open5gs/
    amf.log
    smf.log
    upf.log
    ...
    webui.log
  config/
    gnb_rf_x310_tdd_n78_20mhz.yml
```

SQLite uses WAL while a run is active. Temporary `metrics.sqlite3-wal` and `metrics.sqlite3-shm` files can therefore appear beside the database and are consolidated when the recorder stops normally.

## Metric calculations

**Aggregates match what the srsRAN gNB reports in its own metrics log.** That log is the
reference; we do not invent semantics. `server/services/srsran-parity.test.ts` parses a recorded
run's `gnb.log` and asserts our numbers against it.

A metric is only averaged over the TTIs srsRAN counts, expressed as a `definedWhen` predicate in
the registry:

| Metrics | Counted on | Why |
|---|---|---|
| `dlMcs`, `dlPrbs`, `dlTbs` | `dl_prbs > 0` | srsRAN averages over transmitted PDSCHs; the gNB writes 0 otherwise |
| `ulMcs`, `ulPrbs`, `ulTbs` | `ul_prbs > 0` | same, PUSCH side |
| `snr` | a PUSCH occurred | srsRAN prints `n/a` when there was none |
| `cqi` | every TTI | srsRAN reports it every period — it is a UE report, not a scheduling decision |
| `dlBler`, `ulBler` | every TTI | already identical to srsRAN's `nok / (ok + nok)` |
| throughput | every TTI | a rate over elapsed time, so idle TTIs correctly contribute zero |

A bucket with no qualifying TTI omits that metric rather than reporting zero, so a chart line
breaks instead of dipping to the floor.

Throughput divides by the span a bucket **actually covers**, capped at the newest recorded sample.
The newest bucket in any window is normally partial, and on a live run the recorder's commit lag
leaves the last fraction of a second empty; dividing either by the nominal bucket width reports
the current rate low by several times. A bucket covering under a quarter of its width omits the
rate rather than reporting a spike or a dip.

Peak throughput is bounded by bucket width: a 100 ms burst seen through a 900 ms bucket is
averaged down. Narrow the window for finer buckets if you need the true peak. `dlSchedRate` / `ulSchedRate` report the share of TTIs
that got an allocation, which is the context a conditioned MCS needs.

Every metric is declared once in `server/metrics-registry.ts`, which drives the SQL projection,
the chart cards, the numeric tiles and the picker. Three aggregation kinds cover them:

- `avg` averages the column over each bucket. SNR, CQI, MCS, PRBs, TBS, buffers and the delays.
- `rate` is `SUM(bytes) * 8 / bucket` in Mbit/s. DL throughput uses acknowledged MAC bytes, UL
  uses successfully decoded bytes.
- `ratio` is `SUM(fail) / (SUM(fail) + SUM(ok)) * 100`. DL BLER is `NACK / (ACK + NACK)`, UL BLER
  is `CRC fail / (CRC success + CRC fail)`.

Queries are downsampled to a few hundred buckets before reaching the browser. Chart-ready values
live in `ue_mac`; `raw_tti` is empty unless the recorder was started with `--store-raw`.

Per-UE minimum, maximum and average are computed from the raw rows for `avg` metrics, not from
the bucket series -- the minimum of a set of ~900 ms means is not the lowest value the UE
actually reached. `rate` and `ratio` are undefined for a single TTI, so their extremes do come
from the buckets and their average is the whole-window total.

Chart queries run in a worker thread. `node:sqlite` is synchronous, so running them on the main
thread stalled log streaming, status polling and service controls behind every chart refresh.

Chart-query temporary tables are kept in memory. This is required by the dashboard's hardened systemd sandbox and avoids temporary disk I/O while an active WAL is being written.

## Source layout

```text
dashboard/
  server/
    routes/       HTTP APIs
    services/     systemd, run capture and SQLite queries
  src/
    components/   status, telemetry, terminal and archive views
    hooks/        polling and streaming data hooks
    css/
      workbench.css
  systemd/        service templates and installer
```

All visual rules and theme tokens are contained in `src/css/workbench.css`. Change the variables at the top of that file to retheme the dashboard without touching the React components.

## Scheduling algorithm

The EdgeRIC scheduling muApp (`edgeric/muapp-scheduling/scheduling_muapp.py`) picks its algorithm
from a single Redis key. Set it from a shell:

```bash
redis-cli SET scheduling_algorithm "Max CQI"
```

Valid values: `Fixed Weight`, `Max CQI`, `Max Weight`, `Proportional Fair`, `Round Robin`. The
muApp picks a change up within about one episode (~1 s) and prints `Running: <name>`.

**The dashboard reports, it does not set.** The status board shows the current value, whether the
muApp is running to act on it, and flags a value the muApp would not recognise. The muApp's
lifecycle stays manual.

Every run records the Redis scheduler intent and when it changed, sampled every 5 s. This is not
proof that the muApp or gNB applied the requested algorithm; applied-decision/grant evidence must
be added before an archived run can be attributed to a scheduler. The intent timeline appears
under the run's bench details in the archive.

## Analysing a recorded run

Each run directory is self-contained and meant to outlive this codebase:

```text
logs/runs/<run-id>/
  manifest.json          run conditions: RF config, git commit, scheduler timeline, UE counts
  metrics-schema.json    how every metric is derived, including which TTIs it counts
  metrics.sqlite3        per-slot MAC rows plus normalized slot and HARQ outcome ledgers
  gnb.log                the gNB's own metrics, the reference our aggregates match
```

`metrics-schema.json` exists because deriving metrics from `ue_mac` naively gets them wrong: the
gNB writes `mcs = 0` on TTIs it did not schedule, so an unconditioned average reports about 1.4
where the gNB reports 15. The conditions travel with the data.

To get analysis-ready CSV:

```bash
python3 dashboard/server/scripts/export_run.py logs/runs/<run-id> --bucket 1.0 -o run.csv
```

One row per UE per bucket, with the same conditions the dashboard applies. A blank cell means the
metric was undefined for that bucket — a gap, not a zero. `--metrics snr,dlMcs` narrows the
columns; `--bucket` sets the resolution.

For HARQ analysis, use the normalized SQLite tables directly or the deterministic helpers in
`edgeric/harq_analysis.py`. Success probability counts terminal initial attempts only; AoI resets
at the original transmission slot on ACK/CRC success. Reject or qualify a run whose capture
counters report sequence gaps, reorders, contract errors, or rejected events.

## Tests

```bash
npm test
```

Node's built-in runner via `tsx`; no extra dependency. `metrics-query.test.ts` pins the
aggregation arithmetic against a synthetic fixture with round numbers;
`srsran-parity.test.ts` checks those aggregates against a real run's `gnb.log` and skips when no
suitable run is recorded.

## Development

```bash
cd /home/narend/code/EdgeRIC-srsRAN-25.10/dashboard
npm run dev
```

The Vite development server proxies `/api` to the dashboard server. Production uses the compiled `dist` frontend and `dist-server` server.

Useful project-root commands:

```bash
./scripts/run_dashboard.sh
./scripts/stop_dashboard.sh
./scripts/kill_all.sh
```

`kill_all.sh` is an emergency cleanup command. Prefer **Stop all** for normal runs so the archive manifest and SQLite database are finalized cleanly.

## API summary

- `GET /api/status`
- `POST /api/control/:target/:action`
- `GET /api/logs/:module/stream?window=5m`
- `GET /api/metrics/live?window=5m&metrics=snr,dlMcs`
- `GET /api/metrics/live/harq?window=5m`
- `GET /api/metrics/catalog`
- `GET /api/runs`
- `GET /api/runs/:id/metrics?window=5m&metrics=...&full=1`
- `GET /api/runs/:id/harq?window=5m&full=1`
- `GET /api/runs/:id/logs`
- `GET /api/runs/:id/log?file=...`
