# Plan 1 — Correctness and crash safety

**Goal:** stop losing run statistics, stop the archive log viewer from allocating hundreds of
megabytes, close the unhandled-error paths that can kill the server, and close run boundaries when
the stack stops outside the dashboard.

**Why now:** every run you record today finalizes with `messages: 0, ueSamples: 0,
observedRntis: []` in its manifest. This is not a cosmetic archive problem — those numbers are the
only record of how much data a run actually captured.

**Depends on:** nothing. **Blocks:** nothing.

---

## 1.1 — Run statistics are silently discarded

### Evidence

`logs/runs/20260918T230906Z4648/manifest.json`:

```json
"observedRntis": [],
"metrics": { "messages": 0, "ueSamples": 0, "missedTtis": 0 }
```

Running the same script by hand against that database:

```
$ .venv/bin/python dashboard/server/scripts/metrics_stats.py \
    logs/runs/20260918T230906Z4648/metrics.sqlite3
{"metrics": {"messages": 1662340, "ueSamples": 1504194, "missedTtis": 10423},
 "rntis": ["0x4601", "0x4602"]}
0.75s total
```

The script is correct. It failed at finalize time and the failure was thrown away.

### Mechanism

Three faults stacked:

1. **A race.** `server/routes/control.ts:29` calls `store.finalize('completed')` as soon as
   `controlAll('stop')` returns. `edgeric-metrics-recorder.service` is `PartOf=edgeric-collector.service`,
   so systemd stops it as a *propagated* job which is still in flight when
   `systemctl stop edgeric-collector` returns. `readMetricsStats` then opens the database
   `mode=ro` while the recorder is still executing `PRAGMA wal_checkpoint(TRUNCATE)`
   (`edgeric/metrics_recorder.py:185`), which holds an exclusive lock.
2. **A silent swallow.** `server/services/run-store.ts:182` — `if (!result.ok) return null`.
   No log, no error, no retry.
3. **No repair path.** Once written, the zeros are permanent.

### Changes

**`edgeric/metrics_recorder.py`** — nothing here; see plan 2, which makes this read O(1).

**`server/services/run-store.ts`**

Add a `statsComputedAt` field to the manifest so "computed and genuinely zero" is distinguishable
from "never computed". Existing manifests lack the field, which reads as `undefined` and therefore
triggers a recompute — this repairs the 418 MB run automatically on next listing.

```ts
export interface RunManifest {
  schemaVersion: 1
  // ...existing fields...
  statsComputedAt: string | null   // NEW
}
```

Wait for the recorder before reading. `systemctl is-active` exits 3 when inactive, so read
`stdout`, matching the existing `unitState` helper in `systemd.ts:12`:

```ts
private async waitForRecorderStop(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await run('/usr/bin/systemctl', ['is-active', 'edgeric-metrics-recorder.service'])
    if ((result.stdout || 'inactive') !== 'active') return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}
```

Call it at the top of `finalize()`, before `readMetricsStats`. `TimeoutStopSec=15` in the unit, so
a 20 s budget covers a normal stop.

Raise the stats timeout from `5000` to `30_000` (`run-store.ts:181`) and log failures instead of
returning `null` silently:

```ts
if (!result.ok) {
  console.error(`Metrics stats failed for ${id}: ${result.stderr}`)
  return null
}
```

Add a self-healing repair in `list()`, guarded so a persistently broken database does not spawn
Python every 5 s (`ArchiveView` polls `/api/runs` on a 5 s interval):

```ts
private repairAttempted = new Set<string>()

async list() {
  const manifests = /* ...existing readdir + readManifest + sort... */
  for (const manifest of manifests) {
    if (manifest.status === 'active') continue
    if (manifest.statsComputedAt) continue
    if (this.repairAttempted.has(manifest.id)) continue
    this.repairAttempted.add(manifest.id)
    const stats = await this.readMetricsStats(manifest.id)
    if (!stats) continue
    manifest.metrics = stats.metrics
    manifest.observedRntis = stats.rntis
    manifest.statsComputedAt = new Date().toISOString()
    this.writeManifest(manifest)
  }
  return manifests.map(/* ...existing databaseBytes decoration... */)
}
```

One attempt per run per server process. A restart retries, which is the right cadence for a
transient lock.

**`server/routes/runs.ts:7`** — `list()` becomes async:

```ts
router.get('/runs', async (_req, res) =>
  res.json({ activeRunId: store.activeId(), runs: await store.list() }))
```

### Verification

1. `rm` the `statsComputedAt`-less manifest's zeros are repaired: restart the dashboard, open the
   archive, confirm `20260918T230906Z4648` shows 1,662,340 messages and RNTIs `0x4601, 0x4602`.
2. Run a short OTA capture, press **Stop all**, confirm the new manifest has non-zero
   `metrics.messages` and a populated `statsComputedAt` on the first write, with no repair pass needed.
3. Confirm `journalctl -u edgeric-dashboard` is silent — no repeated stats failures.

---

## 1.2 — Archive log reader allocates the whole file

### Evidence

`server/routes/runs.ts:15`:

```ts
const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(-5000)
```

`logs/runs/20260918T230906Z4648/edgeric.log` is **121 MB**. This materializes a 121 MB string plus
a multi-million-entry array, synchronously on the event loop, then discards all but the last 5000
entries. Node's string limit makes this throw outright on a long enough run.

### Change

Read a bounded tail through the existing `run()` helper (whose `maxBuffer` is 4 MB, so a 2 MB cap
fits comfortably):

```ts
router.get('/runs/:id/log', async (req, res) => {
  const file = store.resolveLog(req.params.id, String(req.query.file || ''))
  if (!file) return res.status(404).json({ error: 'Archived log not found.' })
  const capBytes = 2 * 1024 * 1024
  const truncated = statSync(file).size > capBytes
  const result = await run('/usr/bin/tail', ['-c', String(capBytes), file], 10_000)
  if (!result.ok) return res.status(500).json({ error: 'Unable to read archived log.' })
  const all = result.stdout.split(/\r?\n/)
  // A byte-bounded tail can cut the first line mid-way; drop it when we truncated.
  const lines = (truncated ? all.slice(1) : all).slice(-5000)
  res.json({ file: String(req.query.file), lines, truncated })
})
```

**`src/components/ArchiveView.tsx`** — surface `truncated` so you know you are not seeing the whole
file. Extend the fetch's response type and render a one-line note above the `<pre>`:

```
Showing the last 5000 lines (file truncated to the final 2 MB).
```

### Verification

Open `edgeric.log` for the 14-minute run in the archive. It should return promptly, show the
truncation note, and the dashboard's RSS should not spike (`systemd-cgtop` or
`systemctl status edgeric-dashboard` memory line).

---

## 1.3 — Unhandled `error` events can kill the server

### Evidence

An `'error'` event with no listener throws. Three unguarded sites:

- `server/services/run-store.ts:151` `attach()` — neither the `spawn` child nor the
  `createWriteStream` has an `'error'` listener. The realistic trigger is **ENOSPC**, which is a
  live risk at ~2.3 GB/hour with no retention (see plan 5).
- `server/services/run-store.ts:171` `stopCapture()` kills the child, then ends the stream. A
  stderr chunk arriving in between becomes a write-after-end.
- `server/services/log-stream.ts:47` `attach()` — no `child.on('error')`.

### Changes

**`run-store.ts`**

```ts
private attach(command: string, args: string[], destination: string) {
  const stream = createWriteStream(destination, { flags: 'a' })
  stream.on('error', (error) => console.error(`Log capture write failed (${destination}):`, error))
  const child = spawn(command, args)
  child.on('error', (error) => console.error(`Log capture spawn failed (${command}):`, error))
  child.stdout.pipe(stream, { end: false })
  child.stderr.on('data', (chunk) => {
    if (!stream.writableEnded) stream.write(`[capture] ${chunk.toString()}`)
  })
  this.captures.push({ child, stream })
}
```

```ts
private stopCapture() {
  for (const { child, stream } of this.captures) {
    child.kill('SIGTERM')
    child.once('close', () => stream.end())
  }
  this.captures = []
}
```

**`log-stream.ts`** — in `attach()`:

```ts
child.on('error', (error) => sendSse(res, 'notice', { line: `stream failed: ${error.message}` }))
```

Deliberately **not** adding a global `process.on('uncaughtException')`. It would mask exactly the
class of bug this section exists to surface.

### Verification

`chmod a-w` a run's `gnb.log` and restart the dashboard — it should log the write failure and stay
up rather than exiting. Confirm with `systemctl status edgeric-dashboard` that there were no
restarts.

---

## 1.4 — Run boundaries only close through the dashboard

### Evidence

`finalize()` runs only from the `stop` branch of `server/routes/control.ts:29`. If the gNB crashes,
or you stop anything with `systemctl` directly, `logs/active-run.json` survives, log capture keeps
appending, and the **next run's metrics land in the previous run's SQLite file**. The recovery path
at `control.ts:20` only fires when *every* module reads `inactive`, so a partial stop leaves the
stale run active.

### Change

A small periodic reconciler rather than a side effect inside `GET /api/status`.

**`server/services/run-store.ts`** — add:

```ts
private idleChecks = 0
busy = false   // set by the control route while an action is in flight

async reconcile() {
  if (this.busy) { this.idleChecks = 0; return }
  if (!this.activeId()) { this.idleChecks = 0; return }
  const units = ['edgeric-gnb.service', 'edgeric-collector.service', 'edgeric-metrics-recorder.service']
  const states = await Promise.all(units.map(async (unit) => {
    const result = await run('/usr/bin/systemctl', ['is-active', unit])
    return result.stdout || 'inactive'
  }))
  if (states.some((state) => state === 'active' || state === 'activating')) {
    this.idleChecks = 0
    return
  }
  // Three consecutive idle checks (~15s) so an individual module restart is not mistaken
  // for the end of a run.
  if (++this.idleChecks < 3) return
  this.idleChecks = 0
  console.warn('Stack stopped outside the dashboard; finalizing run as interrupted.')
  await this.finalize('interrupted')
}
```

**`server/index.ts`** — after `runStore.resumeCapture()`:

```ts
const reconcileTimer = setInterval(() => { void runStore.reconcile() }, 5000)
reconcileTimer.unref()
```

and `clearInterval(reconcileTimer)` in `shutdown()`.

**`server/routes/control.ts`** — wrap the handler body so `store.busy` is `true` for its duration:

```ts
store.busy = true
try { /* ...existing handler body... */ } finally { store.busy = false }
```

Restarting a single module is safe: during `restart gnb` the collector stays active, so not all
units read inactive and `idleChecks` resets.

### Verification

1. Start the stack from the dashboard, then `sudo systemctl stop edgeric-gnb edgeric-collector`
   from a shell. Within ~15 s the run should finalize as `interrupted` and appear that way in the
   archive, with `logs/active-run.json` removed.
2. Start the stack, then restart just the gNB from the dashboard. The run must **not** finalize.

---

## 1.5 — Delete dead code

`server/utils.ts:35` `isSafeRunId` has zero imports anywhere in `server/` or `src/`. It also
disagrees with the real validator `RunStore.validId` (`run-store.ts:144`), which is stricter.
Two regexes for one concept is how the wrong one eventually gets wired up. Delete `isSafeRunId`.

---

## Out of scope for this plan

- Log retention and disk guards — plan 5.
- Making the stats read O(1) — plan 2 (the recorder maintains the counters).
- Query cost on the event loop — plan 5.

## Risk

Low. Every change is local, additive, and independently revertible. The one behavioural change
users will notice is 1.4: runs now close themselves when the stack stops outside the dashboard,
which is the intended semantics but does mean an archive entry can appear without pressing
**Stop all**.
