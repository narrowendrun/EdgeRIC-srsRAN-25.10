# Plan 4 — Telemetry section

**Goal:** the overhaul you described. Pick which metrics you want, choose per metric whether it
renders as a live number or a chart, and get live / min / max / avg for the numeric ones.

**Depends on:** plans 2 and 3. **Blocks:** nothing.

---

## 4.1 — What the user sees

Replacing `ChartsSection` with a `TelemetrySection` laid out as:

```
┌─ rolling telemetry ─────────────────────────────────────────────────────┐
│  UE radio metrics          [Window: 5 min ▾] [Metrics (6) ▾] [i EdgeRIC]│
│  run 20260919T... · received 412,004 · TTI gaps 1,204 · bucket 900 ms   │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─ DL MCS ──────── index ─┐  ┌─ DL BLER ─────────── % ─┐               │
│  │ 0x4601  22.4            │  │ 0x4601   3.21           │   numeric     │
│  │         min 8  max 28   │  │          min 0.0        │   tiles       │
│  │         avg 21.7        │  │          max 12.4       │               │
│  │ 0x4602  19.1            │  │          avg 2.98       │               │
│  │         min 6  max 27   │  │ 0x4602   1.04           │               │
│  │         avg 18.2        │  │          min 0.0 ...    │               │
│  └─────────────────────────┘  └─────────────────────────┘               │
├─────────────────────────────────────────────────────────────────────────┤
│  ┌─ Throughput ──── Mbps ──┐  ┌─ SNR ─────────────── dB ┐               │
│  │      (line chart)       │  │      (line chart)       │   charts      │
│  └─────────────────────────┘  └─────────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────┘
```

Numeric tiles first (they are the at-a-glance layer), charts below. One card per metric with a row
per UE, rather than one card per UE-metric pair — with 2 UEs and 6 numeric metrics that is 6 cards
instead of 12, and it puts the UEs side by side where you can compare them.

The **Metrics** button opens a picker listing every metric grouped by category, each with a
checkbox and a two-way `number | chart` toggle that is only enabled once checked.

## 4.2 — Preferences and persistence

Stored in `localStorage` — no server round trip, survives reload, and per-browser is the right
scope for a display preference.

```ts
// src/hooks/useTelemetryPrefs.ts
const STORAGE_KEY = 'edgeric.telemetry.v1'

export interface TelemetryPrefs {
  v: 1
  selected: Record<string, MetricMode>   // metric key -> 'numeric' | 'chart'
}
```

The `v` field is load-bearing: when the registry changes shape later, a mismatched `v` is discarded
and the defaults are used, rather than the UI half-rendering a stale selection. Unknown keys are
also dropped on load, so removing a metric from the registry cannot break a saved preference.

**Default selection** (first load, or after a discard) — chosen to match how you described using
these day to day:

```ts
const DEFAULT_SELECTION: Record<string, MetricMode> = {
  dlMbps: 'chart',   ulMbps: 'chart',
  snr:    'chart',
  dlMcs:  'numeric', ulMcs:  'numeric',
  dlBler: 'numeric', ulBler: 'numeric',
}
```

This is one object to edit if the defaults turn out wrong in practice. Note it deliberately differs
from today's view (MCS and BLER move to numbers, CQI drops off) — if you would rather the first
load look identical to the current dashboard, say so and it becomes the registry's `defaultMode`
values instead.

Hook shape:

```ts
export function useTelemetryPrefs() {
  const [selected, setSelected] = useState<Record<string, MetricMode>>(load)
  useEffect(() => { save(selected) }, [selected])
  return {
    selected,
    toggle: (key: string) => void,        // add at registry defaultMode / remove
    setMode: (key: string, mode: MetricMode) => void,
    reset: () => void,
    numeric: string[],                     // selected keys with mode 'numeric', registry order
    charts: ChartCard[],                   // grouped by chartGroup, registry order
  }
}
```

`localStorage` access is wrapped in `try/catch` — it throws in a private window and returns stale
data after a quota error.

## 4.3 — Chart grouping

Today `Throughput` pairs DL and UL in one card and `BLER` does the same. With free selection that
pairing needs a rule rather than a hardcode. The registry's `chartGroup` (plan 3.3) supplies it:

```ts
function chartCards(selectedChartKeys: string[]): ChartCard[] {
  const cards: ChartCard[] = []
  const seenGroups = new Set<string>()
  for (const key of selectedChartKeys) {           // registry order
    const metric = METRICS_BY_KEY.get(key)!
    if (!metric.chartGroup) { cards.push({ title: metric.label, metrics: [metric] }); continue }
    if (seenGroups.has(metric.chartGroup)) continue
    seenGroups.add(metric.chartGroup)
    const members = selectedChartKeys
      .map((k) => METRICS_BY_KEY.get(k)!)
      .filter((m) => m.chartGroup === metric.chartGroup)
    cards.push({ title: groupTitle(metric.chartGroup), metrics: members })
  }
  return cards
}
```

Select both `dlMbps` and `ulMbps` as charts and you get today's single "Throughput" card with a
dashed UL line. Select only `ulMbps` and you get a single-line card. The second metric in a group
gets `dashed: true`, matching `ChartsSection.tsx:36`.

Card titles for groups (`throughput` -> "Throughput", `bler` -> "BLER") live in a small map beside
the grouping function; the registry stays free of presentation strings beyond `label`.

## 4.4 — API

```
GET /api/metrics/live?window=5m&metrics=snr,dlMcs,dlBler
GET /api/runs/:id/metrics?window=5m&metrics=...&full=1
```

`metrics` omitted falls back to the six current metrics, so any existing bookmark or the WebMCP
tool keeps working.

Response:

```ts
{
  runId: string | null,
  available: boolean,
  startAt?: string, endAt?: string, bucketMs?: number,
  metrics: string[],       // keys actually served
  unavailable: string[],   // requested but not present in this database's ue_mac
  series: [{
    rnti: number,
    label: string,                                    // "0x4601"
    points: [{ timestamp: number, [key: string]: number }],
    summary: { [key: string]: { last, min, max, avg } },
  }],
  capture: Record<string, number> | null,
}
```

`unavailable` is what lets a **v1 archive** degrade gracefully: the picker greys those entries out
with a "not recorded in this run" note rather than showing an empty chart. This is the main reason
the field exists rather than silently dropping keys.

Request parsing, in `server/routes/metrics.ts`:

```ts
function parseMetrics(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return DEFAULT_METRIC_KEYS
  const keys = raw.split(',').map((k) => k.trim()).filter((k) => METRICS_BY_KEY.has(k))
  return keys.length ? [...new Set(keys)].slice(0, METRICS.length) : DEFAULT_METRIC_KEYS
}
```

Keys are validated against the registry, so nothing from the query string reaches the SQL builder —
only registry-owned column names do.

## 4.5 — Components

| File | Status | Purpose |
|---|---|---|
| `src/components/TelemetrySection.tsx` | new, replaces `ChartsSection.tsx` | Section shell, heading, capture strip, tile grid, chart grid |
| `src/components/MetricPicker.tsx` | new | `<dialog>` with grouped checkbox list and mode toggles |
| `src/components/NumericTile.tsx` | new | One metric card, one row per UE |
| `src/components/MetricChart.tsx` | new (extracted in plan 3) | Unchanged Recharts line chart |
| `src/hooks/useTelemetryPrefs.ts` | new | localStorage-backed selection |
| `src/hooks/useMetrics.ts` | modified | Accepts a metric key list, appends `&metrics=` |
| `src/components/ChartsSection.tsx` | deleted | |
| `src/components/ArchiveView.tsx` | modified | Renders `TelemetrySection` instead |
| `src/App.tsx` | modified | Renders `TelemetrySection` instead |

`MetricPicker` reuses the existing `<dialog>` pattern from `MetricCatalogDialog.tsx:23` and
`StatusBoard.tsx:47`, including the click-outside-to-close handler, so there is no new interaction
model to learn or style.

`NumericTile`:

```tsx
export function NumericTile({ metric, series, bucketMs }: Props) {
  return <article className="paper-note numeric-tile">
    <div className="chart-title"><h3>{metric.label}</h3><span>{metric.unit}</span></div>
    {series.map((ue) => {
      const stat = ue.summary[metric.key]
      return <div className="numeric-row" key={ue.rnti}>
        <span className="numeric-rnti">{ue.label}</span>
        <strong className="numeric-value">{stat ? stat.last.toFixed(metric.precision) : '—'}</strong>
        <small className="numeric-range">
          min {fmt(stat?.min)} · max {fmt(stat?.max)} · avg {fmt(stat?.avg)}
        </small>
      </div>
    })}
  </article>
}
```

Values are right-aligned with `font-variant-numeric: tabular-nums` so digits do not jitter as they
update twice a second — at a 2 s poll and 3 significant figures, proportional digits are genuinely
distracting.

## 4.6 — Styling

All new rules go in `src/css/workbench.css` using existing tokens (`--paper`, `--blue`,
`--ink-muted`, `--chart-1` … `--chart-6`). No new colour variables. New classes:
`.numeric-tile`, `.numeric-row`, `.numeric-rnti`, `.numeric-value`, `.numeric-range`,
`.telemetry-grid`, `.picker-group`, `.picker-row`, `.mode-toggle`.

The numeric grid uses the same `repeat(auto-fit, minmax(…, 1fr))` pattern as the existing
`.chart-grid` so the two sections align at every width.

## 4.7 — A note on cost

The query gets **cheaper** as you select fewer metrics — the SELECT list shrinks and, for
`avg`-kind metrics only, one extra summary query is added. Measured baseline for comparison after
implementing: 0.265 s for a 5 m window over 596,162 rows with all six current metrics.

This does not fix the underlying problem that `node:sqlite` is synchronous and blocks the whole
event loop at a 2 s poll. Plan 5.1 (incremental fetch) is the actual fix and is worth doing soon
after this one, especially before running with more than two UEs.

## Verification

1. Select `dlMcs` as numeric with a UE attached; the live value should track the gNB's reported MCS
   and sit inside 0–28. Cross-check a few samples against the `gnb` log tab.
2. Deliberately check the min/max trap from plan 3.5: with a UE whose MCS swings, confirm the tile's
   `min` is below the lowest point visible on the same metric charted. If they are equal, the
   summary is being computed from buckets and is wrong.
3. Toggle a metric between numeric and chart; it should move between the two grids with no refetch
   glitch and no change to the other cards.
4. Reload the page; the selection persists. Clear `localStorage`; the defaults return.
5. Open a **v1 archive run**; MCS and the scheduling metrics appear greyed out in the picker with
   the "not recorded" note, and the six available metrics work normally.
6. Select every metric at once and confirm the layout holds and the poll still completes inside
   2 s on a live run.
7. `npm run typecheck` and `npm run build`.

## Risk

Moderate, but contained to the UI. The two things most likely to be wrong on the first pass are the
summary semantics (plan 3.5 — verification step 2 is specifically there to catch it) and the chart
grouping rule when only one member of a pair is selected. Neither can corrupt recorded data; both
are visible immediately.

## Explicitly out of scope

- Per-UE metric selection (select MCS for 0x4601 but not 0x4602). Not asked for, and it multiplies
  the preference shape. Easy to add later on top of this structure.
- Alert thresholds / colouring a tile red when BLER is high. Tempting and cheap, but it is scope
  you did not ask for.
- Exporting the selected metrics to CSV. Worth discussing separately — the data is all in SQLite
  and `sqlite3 -csv` already does this from a shell.
