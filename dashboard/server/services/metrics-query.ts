import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { allowedWindows, type WindowSize } from '../config.js'
import { METRICS_BY_KEY, requiredColumns, resolveMetrics, type MetricDef } from '../metrics-registry.js'

export interface MetricSummary { last: number; min: number; max: number; avg: number }
export interface MetricPoint { timestamp: number; [metricKey: string]: number }
export interface MetricSeries {
  rnti: number
  label: string
  points: MetricPoint[]
  summary: Record<string, MetricSummary>
}
export interface MetricsResult {
  runId: string | null
  available: boolean
  startAt?: string
  endAt?: string
  bucketMs?: number
  metrics: string[]
  unavailable: string[]
  series: MetricSeries[]
  capture: Record<string, number> | null
}

export interface QueryRequest {
  runId: string
  dbPath: string
  /** Whether the run is still recording; extends the window end to now. */
  isActive: boolean
  window: WindowSize
  metricKeys: string[]
  fullRun?: boolean
}

function round(value: number, precision: number) {
  return Number(value.toFixed(precision))
}

/**
 * Aggregates per metric per bucket.
 *
 * 'avg' metrics carry MIN/MAX/SUM alongside the bucket mean so that per-UE window summaries fold
 * out of these same rows -- min of bucket minima is the true window minimum, and sum/count is the
 * true window mean. That keeps the whole response to a single range scan; measured against the
 * 1.5M-row reference run, folding beat a separate summary scan by ~38%.
 */
function bucketSelect(metric: MetricDef): string {
  switch (metric.agg) {
    case 'avg':
      return `AVG(${metric.column}) AS "${metric.key}", MIN(${metric.column}) AS "${metric.key}__min", ` +
             `MAX(${metric.column}) AS "${metric.key}__max", SUM(${metric.column}) AS "${metric.key}__sum"`
    case 'rate':
      return `SUM(${metric.column}) AS "${metric.key}__bytes"`
    case 'ratio':
      return `SUM(${metric.numerator}) AS "${metric.key}__num", SUM(${metric.denominator}) AS "${metric.key}__den"`
  }
}

function pointValue(metric: MetricDef, row: Record<string, number>, bucketUs: number): number {
  switch (metric.agg) {
    case 'avg':
      return round((row[metric.key] ?? 0) * (metric.scale ?? 1), metric.precision)
    case 'rate':
      // bytes * 8 bits / microseconds = bits per microsecond = Mbit/s
      return round(((row[`${metric.key}__bytes`] ?? 0) * 8) / bucketUs, metric.precision)
    case 'ratio': {
      const num = row[`${metric.key}__num`] ?? 0
      const total = num + (row[`${metric.key}__den`] ?? 0)
      return total ? round((num / total) * 100, metric.precision) : 0
    }
  }
}

function availableColumns(db: DatabaseSync): Set<string> {
  const rows = db.prepare('PRAGMA table_info(ue_mac)').all() as unknown as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function captureStats(db: DatabaseSync) {
  const rows = db.prepare('SELECT key, value FROM capture_stats').all() as unknown as Array<{ key: string; value: number }>
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]))
}

function empty(runId: string, available: boolean, capture: Record<string, number> | null): MetricsResult {
  return { runId, available, metrics: [], unavailable: [], series: [], capture }
}

export function queryMetrics(request: QueryRequest): MetricsResult {
  if (!existsSync(request.dbPath)) return empty(request.runId, false, null)

  const db = new DatabaseSync(request.dbPath, { readOnly: true })
  try {
    // The production service uses ProtectSystem=strict. Keep SQLite's GROUP BY
    // scratch data in memory so read-only chart queries never need /tmp.
    db.exec('PRAGMA temp_store=MEMORY')
    db.exec('PRAGMA query_only=ON')

    // A v1 archive has only the original eight metric columns; offer what is actually there
    // rather than erroring, and tell the caller what it could not serve.
    const columns = availableColumns(db)
    const requested = resolveMetrics(request.metricKeys)
    const metrics = requested.filter((metric) => requiredColumns(metric).every((c) => columns.has(c)))
    const unavailable = request.metricKeys.filter((key) => !metrics.some((m) => m.key === key))

    // Bounds come from ue_mac, the table the rows below are read from.
    const bounds = db.prepare('SELECT MIN(timestamp_us) AS min_us, MAX(timestamp_us) AS max_us FROM ue_mac')
      .get() as { min_us: number | null; max_us: number | null }
    if (!bounds.max_us || !bounds.min_us || metrics.length === 0) {
      return { ...empty(request.runId, true, captureStats(db)), metrics: metrics.map((m) => m.key), unavailable }
    }

    const endUs = request.isActive ? Math.max(bounds.max_us, Date.now() * 1000) : bounds.max_us
    const requestedUs = allowedWindows[request.window].milliseconds * 1000
    const startUs = request.fullRun ? bounds.min_us : Math.max(bounds.min_us, endUs - requestedUs)
    const durationUs = Math.max(1, endUs - startUs)
    const bucketUs = Math.max(100_000, Math.ceil(durationUs / 360 / 100_000) * 100_000)

    const rows = db.prepare(`
      SELECT
        CAST((timestamp_us - ?) / ? AS INTEGER) * ? + ? AS bucket_us,
        rnti,
        COUNT(*) AS sample_count,
        ${metrics.map(bucketSelect).join(',\n        ')}
      FROM ue_mac
      WHERE timestamp_us BETWEEN ? AND ?
      GROUP BY bucket_us, rnti
      ORDER BY bucket_us, rnti
    `).all(startUs, bucketUs, bucketUs, startUs, startUs, endUs) as unknown as Array<Record<string, number>>

    const grouped = new Map<number, MetricPoint[]>()
    const rawByRnti = new Map<number, Array<Record<string, number>>>()
    for (const row of rows) {
      const point: MetricPoint = { timestamp: Math.round(row.bucket_us / 1000) }
      for (const metric of metrics) point[metric.key] = pointValue(metric, row, bucketUs)
      const points = grouped.get(row.rnti) || []
      points.push(point)
      grouped.set(row.rnti, points)
      const raws = rawByRnti.get(row.rnti) || []
      raws.push(row)
      rawByRnti.set(row.rnti, raws)
    }

    const summaries = summarise(metrics, grouped, rawByRnti, Math.max(1, endUs - startUs))

    return {
      runId: request.runId, available: true,
      startAt: new Date(startUs / 1000).toISOString(),
      endAt: new Date(endUs / 1000).toISOString(),
      bucketMs: bucketUs / 1000,
      metrics: metrics.map((m) => m.key), unavailable,
      series: [...grouped.entries()].map(([rnti, points]) => ({
        rnti,
        label: `0x${rnti.toString(16).toUpperCase().padStart(4, '0')}`,
        points,
        summary: summaries.get(rnti) || {},
      })),
      capture: captureStats(db),
    }
  } finally {
    db.close()
  }
}

/**
 * Per-UE live/min/max/avg, folded from the bucket rows -- no extra query.
 *
 * The source differs by aggregation kind, and getting this wrong flatters the data:
 *  - 'avg' metrics fold the per-bucket MIN/MAX/SUM that bucketSelect carries, so min and max are
 *    the true extremes across RAW rows. Reading them off the bucket means would report the lowest
 *    bucket *average* (buckets are ~900 ms wide), not the lowest MCS or SNR the UE actually hit.
 *  - 'rate' and 'ratio' are undefined for a single TTI -- an instantaneous throughput is not a
 *    thing -- so their extremes legitimately come from the bucket values, and their average is
 *    the whole-window total rather than a mean of bucket values.
 *
 * `last` is the most recent BUCKET value in every case: at 1 kHz a raw sample is far too jittery
 * to read as a number.
 */
function summarise(
  metrics: MetricDef[],
  grouped: Map<number, MetricPoint[]>,
  rawByRnti: Map<number, Array<Record<string, number>>>,
  windowUs: number,
): Map<number, Record<string, MetricSummary>> {
  const result = new Map<number, Record<string, MetricSummary>>()

  for (const [rnti, raws] of rawByRnti) {
    const points = grouped.get(rnti) || []
    const last = points.length ? points[points.length - 1] : null
    const summary: Record<string, MetricSummary> = {}

    for (const metric of metrics) {
      if (metric.agg === 'avg') {
        const scale = metric.scale ?? 1
        let min = Infinity
        let max = -Infinity
        let sum = 0
        let count = 0
        for (const raw of raws) {
          min = Math.min(min, raw[`${metric.key}__min`] ?? 0)
          max = Math.max(max, raw[`${metric.key}__max`] ?? 0)
          sum += raw[`${metric.key}__sum`] ?? 0
          count += raw.sample_count ?? 0
        }
        summary[metric.key] = {
          last: last ? last[metric.key] : 0,
          min: count ? round(min * scale, metric.precision) : 0,
          max: count ? round(max * scale, metric.precision) : 0,
          avg: count ? round((sum / count) * scale, metric.precision) : 0,
        }
        continue
      }

      // 'rate' and 'ratio': extremes over buckets, average over the whole window.
      const values = points.map((point) => point[metric.key])
      const totals: Record<string, number> = {}
      for (const raw of raws) {
        for (const alias of metric.agg === 'rate'
          ? [`${metric.key}__bytes`]
          : [`${metric.key}__num`, `${metric.key}__den`]) {
          totals[alias] = (totals[alias] ?? 0) + (raw[alias] ?? 0)
        }
      }
      summary[metric.key] = {
        last: values.length ? values[values.length - 1] : 0,
        min: values.length ? round(Math.min(...values), metric.precision) : 0,
        max: values.length ? round(Math.max(...values), metric.precision) : 0,
        avg: pointValue(metric, totals, windowUs),
      }
    }

    result.set(rnti, summary)
  }

  return result
}
