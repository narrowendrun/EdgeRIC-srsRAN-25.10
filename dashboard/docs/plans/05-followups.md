# Plan 5 — Follow-ups

Independent items, each worth doing but none blocking the others. Roughly in the order I would
tackle them. Pick and choose.

---

## 5.1 — Get the metric query off the event loop  *(highest value)*

**Problem.** `node:sqlite`'s `DatabaseSync` has no async API in Node 22, so every chart query blocks
the entire event loop — SSE log streaming, `/api/status`, and control POSTs all wait behind it.
Measured on the 14-minute run:

| Window | Rows scanned | Time |
|---|---|---|
| 5m | 596,162 | 0.265 s |
| 1h | 1,504,194 | 0.684 s |

At a 2 s poll (`src/hooks/useMetrics.ts:23`) that is ~13% of the event loop gone for one client on
a 5 m window, and the archive view mounts a **second** telemetry section, doubling it. Cost scales
with `window × TTI rate × UE count`, so six UEs on a 1 h window is roughly 4 s per poll — past the
poll interval, at which point the dashboard wedges.

**Fix A — move the query off the main thread (do this first).** The problem is not that the query
is slow; 0.265 s for a 5 m window is fine. The problem is *where* it runs. Move `queryMetrics` into
a persistent `node:worker_threads` worker holding its own `DatabaseSync` handle, and message-pass
requests to it:

```ts
// server/services/metrics-worker.ts — runs in the worker
parentPort.on('message', ({ id, args }) => {
  try { parentPort.postMessage({ id, ok: true, value: queryMetrics(...args) }) }
  catch (error) { parentPort.postMessage({ id, ok: false, error: String(error) }) }
})
```

The main thread gets a promise; the event loop never blocks. This is ~60 lines, adds no dependency,
and fixes the problem completely rather than reducing it. Do this before 5.1's fix B — it is
simpler and it is the actual root cause.

Note the worker must open the database **read-only** (as `queryMetrics` already does) and must be
recreated when the active run changes, since the file path changes per run.

**Fix B — incremental fetch (optional, after A).** Reduces the work itself rather than relocating
it. Worth doing if you run many UEs on long windows; skip it otherwise.

The client already has every bucket except the newest one or two. Send the newest
timestamp it holds and return only what is new:

```
GET /api/metrics/live?window=5m&metrics=...&since=1758304812000
```

Server clamps `since` into the window, queries `timestamp_us BETWEEN max(startUs, since*1000) AND endUs`,
and returns `{ mode: 'append', points }`. Client appends and evicts anything older than the window.

Two details that make or break it:

- **Bucket alignment.** Buckets are computed from `startUs`, which slides every poll, so a naive
  append produces misaligned buckets. Anchor bucket boundaries to an absolute epoch multiple
  (`bucketUs * floor(t / bucketUs)`) instead of to the window start, so a given wall-clock instant
  always lands in the same bucket regardless of when it was queried.
- **Re-query the newest bucket.** The most recent bucket is still filling, so the client must
  replace rather than append it. Return the last two buckets every time and have the client
  upsert by timestamp.

Any change to `window` or the metric selection forces a full refetch (`mode: 'full'`). Falls back
to a full query when `since` is missing or stale, so there is no new failure mode.

Expected result: each poll touches ~2 s of rows instead of 300 s — roughly a 150× reduction in
scanned rows for the steady state.

**If neither is enough** (many UEs, long windows): have the recorder maintain a `ue_mac_1s` rollup
table as it writes — it already batches commits every 250 ms, so folding a per-second aggregate in
is natural. Charts read the rollup, raw stays for offline analysis. More work; do it only if
measurements say so.

---

## 5.2 — Log retention and a disk guard

**Problem.** ~2.3 GB/hour with no rotation, no pruning, and no free-space check. `logs/` is
gitignored so nothing reminds you it is growing. A 4-hour OTA session is ~9 GB. The ENOSPC that
follows is also the most likely trigger for the crash path fixed in plan 1.3.

The dominant term is not SQLite — it is `edgeric.log` at **121 MB for 14 minutes**, because
`collector.py` prints per-TTI to the journal and `run-store.ts:163` tails it into the run directory.

**Three fixes, cheapest first:**

1. **Stop capturing the collector firehose.** The collector's per-TTI output duplicates what the
   recorder already stores in SQLite, structured and queryable. Either run it with a quieter log
   level or drop `edgeric-collector.service` from the journalctl capture at `run-store.ts:163`,
   keeping only `edgeric-metrics-recorder.service`. This alone removes ~23% of the disk rate.
2. **Cap each captured log.** Pipe through a size-bounded writer, or run a periodic trim on files
   over ~64 MB keeping the tail. Simplest: a `logrotate` fragment for `logs/runs/*/`.
3. **Guard before starting a run.** In `RunStore.ensureActive()`, `statfs` the logs volume and
   refuse to start with a clear error below some threshold (say 10 GB), surfaced in the existing
   notice bar. Better to be told up front than to lose a session to a half-written database.

**Also add retention:** a `maxRuns` or `maxAgeDays` setting applied on startup and after each
finalize, deleting the oldest run directories. Never delete the active run. Put the setting in
`.env.example` alongside the existing values so it is discoverable.

---

## 5.3 — gNB config tab

You listed this as already built. It is not — `LiveTerminal.tsx:25` maps over
`Object.keys(moduleLabels)`, which is exactly three entries.

The data is already being captured: `run-store.ts:65` copies the YAML into
`logs/runs/<id>/config/`. What is missing is an endpoint and a tab.

- `GET /api/config/gnb` — returns the live `gnb_rf_x310_tdd_n78_20mhz.yml` as text.
- `GET /api/runs/:id/config` — returns the copy archived with that run, so you can diff what a run
  actually used against what is on disk now. This is the more valuable of the two.
- `LiveTerminal` gains a fourth tab rendering the YAML in the existing `.terminal-output` `<pre>`.
  The window selector and auto-scroll controls should hide on that tab since neither applies.

Reuse `resolveLog`'s containment pattern for the archived path rather than writing a second one.

---

## 5.4 — De-hardcode the RF panel

`server/services/systemd.ts:59-66` hardcodes values that will silently lie the moment the config
changes:

```ts
device: 'USRP X310', serial: '308CD6E', mimo: '1T1R',
frequency: cell.dl_arfcn === 632628 ? '3489.42 MHz' : `ARFCN ${cell.dl_arfcn ?? '—'}`,
```

The frequency line is the worst of these: change ARFCN and the panel shows a bare number while
still being labelled "DL / UL". Compute it from the 3GPP NR-ARFCN definition (TS 38.104 §5.4.2):

```ts
function arfcnToMhz(n: number): number | null {
  if (n < 0) return null
  if (n < 600_000)   return n * 0.005                              // 0 – 3000 MHz
  if (n <= 2_016_666) return 3000 + (n - 600_000) * 0.015          // 3000 – 24250 MHz
  if (n <= 3_279_165) return 24250.08 + (n - 2_016_667) * 0.06     // 24250 – 100000 MHz
  return null
}
```

Check: `632628` → `3000 + 32628 × 0.015` = **3489.42 MHz**, matching the hardcoded string.

Also:

- **`serial`** — read from `uhd_find_devices` output, or at minimum move it to `.env` rather than a
  string literal in a `.ts` file.
- **`mimo`** — derive from the config's antenna count rather than asserting `1T1R`.
- **The config filename** is hardcoded in two places, `systemd.ts:52` and `run-store.ts:63`. Move it
  to `server/config.ts` as `export const gnbConfigFile = process.env.GNB_CONFIG || '...'` and add it
  to `.env.example`. This is the one that will bite you first, when you try a second bandwidth or band.
- **`package.json:dev`** hardcodes the Tailscale IP `100.73.81.66`. Read it from `.env`
  (`DASHBOARD_HOST` already exists there) so the repo is not tied to one machine.

---

## 5.5 — Tests

There are none: no test script, no test files. "Vetted for no bugs" is not reachable without at
least a thin layer. Node 22 has a built-in runner, so this adds **zero dependencies**:

```json
"test": "node --test --experimental-strip-types server/**/*.test.ts"
```

The four highest-value targets, in order:

1. **Metric SQL generation** (plan 3.4) — for each registry entry, assert the generated expression
   and the post-processing against a fixture row. Pure functions, no database, catches the whole
   class of "wrong column, wrong scale, wrong divisor" bug.
2. **`queryMetrics` against a fixture database** — build a small SQLite file in a temp dir with
   known values, assert bucket boundaries, `rate` arithmetic, `ratio` arithmetic, and the
   plan 3.5 summary semantics. This is the test that would have caught the min/max trap.
3. **Run lifecycle** — `ensureActive` → `finalize` → `list`, including the plan 1.1 repair path and
   the plan 1.4 reconciler, with `run()` stubbed. No systemd needed.
4. **Path validation** — `validId` and `resolveLog` against traversal attempts (`../`, absolute
   paths, symlinks, `open5gs/../../etc/passwd`). Cheap, and it is security-relevant code.

Deliberately not testing: React components (the visual verification steps in plans 3 and 4 cover
more for less effort at this scale), and anything that needs a live gNB.

---

## 5.6 — Small cleanups

- **`metricsCatalog()`** (`metrics-query.ts:105`) re-reads and re-parses three `.proto` files on
  every request. Cache at module load; they cannot change without a restart anyway.
- **`useLogs` generation ref** (`useLogs.ts:7`) — `events.close()` in the effect cleanup already
  prevents stale events from arriving, so the `generation` counter and its two guard clauses are
  dead weight. Removing it is ~6 lines lighter with no behaviour change.
- **`sameOrigin`** (`utils.ts:21`) returns `true` when `Origin` is absent, so any `curl -X POST` on
  the tailnet can restart the stack. For a single-user lab bench on a private tailnet this is a
  defensible call — but it should be a *decision*, not an accident. Either document it in the
  README's security notes or add a shared token in `.env`. Flagging, not recommending.
- **SPA fallback** (`index.ts:23`) is skipped entirely when `dist/` is missing, so a forgotten
  `npm run build` serves a bare 404 with no hint. One `console.warn` at startup.
- **`ArchiveView` and `App`** both poll on their own intervals (5 s and 2 s) with no shared
  visibility check. Pausing polls when `document.hidden` is one `useEffect` and removes a
  continuous query load from background tabs — which, given 5.1, is real server cost.

---

## Suggested grouping

If you want these in batches rather than one at a time:

| Batch | Items | Rationale |
|---|---|---|
| **A** | 5.1, 5.2 | Both are about the system surviving a long OTA session. Do before the next multi-hour run. |
| **B** | 5.3, 5.4 | Both are "the dashboard should tell the truth about the radio config". |
| **C** | 5.5, 5.6 | Cleanup and confidence; no user-visible change. |
