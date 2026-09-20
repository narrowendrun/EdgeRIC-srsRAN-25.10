import { useMemo, useState } from 'react'
import { useMetrics } from '../hooks/useMetrics'
import { chartCards, useTelemetryPrefs } from '../hooks/useTelemetryPrefs'
import type { WindowSize } from '../types'
import { MetricCatalogDialog } from './MetricCatalogDialog'
import { MetricChart } from './MetricChart'
import { MetricPicker } from './MetricPicker'
import { NumericTile } from './NumericTile'
import { WindowSelect } from './WindowSelect'

export function TelemetrySection({ runId, archived = false }: { runId?: string; archived?: boolean }) {
  const [windowSize, setWindowSize] = useState<WindowSize>('5m')
  const [fullRun, setFullRun] = useState(archived)
  const { selected, toggle, setMode, reset, keys, numeric, charted } = useTelemetryPrefs()
  const { data, error } = useMetrics(windowSize, keys, runId, fullRun)

  const series = data?.series || []
  const unavailable = data?.unavailable || []
  // A pre-v2 archive has no MCS or scheduling columns; drop those rather than render empty cards.
  const servable = useMemo(() => new Set(data?.metrics || keys), [data?.metrics, keys])
  const numericShown = numeric.filter((metric) => servable.has(metric.key))
  const cards = useMemo(
    () => chartCards(charted.filter((metric) => servable.has(metric.key))),
    [charted, servable],
  )

  const headingId = archived ? 'archive-telemetry-heading' : 'telemetry-heading'
  const nothingSelected = keys.length === 0

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

    {data?.runId && <div className="capture-strip">
      <span>run <strong>{data.runId}</strong></span>
      <span>received <strong>{data.capture?.messages?.toLocaleString() || 0}</strong></span>
      <span>inferred TTI gaps <strong>{data.capture?.missed_ttis?.toLocaleString() || 0}</strong></span>
      <span>bucket <strong>{data.bucketMs ? `${data.bucketMs} ms` : '—'}</strong></span>
      {unavailable.length > 0 && <span>not in this run <strong>{unavailable.length}</strong></span>}
    </div>}

    {nothingSelected && <div className="empty-state">No metrics selected. Use <strong>Metrics</strong> to choose what to display.</div>}
    {error && <div className="notice notice-error">Metrics: {error}</div>}
    {!nothingSelected && !error && !data && <div className="empty-state">Loading metrics…</div>}
    {!error && data && !data.available && <div className="empty-state">No active recorded run. Use Start all to begin one.</div>}
    {!error && data?.available && series.length === 0 && !nothingSelected && <div className="empty-state">The recorder is ready. Values will appear when EdgeRIC reports a UE.</div>}

    {series.length > 0 && numericShown.length > 0 && <div className="numeric-grid">
      {numericShown.map((metric) => <NumericTile key={metric.key} metric={metric} series={series} />)}
    </div>}
    {series.length > 0 && cards.length > 0 && <div className="chart-grid">
      {cards.map((card) => <MetricChart key={card.title} card={card} series={series} />)}
    </div>}
  </section>
}
