# EdgeRIC Workbench Dashboard

The Workbench is a local Vite/React dashboard for the X310, srsRAN gNB, EdgeRIC and Open5GS stack. It provides service controls, live logs, selectable per-UE telemetry and a per-run archive. The dashboard and Open5GS WebUI proxy bind to the machine's Tailscale address.

## What it shows

- X310/RF configuration and external-reference status.
- Open5GS, EdgeRIC collector/recorder, gNB, connected UE and iperf3 status.
- Start, stop and restart controls for each module or the complete stack.
- Live Open5GS, EdgeRIC and gNB logs.
- Five-minute rolling windows by default, with 15-minute, 30-minute and one-hour options.
- A selectable set of twenty per-UE metrics, each shown either as a live number with its
  window minimum, maximum and average, or as a time-series chart. The choice is per metric and
  is remembered in the browser.
- Throughput, SNR, CQI, BLER, MCS, PRBs, TBS, buffer occupancy and the MAC delay breakdown.
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

The existing `collector.py` remains responsible for readable EdgeRIC output and the current UE snapshot. `metrics_recorder.py` is a separate subscriber that projects every scalar `MacUeMetrics` field
into the indexed `ue_mac` table. It does **not** store the raw protobuf payload unless started
with `--store-raw`: nothing reads it, and it roughly triples database size.

EdgeRIC's gNB publisher currently conflates its outgoing stream. The recorder saves every message it receives, but a subscriber cannot guarantee receipt of every 1 ms TTI. Inferred TTI gaps are counted and displayed with each live run.

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

Every metric is declared once in `server/metrics-registry.ts`, which drives the SQL projection,
the chart cards, the numeric tiles and the picker. Three aggregation kinds cover all twenty:

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
- `GET /api/metrics/catalog`
- `GET /api/runs`
- `GET /api/runs/:id/metrics?window=5m&metrics=...&full=1`
- `GET /api/runs/:id/logs`
- `GET /api/runs/:id/log?file=...`
