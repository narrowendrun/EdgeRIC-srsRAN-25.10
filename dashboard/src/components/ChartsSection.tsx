import { useMemo, useState } from 'react'
import {
  CHART_GROUP_TITLES, DEFAULT_METRIC_KEYS, resolveMetrics, type MetricDef,
} from '../../server/metrics-registry'
import { useMetrics } from '../hooks/useMetrics'
import type { WindowSize } from '../types'
import { MetricCatalogDialog } from './MetricCatalogDialog'
import { MetricChart, type ChartCard } from './MetricChart'
import { WindowSelect } from './WindowSelect'

/**
 * Groups metrics into cards: those sharing a chartGroup become one multi-line card, the rest
 * stand alone. Registry order decides card order and line order within a card.
 */
export function chartCards(metrics: MetricDef[]): ChartCard[] {
  const cards: ChartCard[] = []
  const seen = new Set<string>()
  for (const metric of metrics) {
    if (!metric.chartGroup) {
      cards.push({ title: metric.label, unit: metric.unit, domain: metric.domain, metrics: [metric] })
      continue
    }
    if (seen.has(metric.chartGroup)) continue
    seen.add(metric.chartGroup)
    const members = metrics.filter((item) => item.chartGroup === metric.chartGroup)
    cards.push({
      title: CHART_GROUP_TITLES[metric.chartGroup] || metric.label,
      unit: metric.unit, domain: metric.domain, metrics: members,
    })
  }
  return cards
}

export function ChartsSection({ runId, archived = false }: { runId?: string; archived?: boolean }) {
  const [windowSize, setWindowSize] = useState<WindowSize>('5m')
  const [fullRun, setFullRun] = useState(archived)
  const { data, error } = useMetrics(windowSize, runId, fullRun)
  const series = data?.series || []
  const cards = useMemo(() => chartCards(resolveMetrics(data?.metrics ?? DEFAULT_METRIC_KEYS)), [data?.metrics])

  return <section className="charts-section" aria-labelledby={archived ? 'archive-charts-heading' : 'charts-heading'}>
    <div className="section-heading">
      <div><p className="section-kicker">{archived ? 'recorded telemetry' : 'rolling telemetry'}</p><h2 id={archived ? 'archive-charts-heading' : 'charts-heading'}>{archived ? 'Run charts' : 'UE radio metrics'}</h2></div>
      <div className="section-tools">
        {archived && <button type="button" aria-pressed={fullRun} onClick={() => setFullRun((value) => !value)}>{fullRun ? 'Entire run' : 'Rolling window'}</button>}
        {!fullRun && <WindowSelect value={windowSize} onChange={setWindowSize} label="Window" />}
        {!archived && <MetricCatalogDialog />}
      </div>
    </div>
    {data?.runId && <div className="capture-strip"><span>run <strong>{data.runId}</strong></span><span>received <strong>{data.capture?.messages?.toLocaleString() || 0}</strong></span><span>inferred TTI gaps <strong>{data.capture?.missed_ttis?.toLocaleString() || 0}</strong></span><span>bucket <strong>{data.bucketMs ? `${data.bucketMs} ms` : '—'}</strong></span></div>}
    {error && <div className="notice notice-error">Metrics: {error}</div>}
    {!error && !data && <div className="empty-state">Loading metrics…</div>}
    {!error && data && !data.available && <div className="empty-state">No active recorded run. Use Start all to begin one.</div>}
    {!error && data?.available && series.length === 0 && <div className="empty-state">The recorder is ready. Charts will appear when EdgeRIC reports a UE.</div>}
    {series.length > 0 && <div className="chart-grid">
      {cards.map((card) => <MetricChart key={card.title} card={card} series={series} />)}
    </div>}
  </section>
}
