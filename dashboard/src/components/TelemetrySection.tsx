import { useMemo, useState } from 'react'
import { METRICS_BY_KEY, type MetricChoice, type MetricDef, type MetricMode } from '../../server/metrics-registry'
import { useMetrics } from '../hooks/useMetrics'
import { useHarqMetrics } from '../hooks/useHarqMetrics'
import { useTelemetryPrefs } from '../hooks/useTelemetryPrefs'
import type { HarqResponse, MetricPoint, MetricSeries, MetricSummary, WindowSize } from '../types'
import { MetricCatalogDialog } from './MetricCatalogDialog'
import { MetricChart } from './MetricChart'
import { MetricPicker } from './MetricPicker'
import { NumericTile } from './NumericTile'
import { WindowSelect } from './WindowSelect'

function summary(values: number[], last: number, avg?: number, max?: number): MetricSummary {
  return {
    last,
    min: values.length ? Math.min(...values) : last,
    max: max ?? (values.length ? Math.max(...values) : last),
    avg: avg ?? (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : last),
  }
}

function derivedHarqSeries(data: HarqResponse | null): MetricSeries[] {
  if (!data?.available) return []
  const byRnti = new Map<number, MetricSeries>()
  for (const item of data.series) {
    const series = byRnti.get(item.rnti) || { rnti: item.rnti, label: item.label, points: [], summary: {} }
    const points = new Map(series.points.map((point) => [point.timestamp, point]))
    const probabilityKey = item.direction === 'dl' ? 'dlSuccessProbability' : 'ulSuccessProbability'
    const aoiKey = item.direction === 'dl' ? 'dlAoi' : 'ulAoi'
    const probabilities: number[] = []
    const ages: number[] = []
    for (const source of item.points) {
      const point: MetricPoint = points.get(source.timestamp) || { timestamp: source.timestamp }
      if (source.pSuccessPercent !== undefined) {
        point[probabilityKey] = source.pSuccessPercent
        probabilities.push(source.pSuccessPercent)
      }
      point[aoiKey] = source.aoiMs
      ages.push(source.aoiMs)
      points.set(source.timestamp, point)
    }
    if (item.pSuccess !== null) {
      series.summary[probabilityKey] = summary(probabilities, item.pSuccess * 100)
    }
    series.summary[aoiKey] = summary(ages, item.aoi.currentMs, item.aoi.meanMs, item.aoi.maxMs)
    series.points = [...points.values()].sort((left, right) => left.timestamp - right.timestamp)
    byRnti.set(item.rnti, series)
  }
  return [...byRnti.values()]
}

function mergeSeries(primary: MetricSeries[], derived: MetricSeries[]): MetricSeries[] {
  const merged = new Map<number, MetricSeries>()
  for (const source of [...primary, ...derived]) {
    const target = merged.get(source.rnti) || { rnti: source.rnti, label: source.label, points: [], summary: {} }
    const points = new Map(target.points.map((point) => [point.timestamp, point]))
    for (const point of source.points) points.set(point.timestamp, { ...(points.get(point.timestamp) || {}), ...point })
    target.points = [...points.values()].sort((left, right) => left.timestamp - right.timestamp)
    target.summary = { ...target.summary, ...source.summary }
    merged.set(source.rnti, target)
  }
  return [...merged.values()]
}

function MetricDisplay({ metric, mode, series }: { metric: MetricDef; mode: MetricMode; series: MetricSeries[] }) {
  if (mode === 'numeric') return <NumericTile metric={metric} series={series} />
  return <MetricChart card={{ title: metric.label, unit: metric.unit, domain: metric.domain, metrics: [metric] }} series={series} />
}

function DirectionalMetricRow({ choice, mode, servable, series }: {
  choice: MetricChoice
  mode: MetricMode
  servable: Set<string>
  series: MetricSeries[]
}) {
  return <section className="metric-pair-row" aria-labelledby={`metric-pair-${choice.id}`}>
    <h3 className="metric-pair-title" id={`metric-pair-${choice.id}`}>{choice.title}</h3>
    <div className="metric-pair-columns">
      {(['ul', 'dl'] as const).map((direction) => {
        const metric = choice.metrics.find((candidate) => candidate.direction === direction)
        return <div className={`metric-direction metric-direction-${direction}`} key={direction}>
          <h4>{direction.toUpperCase()}</h4>
          {!metric && <div className="metric-not-applicable">not applicable</div>}
          {metric && !servable.has(metric.key) && <div className="metric-not-applicable">not recorded in this run</div>}
          {metric && servable.has(metric.key) && <MetricDisplay metric={metric} mode={mode} series={series} />}
        </div>
      })}
    </div>
  </section>
}

export function TelemetrySection({ runId, archived = false }: { runId?: string; archived?: boolean }) {
  const [windowSize, setWindowSize] = useState<WindowSize>('5m')
  const [fullRun, setFullRun] = useState(archived)
  const { selected, toggle, setMode, reset, keys, choices } = useTelemetryPrefs()
  const standardKeys = useMemo(() => keys.filter((key) => METRICS_BY_KEY.get(key)?.source !== 'harq'), [keys])
  const harqKeys = useMemo(() => keys.filter((key) => METRICS_BY_KEY.get(key)?.source === 'harq'), [keys])
  const { data, error } = useMetrics(windowSize, standardKeys, runId, fullRun)
  const { data: harqData, error: harqError } = useHarqMetrics(windowSize, runId, fullRun, harqKeys.length > 0)

  const harqSeries = useMemo(() => derivedHarqSeries(harqData), [harqData])
  const series = useMemo(() => mergeSeries(data?.series || [], harqSeries), [data?.series, harqSeries])
  const unavailable = useMemo(() => [
    ...(data?.unavailable || []),
    ...(!harqData?.available && harqKeys.length ? harqKeys : []),
  ], [data?.unavailable, harqData?.available, harqKeys])
  // A pre-v2 archive has no MCS or scheduling columns; drop those rather than render empty cards.
  const servable = useMemo(() => new Set([
    ...(data?.metrics || standardKeys),
    ...(harqData?.available ? harqKeys : []),
  ]), [data?.metrics, harqData?.available, harqKeys, standardKeys])

  const headingId = archived ? 'archive-telemetry-heading' : 'telemetry-heading'
  const nothingSelected = choices.length === 0
  const combinedError = error || (harqKeys.length ? harqError : '')
  const available = Boolean(data?.available || harqData?.available)
  const loading = (standardKeys.length > 0 && !data) || (harqKeys.length > 0 && !harqData)
  const activeRunId = data?.runId || harqData?.runId

  return <section className="charts-section" aria-labelledby={headingId}>
    <div className="section-heading">
      <div>
        <p className="section-kicker">{archived ? 'recorded telemetry' : 'rolling telemetry'}</p>
        <h2 id={headingId}>{archived ? 'Run telemetry' : 'UE radio metrics'}</h2>
      </div>
      <div className="section-tools">
        {archived && <button type="button" aria-pressed={fullRun} onClick={() => setFullRun((value) => !value)}>{fullRun ? 'Entire run' : 'Rolling window'}</button>}
        {!fullRun && <WindowSelect value={windowSize} onChange={setWindowSize} label="Window" />}
        <MetricPicker selected={selected} unavailable={unavailable} onToggle={toggle} onSetMode={setMode} onReset={reset} />
        {!archived && <MetricCatalogDialog />}
      </div>
    </div>

    {activeRunId && <div className="capture-strip">
      <span>run <strong>{activeRunId}</strong></span>
      <span>received <strong>{data?.capture?.messages?.toLocaleString() || 0}</strong></span>
      <span>inferred TTI gaps <strong>{data?.capture?.missed_ttis?.toLocaleString() || 0}</strong></span>
      <span>bucket <strong>{data?.bucketMs ? `${data.bucketMs} ms` : '—'}</strong></span>
      {unavailable.length > 0 && <span>not in this run <strong>{unavailable.length}</strong></span>}
    </div>}

    {nothingSelected && <div className="empty-state">No metrics selected. Use <strong>Metrics</strong> to choose what to display.</div>}
    {combinedError && <div className="notice notice-error">Metrics: {combinedError}</div>}
    {!nothingSelected && !combinedError && loading && <div className="empty-state">Loading metrics…</div>}
    {!combinedError && !loading && !available && <div className="empty-state">No active recorded run. Use Start all to begin one.</div>}
    {!combinedError && available && series.length === 0 && !nothingSelected && <div className="empty-state">The recorder is ready. Values will appear when EdgeRIC reports a UE.</div>}
    {harqKeys.length > 0 && harqData?.capture?.complete === false && <div className="notice">
      HARQ run-wide capture warning: {harqData.capture.detail}
    </div>}

    {series.length > 0 && choices.length > 0 && <div className="directional-metrics">
      {choices.map((choice) => <DirectionalMetricRow
        key={choice.id} choice={choice} mode={selected[choice.id]} servable={servable} series={series}
      />)}
    </div>}
  </section>
}
