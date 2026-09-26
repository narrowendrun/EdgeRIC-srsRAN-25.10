import { useRef } from 'react'
import { moduleLabels, rfLabels } from '../constants'
import type { Action, DashboardStatus, ModuleName, ModuleState } from '../types'
import { StatusLamp } from './StatusLamp'

interface Props {
  status: DashboardStatus | null
  pendingAction: string
  onAction: (target: ModuleName | 'all', action: Action) => void
  onSchedulerSelect: (algorithm: string) => void
}

export function StatusBoard({ status, pendingAction, onAction, onSchedulerSelect }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const controlsDisabled = !status?.controlsReady || Boolean(pendingAction)
  const ueState: ModuleState = !status?.ues.fresh ? 'unknown' : (status.ues.count || 0) > 0 ? 'active' : 'inactive'
  const ueSummary = status?.ues.fresh ? `${status.ues.count} connected` : 'telemetry unavailable'
  const iperfEndpoint = status
    ? `${status.iperf3.address}:${status.iperf3.ports?.[0] ?? status.iperf3.port}–${status.iperf3.ports?.at(-1) ?? status.iperf3.port}`
    : '—'
  // Set externally with `redis-cli SET scheduling_algorithm`; the dashboard only reports it.
  const scheduler = status?.scheduler
  const schedulerState: ModuleState = !scheduler ? 'unknown'
    : !scheduler.available ? 'inactive'
    : scheduler.algorithm && scheduler.known && scheduler.muappRunning && scheduler.controlActive ? 'active'
    : 'degraded'

  return <>
    <section className="status-board" aria-label="Live radio stack status">
      <div className="board-heading">
        <div><p className="section-kicker">live status</p><h2>Radio stack</h2></div>
        <button type="button" className="info-button" aria-haspopup="dialog" aria-controls="bench-details-dialog" onClick={() => dialogRef.current?.showModal()}>
          <span className="info-glyph" aria-hidden="true">i</span> Bench details
        </button>
      </div>
      <div className="status-summary-grid">
        {(Object.keys(moduleLabels) as ModuleName[]).map((module) => {
          const item = status?.modules[module] || { state: 'unknown' as const, detail: 'checking…', managed: false }
          return <div className="summary-cell" key={module}>
            <span className="summary-label"><StatusLamp state={item.state} /> {moduleLabels[module]}</span>
            <strong>{item.state}</strong>
          </div>
        })}
        <div className="summary-cell">
          <span className="summary-label"><StatusLamp state={ueState} /> Connected UEs</span>
          <strong>{ueSummary}</strong>
          {status?.ues.rntis.length ? <small>{status.ues.rntis.join(', ')}</small> : null}
        </div>
        <div className="summary-cell">
          <span className="summary-label"><StatusLamp state={status?.iperf3.state || 'unknown'} /> iperf3 server</span>
          <strong>{iperfEndpoint}</strong><small>{status?.iperf3.detail || 'checking…'}</small>
        </div>
        <div className="summary-cell">
          <span className="summary-label"><StatusLamp state={schedulerState} /> Applied scheduler</span>
          <select className="scheduler-select" aria-label="Scheduling algorithm"
            value={scheduler?.algorithm || ''} disabled={!scheduler?.muappRunning || pendingAction === 'scheduler-select'}
            onChange={(event) => onSchedulerSelect(event.target.value)}>
            {!scheduler?.algorithm && <option value="">none set</option>}
            {(scheduler?.algorithms || []).map((algorithm) => <option key={algorithm} value={algorithm}>{algorithm}</option>)}
          </select>
          <small>{status?.scheduler?.detail || 'checking…'}</small>
        </div>
      </div>
    </section>

    <dialog className="details-dialog" id="bench-details-dialog" ref={dialogRef} onClick={(event) => { if (event.target === dialogRef.current) dialogRef.current.close() }}>
      <div className="details-paper">
        <div className="dialog-heading">
          <div><p className="section-kicker">RF, services &amp; controls</p><h2>Bench details</h2></div>
          <button type="button" className="dialog-close" onClick={() => dialogRef.current?.close()}>Close <span aria-hidden="true">×</span></button>
        </div>
        <p className="dialog-intro">Live configuration and service health. UE presence comes from recent EdgeRIC MAC telemetry; the iperf3 endpoint is the Open5GS <code>ogstun</code> address.</p>
        <div className="detail-highlight-grid">
          <div className="detail-highlight"><span>Connected UEs</span><strong>{ueSummary}</strong><small>{status?.ues.rntis.length ? `RNTI ${status.ues.rntis.join(', ')}` : 'No current RNTI reported'}</small></div>
          <div className="detail-highlight"><span>iperf3 service</span><strong>{status?.iperf3.state || 'unknown'} · {iperfEndpoint}</strong><small>{status?.iperf3.detail || 'checking…'}</small></div>
        </div>
        <div className="detail-highlight-grid">
          <div className="detail-highlight"><span>Applied scheduling algorithm</span>
            <strong>{scheduler?.appliedAlgorithm || 'not evidenced'}</strong>
            <small>{scheduler?.detail || 'checking…'}{scheduler?.appliedEpoch ? ` · epoch ${scheduler.appliedEpoch}` : ''}</small>
          </div>
          <div className="detail-highlight"><span>Scheduling muApp</span>
            <strong>{scheduler?.muappRunning ? 'running' : 'not running'}</strong>
            <small>{scheduler?.controlActive ? `DL ${scheduler.dlEligibleRntis.join(', ') || 'none'} · UL ${scheduler.ulEligibleRntis.join(', ') || 'none'}` : 'gNB control is fail-open until fresh decisions arrive'}</small>
          </div>
        </div>
        <div className="rf-grid">
          {Object.entries(rfLabels).map(([key, label]) => <div className="rf-cell" key={key}><span>{label}</span><strong>{status?.rf[key] || '—'}</strong></div>)}
        </div>
        <div className="module-grid">
          {(Object.keys(moduleLabels) as ModuleName[]).map((module) => {
            const item = status?.modules[module] || { state: 'unknown' as const, detail: 'checking…', managed: false }
            return <article className="paper-note module-note" key={module}>
              <div className="module-title"><StatusLamp state={item.state} /><h3>{moduleLabels[module]}</h3><span className="state-label">{item.state}</span></div>
              <p>{item.detail}</p>
              <div className="module-controls" aria-label={`${moduleLabels[module]} controls`}>
                {(['start', 'restart', 'stop'] as Action[]).map((action) => <button type="button" key={action} disabled={controlsDisabled} onClick={() => onAction(module, action)}>{pendingAction === `${module}-${action}` ? 'working…' : action}</button>)}
              </div>
            </article>
          })}
        </div>
        <div className="all-controls">
          <span>{status?.controlsReady ? 'Managed controls ready' : 'Run the service installer to enable controls and recording'}</span>
          <div>
            <button type="button" disabled={controlsDisabled} onClick={() => onAction('all', 'start')}>Start all</button>
            <button type="button" disabled={controlsDisabled} onClick={() => onAction('all', 'restart')}>Restart all</button>
            <button type="button" className="danger-button" disabled={controlsDisabled} onClick={() => onAction('all', 'stop')}>Stop all</button>
          </div>
        </div>
      </div>
    </dialog>
  </>
}
