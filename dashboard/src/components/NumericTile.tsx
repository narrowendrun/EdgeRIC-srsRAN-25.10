import type { MetricDef } from '../../server/metrics-registry'
import type { MetricSeries } from '../types'

function format(value: number | undefined, precision: number) {
  return value === undefined ? '—' : value.toFixed(precision)
}

export function NumericTile({ metric, series }: { metric: MetricDef; series: MetricSeries[] }) {
  return <article className="paper-note numeric-tile">
    <div className="chart-title"><h3>{metric.label}</h3><span>{metric.unit}</span></div>
    {series.length === 0 && <p className="numeric-idle">no UE reporting</p>}
    {series.map((ue) => {
      const stat = ue.summary?.[metric.key]
      return <div className="numeric-row" key={ue.rnti}>
        <span className="numeric-rnti">{ue.label}</span>
        <strong className="numeric-value">{format(stat?.last, metric.precision)}</strong>
        <small className="numeric-range">
          <span>min {format(stat?.min, metric.precision)}</span>
          <span>max {format(stat?.max, metric.precision)}</span>
          <span>avg {format(stat?.avg, metric.precision)}</span>
        </small>
      </div>
    })}
  </article>
}
