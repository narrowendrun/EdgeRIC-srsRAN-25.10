# Plan 3 — Metric registry

**Goal:** describe every metric exactly once, and derive the SQL, the chart cards, the numeric
tiles, and the picker from that one description.

**Why:** today a metric is named in five places. Adding MCS to the current code means editing the
SQL projection (`metrics-query.ts:38-54`), the row mapper (`metrics-query.ts:60-67`), the
`MetricPoint` interface (`types.ts:17-25`), the `MetricKey` union (`ChartsSection.tsx:11`), and the
hardcoded `<MetricChart>` list (`ChartsSection.tsx:36-39`). With twenty metrics and a user-facing
picker that does not scale.

**Depends on:** plan 2 (the columns must exist). **Blocks:** plan 4.

**Behaviour change: none.** This plan is a pure refactor; the dashboard should look and behave
identically when it lands. That is deliberate — it keeps the diff reviewable and separates
"restructure" from "add features".

---

## 3.1 — Where the registry lives

There is a build constraint to work around. `tsconfig.server.json` sets `rootDir: "server"`, so a
sibling `shared/` directory cannot be imported by server code without changing `outDir` layout —
which would move the entry point and break the `ExecStart=` line in
`systemd/edgeric-dashboard.service.in`.

**Chosen approach:** put the registry at **`server/metrics-registry.ts`** and let the client import
it directly:

```ts
// src/components/TelemetrySection.tsx
import { METRICS, type MetricDef } from '../../server/metrics-registry'
```

This works with zero config change, provided one rule holds:

> **`server/metrics-registry.ts` must have no imports of its own.**

It is pure data plus type declarations, so this is natural. The rule matters because server code
uses `NodeNext` resolution (`./x.js` specifiers) while the client uses Vite's `Bundler` resolution;
a dependency-free file sidesteps the mismatch entirely. Add a comment at the top of the file saying
so, because it is the kind of invariant that gets broken by a well-meaning future edit.

The client's `tsc --noEmit` uses `include: ["src"]`, but TypeScript follows imports beyond the
include roots, so the file is still type-checked. Verify with `npm run typecheck` as the first
thing after creating it.

*Alternative considered:* serving the registry from `GET /api/metrics/registry` and typing it
locally on the client. Simpler build story, but the client loses compile-time metric keys and gains
a loading state for data that is static at build time. Not worth it.

## 3.2 — The type

```ts
// server/metrics-registry.ts
// NOTE: this file is imported by BOTH the Express server and the Vite client.
// It must stay dependency-free — no imports — so the two module resolution
// modes (NodeNext and Bundler) both accept it. See docs/plans/03-metric-registry.md.

/**
 * How a metric collapses many per-TTI rows into one bucket value.
 *  - 'avg'   : AVG(column) — an instantaneous quantity (SNR, CQI, MCS, PRBs, buffers)
 *  - 'rate'  : SUM(column) * 8 / bucketUs — bytes accumulated over time, in Mbit/s
 *  - 'ratio' : SUM(num) / (SUM(num) + SUM(den)) * 100 — a percentage of events
 */
export type MetricAgg = 'avg' | 'rate' | 'ratio'
export type MetricMode = 'numeric' | 'chart'
export type MetricGroup = 'Radio' | 'Throughput' | 'Reliability' | 'Scheduling' | 'Latency'

export interface MetricDef {
  key: string
  label: string
  group: MetricGroup
  unit: string
  agg: MetricAgg
  /** 'avg' and 'rate': the ue_mac column. */
  column?: string
  /** 'ratio': the failure counter and its success counterpart. */
  numerator?: string
  denominator?: string
  /** Multiplied into the SQL result. Used to render stored microseconds as milliseconds. */
  scale?: number
  defaultMode: MetricMode
  /** Fixed Y-axis range where the metric has a natural one. */
  domain?: [number, number]
  /** Decimal places for display. */
  precision: number
  /** Metrics sharing a chartGroup render as lines in one card when both are charted. */
  chartGroup?: string
}
```

## 3.3 — The entries

Twenty metrics. The six that exist today keep their exact current keys, units, domains and
precision so nothing shifts visually.

```ts
export const METRICS: MetricDef[] = [
  // ---- Radio ----
  { key: 'snr',   label: 'SNR',    group: 'Radio', unit: 'dB',
    agg: 'avg', column: 'snr',  defaultMode: 'chart',   precision: 2 },
  { key: 'cqi',   label: 'CQI',    group: 'Radio', unit: 'index',
    agg: 'avg', column: 'cqi',  defaultMode: 'numeric', domain: [0, 15], precision: 2 },

  // ---- Throughput ----
  { key: 'dlMbps', label: 'DL throughput', group: 'Throughput', unit: 'Mbps',
    agg: 'rate', column: 'dl_acked_bytes', defaultMode: 'chart', precision: 3,
    chartGroup: 'throughput' },
  { key: 'ulMbps', label: 'UL throughput', group: 'Throughput', unit: 'Mbps',
    agg: 'rate', column: 'ul_ok_bytes',    defaultMode: 'chart', precision: 3,
    chartGroup: 'throughput' },

  // ---- Reliability ----
  { key: 'dlBler', label: 'DL BLER', group: 'Reliability', unit: '%',
    agg: 'ratio', numerator: 'dl_harq_nack', denominator: 'dl_harq_ack',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler' },
  { key: 'ulBler', label: 'UL BLER', group: 'Reliability', unit: '%',
    agg: 'ratio', numerator: 'ul_crc_fail',  denominator: 'ul_crc_ok',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler' },

  // ---- Scheduling ----
  { key: 'dlMcs',    label: 'DL MCS',    group: 'Scheduling', unit: 'index',
    agg: 'avg', column: 'dl_mcs',    defaultMode: 'numeric', domain: [0, 28], precision: 1 },
  { key: 'ulMcs',    label: 'UL MCS',    group: 'Scheduling', unit: 'index',
    agg: 'avg', column: 'ul_mcs',    defaultMode: 'numeric', domain: [0, 28], precision: 1 },
  { key: 'dlPrbs',   label: 'DL PRBs',   group: 'Scheduling', unit: 'PRBs',
    agg: 'avg', column: 'dl_prbs',   defaultMode: 'chart',   precision: 1 },
  { key: 'ulPrbs',   label: 'UL PRBs',   group: 'Scheduling', unit: 'PRBs',
    agg: 'avg', column: 'ul_prbs',   defaultMode: 'chart',   precision: 1 },
  { key: 'dlTbs',    label: 'DL TBS',    group: 'Scheduling', unit: 'bytes',
    agg: 'avg', column: 'dl_tbs',    defaultMode: 'chart',   precision: 0 },
  { key: 'ulTbs',    label: 'UL TBS',    group: 'Scheduling', unit: 'bytes',
    agg: 'avg', column: 'ul_tbs',    defaultMode: 'chart',   precision: 0 },
  { key: 'dlBuffer', label: 'DL buffer', group: 'Scheduling', unit: 'bytes',
    agg: 'avg', column: 'dl_buffer', defaultMode: 'chart',   precision: 0 },
  { key: 'ulBuffer', label: 'UL buffer', group: 'Scheduling', unit: 'bytes',
    agg: 'avg', column: 'ul_buffer', defaultMode: 'chart',   precision: 0 },

  // ---- Latency (stored as microseconds, displayed as milliseconds) ----
  { key: 'ceDelay',        label: 'CE delay',         group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'ce_delay_us',          scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'crcDelay',       label: 'CRC delay',        group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'crc_delay_us',         scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'pucchHarqDelay', label: 'PUCCH HARQ delay', group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'pucch_harq_delay_us',  scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'puschHarqDelay', label: 'PUSCH HARQ delay', group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'pusch_harq_delay_us',  scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'srToPuschDelay', label: 'SR to PUSCH',      group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'sr_to_pusch_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'sumMacDelay',    label: 'Total MAC delay',  group: 'Latency', unit: 'ms',
    agg: 'avg', column: 'sum_mac_delay_us',     scale: 0.001, defaultMode: 'numeric', precision: 3 },
]

export const METRICS_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]))

/** Columns a metric needs present in ue_mac to be servable. */
export function requiredColumns(metric: MetricDef): string[] {
  if (metric.agg === 'ratio') return [metric.numerator!, metric.denominator!]
  return [metric.column!]
}
```

## 3.4 — SQL generation

Replace the hardcoded SELECT at `metrics-query.ts:38-54` with a builder. Each metric contributes
one or two aggregate expressions aliased to its key:

```ts
function selectExpression(metric: MetricDef): string {
  switch (metric.agg) {
    case 'avg':
      return `AVG(${metric.column}) AS ${metric.key}`
    case 'rate':
      return `SUM(${metric.column}) AS ${metric.key}__bytes`
    case 'ratio':
      return `SUM(${metric.numerator}) AS ${metric.key}__num, ` +
             `SUM(${metric.denominator}) AS ${metric.key}__den`
  }
}
```

Column names come only from the registry, never from the request — the request supplies metric
*keys*, which are looked up in `METRICS_BY_KEY`. Unknown keys are dropped. There is no path from
user input into the SQL string.

Post-processing, mirroring the current `metrics-query.ts:56-71`:

```ts
function pointValue(metric: MetricDef, row: Record<string, number>, bucketUs: number): number {
  const scale = metric.scale ?? 1
  switch (metric.agg) {
    case 'avg': {
      return round((row[metric.key] ?? 0) * scale, metric.precision)
    }
    case 'rate': {
      // bytes * 8 bits / microseconds = bits per microsecond = Mbit/s
      return round((row[`${metric.key}__bytes`] * 8) / bucketUs, metric.precision)
    }
    case 'ratio': {
      const num = row[`${metric.key}__num`]
      const total = num + row[`${metric.key}__den`]
      return total ? round((num / total) * 100, metric.precision) : 0
    }
  }
}
```

Cross-check against the current behaviour: `dlMbps` is `SUM(dl_acked_bytes) * 8 / bucketUs` at
precision 3, and `dlBler` is `dl_harq_nack / (dl_harq_ack + dl_harq_nack) * 100` at precision 3.
Both match `metrics-query.ts:63-66` exactly, so existing charts are unchanged.

## 3.5 — Summary statistics, and one correctness trap

Plan 4 needs live / min / max / avg per metric per UE. **Do not compute min and max from the
bucketed series** — the buckets are 900 ms averages (measured), so their minimum is the lowest
900 ms *average*, not the lowest MCS the UE actually hit. For a numeric readout that is the wrong
number and it is wrong in a direction that flatters the data.

The correct source depends on the aggregation kind:

| `agg` | `min` / `max` | `avg` |
|---|---|---|
| `avg` | `MIN(col)`, `MAX(col)` over **raw rows** in the window — the true signal extremes | `AVG(col)` over raw rows |
| `rate` | over the **bucket series** — an instantaneous throughput is undefined; the minimum meaningful unit is one bucket | `SUM(bytes) * 8 / windowUs` over the whole window |
| `ratio` | over the **bucket series**, same reasoning | `SUM(num) / (SUM(num) + SUM(den)) * 100` over the whole window |

So `avg`-kind metrics need one extra aggregate query with no `GROUP BY` on bucket:

```sql
SELECT rnti, MIN(dl_mcs) AS dlMcs__min, MAX(dl_mcs) AS dlMcs__max, AVG(dl_mcs) AS dlMcs__avg
FROM ue_mac WHERE timestamp_us BETWEEN ? AND ? GROUP BY rnti
```

**Superseded during implementation.** A separate summary scan measured 38% slower than folding
`MIN`/`MAX`/`SUM` plus a row `COUNT(*)` into the bucket query itself and reducing per UE in JS:
min of bucket minima is the true window minimum, and sum/count the true window mean, so the
guarantee above is preserved exactly with a single range scan. Measured on the 1.5M-row reference
run: 5m went 578 ms (three scans) to 325 ms (one), 1h 1352 ms to 720 ms. `rate` and `ratio`
summaries fold from the same rows.

`last` is the most recent **bucket** value, not the most recent raw sample. At 1 kHz a raw sample is
far too jittery to read as a number; a 900 ms mean is what "current MCS" should mean to a human.
The UI should state the averaging interval next to the tiles so this is not a hidden assumption.

## 3.6 — Types that follow the registry

`src/types.ts` loses its fixed `MetricPoint` shape:

```ts
// before
export interface MetricPoint { timestamp: number; snr: number; cqi: number; /* ...4 more... */ }

// after
export interface MetricPoint { timestamp: number; [metricKey: string]: number }
export interface MetricSummary { last: number; min: number; max: number; avg: number }
export interface MetricSeries {
  rnti: number
  label: string
  points: MetricPoint[]
  summary: Record<string, MetricSummary>
}
```

This trades a compile-time guarantee (the six known keys) for an index signature. That is the right
trade once the metric set is user-selected at runtime, but it does mean a typo in a metric key
becomes a runtime `undefined` rather than a compile error. Mitigate by deriving a union from the
registry where it is cheap:

```ts
export type MetricKey = typeof METRICS[number]['key']
```

and using `MetricKey` in the picker and preference types.

## 3.7 — `ChartsSection` split

Extract `MetricChart` (currently `ChartsSection.tsx:44-75`) into its own
`src/components/MetricChart.tsx`, unchanged apart from taking `lines` derived from the registry
instead of a literal. `ChartsSection` then renders the registry's default selection, producing
exactly today's four cards. Plan 4 replaces `ChartsSection` itself.

## Verification

1. `npm run typecheck` passes for both tsconfigs — this is also the check that the cross-directory
   import in 3.1 actually works.
2. `npm run build` succeeds and the Vite bundle does not pull in any Node built-ins (it would fail
   loudly if `metrics-registry.ts` gained an import).
3. **Visual diff:** the live dashboard renders the same four cards, same colours, same axis ranges,
   same tooltip precision as before the refactor. Screenshot before and after.
4. Point the archive at both existing v1 runs; the registry-driven query must degrade to the six
   available metrics rather than erroring.

## Risk

Low — no behaviour change is intended, so any visible difference is a bug and is easy to spot. The
one genuine unknown is the cross-directory import in 3.1; verification step 1 settles it in the
first minute. If it misbehaves, fall back to the `GET /api/metrics/registry` alternative noted
there, which costs one fetch and a duplicated interface.
