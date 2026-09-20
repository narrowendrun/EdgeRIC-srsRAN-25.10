import { useRef } from 'react'
import { METRICS, type MetricGroup, type MetricMode } from '../../server/metrics-registry'

const groupOrder: MetricGroup[] = ['Radio', 'Throughput', 'Reliability', 'Scheduling', 'Latency']

interface Props {
  selected: Record<string, MetricMode>
  unavailable: string[]
  onToggle: (key: string) => void
  onSetMode: (key: string, mode: MetricMode) => void
  onReset: () => void
}

export function MetricPicker({ selected, unavailable, onToggle, onSetMode, onReset }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const count = Object.keys(selected).length

  return <>
    <button type="button" className="info-button" aria-haspopup="dialog" onClick={() => dialogRef.current?.showModal()}>
      <span className="info-glyph" aria-hidden="true">≡</span> Metrics ({count})
    </button>
    <dialog className="details-dialog picker-dialog" ref={dialogRef} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current.close() }}>
      <div className="details-paper">
        <div className="dialog-heading">
          <div><p className="section-kicker">what to record and show</p><h2>Telemetry metrics</h2></div>
          <div className="picker-heading-actions">
            <button type="button" onClick={onReset}>Reset to defaults</button>
            <button type="button" onClick={() => dialogRef.current?.close()}>Close <span aria-hidden="true">×</span></button>
          </div>
        </div>
        <p className="dialog-intro">
          Every metric is captured for every run regardless of what is ticked here — this chooses
          what the dashboard displays, so archived runs stay complete and comparable. Pick
          <strong> number</strong> for a live value with its window min, max and average, or
          <strong> chart</strong> for a time series.
        </p>
        <div className="picker-groups">
          {groupOrder.map((group) => <section className="picker-group" key={group}>
            <h3>{group}</h3>
            {METRICS.filter((metric) => metric.group === group).map((metric) => {
              const mode = selected[metric.key]
              const missing = unavailable.includes(metric.key)
              return <div className={`picker-row${missing ? ' is-unavailable' : ''}`} key={metric.key}>
                <label>
                  <input type="checkbox" checked={Boolean(mode)} onChange={() => onToggle(metric.key)} />
                  <span className="picker-label">{metric.label}</span>
                  <span className="picker-unit">{metric.unit}</span>
                </label>
                {missing
                  ? <span className="picker-missing">not recorded in this run</span>
                  : <div className="mode-toggle" role="group" aria-label={`${metric.label} display mode`}>
                      {(['numeric', 'chart'] as MetricMode[]).map((option) => <button
                        type="button" key={option} disabled={!mode}
                        className={mode === option ? 'is-active' : ''}
                        aria-pressed={mode === option}
                        onClick={() => onSetMode(metric.key, option)}
                      >{option === 'numeric' ? 'number' : 'chart'}</button>)}
                    </div>}
              </div>
            })}
          </section>)}
        </div>
      </div>
    </dialog>
  </>
}
