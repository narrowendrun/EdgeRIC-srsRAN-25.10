import { useMemo, useState } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useMetrics } from '../hooks/useMetrics'
import type { MetricSeries, WindowSize } from '../types'
import { MetricCatalogDialog } from './MetricCatalogDialog'
import { WindowSelect } from './WindowSelect'

const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']
type MetricKey = 'snr' | 'cqi' | 'dlMbps' | 'ulMbps' | 'dlBler' | 'ulBler'

interface LineSpec { key: MetricKey; suffix: string; dashed?: boolean }

export function ChartsSection({ runId, archived = false }: { runId?: string; archived?: boolean }) {
  const [windowSize, setWindowSize] = useState<WindowSize>('5m')
  const [fullRun, setFullRun] = useState(archived)
  const { data, error } = useMetrics(windowSize, runId, fullRun)
  const series = data?.series || []

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
      <MetricChart title="Throughput" unit="Mbps" series={series} lines={[{ key: 'dlMbps', suffix: 'DL' }, { key: 'ulMbps', suffix: 'UL', dashed: true }]} />
      <MetricChart title="SNR" unit="dB" series={series} lines={[{ key: 'snr', suffix: 'SNR' }]} />
      <MetricChart title="CQI" unit="index" series={series} lines={[{ key: 'cqi', suffix: 'CQI' }]} domain={[0, 15]} />
      <MetricChart title="BLER" unit="%" series={series} lines={[{ key: 'dlBler', suffix: 'DL' }, { key: 'ulBler', suffix: 'UL', dashed: true }]} domain={[0, 100]} />
    </div>}
  </section>
}

function MetricChart({ title, unit, series, lines, domain }: { title: string; unit: string; series: MetricSeries[]; lines: LineSpec[]; domain?: [number, number] }) {
  const { rows, keys } = useMemo(() => {
    const buckets = new Map<number, Record<string, number>>()
    const generated: Array<{ dataKey: string; name: string; color: string; dashed?: boolean }> = []
    series.forEach((item, seriesIndex) => lines.forEach((line, lineIndex) => {
      const dataKey = `${item.rnti}_${line.key}`
      generated.push({ dataKey, name: `${item.label} ${line.suffix}`, color: colors[(seriesIndex + lineIndex * 2) % colors.length], dashed: line.dashed })
      item.points.forEach((point) => {
        const row = buckets.get(point.timestamp) || { timestamp: point.timestamp }
        row[dataKey] = point[line.key]
        buckets.set(point.timestamp, row)
      })
    }))
    return { rows: [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp), keys: generated }
  }, [lines, series])

  return <article className="paper-note chart-card">
    <div className="chart-title"><h3>{title}</h3><span>{unit}</span></div>
    <div className="chart-canvas">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 5" vertical={false} />
          <XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} minTickGap={44} />
          <YAxis domain={domain || ['auto', 'auto']} width={54} />
          <Tooltip labelFormatter={(value) => new Date(Number(value)).toLocaleTimeString()} formatter={(value) => [typeof value === 'number' ? value.toFixed(2) : value, unit]} />
          <Legend />
          {keys.map((line) => <Line key={line.dataKey} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={false} connectNulls={false} strokeDasharray={line.dashed ? '7 4' : undefined} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  </article>
}
