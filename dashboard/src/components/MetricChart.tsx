import { useMemo } from 'react'
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import type { MetricDef } from '../../server/metrics-registry'
import type { MetricSeries } from '../types'

const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']

export interface ChartCard {
  title: string
  unit: string
  domain?: [number, number]
  metrics: MetricDef[]
}

export function MetricChart({ card, series }: { card: ChartCard; series: MetricSeries[] }) {
  const { rows, keys } = useMemo(() => {
    const buckets = new Map<number, Record<string, number>>()
    const generated: Array<{ dataKey: string; name: string; color: string; dashed?: boolean }> = []
    series.forEach((item, seriesIndex) => card.metrics.forEach((metric, lineIndex) => {
      const dataKey = `${item.rnti}_${metric.key}`
      generated.push({
        dataKey,
        name: `${item.label} ${metric.lineSuffix}`,
        color: colors[(seriesIndex + lineIndex * 2) % colors.length],
        dashed: lineIndex > 0,
      })
      item.points.forEach((point) => {
        const row = buckets.get(point.timestamp) || { timestamp: point.timestamp }
        row[dataKey] = point[metric.key]
        buckets.set(point.timestamp, row)
      })
    }))
    return { rows: [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp), keys: generated }
  }, [card, series])

  return <article className="paper-note chart-card">
    <div className="chart-title"><h3>{card.title}</h3><span>{card.unit}</span></div>
    <div className="chart-canvas">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 4, left: -12 }}>
          <CartesianGrid stroke="var(--chart-grid)" strokeDasharray="2 5" vertical={false} />
          <XAxis dataKey="timestamp" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} minTickGap={44} />
          <YAxis domain={card.domain || ['auto', 'auto']} width={54} />
          <Tooltip labelFormatter={(value) => new Date(Number(value)).toLocaleTimeString()} formatter={(value) => [typeof value === 'number' ? value.toFixed(2) : value, card.unit]} />
          <Legend />
          {keys.map((line) => <Line key={line.dataKey} type="monotone" dataKey={line.dataKey} name={line.name} stroke={line.color} strokeWidth={2} dot={false} connectNulls={false} strokeDasharray={line.dashed ? '7 4' : undefined} isAnimationActive={false} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  </article>
}
