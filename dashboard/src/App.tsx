import { useEffect, useMemo, useState } from 'react'
import { ArchiveView } from './components/ArchiveView'
import { TelemetrySection } from './components/TelemetrySection'
import { LiveTerminal } from './components/LiveTerminal'
import { StatusBoard } from './components/StatusBoard'
import { moduleLabels } from './constants'
import { useStatus } from './hooks/useStatus'
import type { Action, ModuleName } from './types'

function App() {
  const { status, error: statusError, refresh } = useStatus()
  const [view, setView] = useState<'live' | 'archive'>('live')
  const [pendingAction, setPendingAction] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const context = document.modelContext
    if (!context?.registerTool) return
    const lifecycle = new AbortController()
    void Promise.resolve(context.registerTool({
      name: 'get_edge_stack_status', title: 'Get radio stack status',
      description: 'Read the current Open5GS, EdgeRIC, gNB and X310 status shown by the dashboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      async execute() {
        const response = await fetch('/api/status', { cache: 'no-store' })
        if (!response.ok) throw new Error('Unable to read radio stack status.')
        return response.json()
      },
    }, { signal: lifecycle.signal })).catch(() => undefined)
    void Promise.resolve(context.registerTool({
      name: 'control_edge_stack_module', title: 'Control radio stack module',
      description: 'Start, stop or restart Open5GS, EdgeRIC, the gNB, or all three in dependency order.',
      inputSchema: {
        type: 'object', properties: {
          target: { type: 'string', enum: ['open5gs', 'edgeric', 'gnb', 'all'] },
          action: { type: 'string', enum: ['start', 'stop', 'restart'] },
        }, required: ['target', 'action'], additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        const value = input as { target?: string; action?: string }
        if (!value || !['open5gs', 'edgeric', 'gnb', 'all'].includes(value.target || '') || !['start', 'stop', 'restart'].includes(value.action || '')) throw new Error('Invalid module target or service action.')
        const response = await fetch(`/api/control/${value.target}/${value.action}`, { method: 'POST' })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Service action failed.')
        await refresh()
        return { ok: true, target: value.target, action: value.action, runId: result.runId }
      },
    }, { signal: lifecycle.signal })).catch(() => undefined)
    return () => lifecycle.abort()
  }, [refresh])

  const webuiUrl = useMemo(() => status ? `${window.location.protocol}//${window.location.hostname}:${status.webui.proxyPort}` : '#', [status])
  const displayedTimestamp = status ? new Date(status.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'

  async function runAction(target: ModuleName | 'all', action: Action) {
    if ((action === 'stop' || action === 'restart') && target === 'all' && !window.confirm(`${action === 'stop' ? 'Stop' : 'Restart'} the gNB, EdgeRIC and Open5GS?`)) return
    const key = `${target}-${action}`
    setPendingAction(key); setNotice('')
    try {
      const response = await fetch(`/api/control/${target}/${action}`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'service action failed')
      setNotice(`${target === 'all' ? 'All modules' : moduleLabels[target]}: ${action} completed.`)
      await refresh()
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : 'service action failed')
    } finally {
      setPendingAction('')
    }
  }

  return <main className="workbench-shell">
    <header className="masthead">
      <div><p className="eyebrow">vriika-fiend / radio bench</p><h1>EdgeRIC Workbench</h1></div>
      <div className="masthead-actions"><span className="clock-readout">updated {displayedTimestamp}</span><a className={`button-link ${status?.webui.available ? '' : 'is-muted'}`} href={webuiUrl} target="_blank" rel="noopener noreferrer">Subscriber console ↗</a></div>
    </header>
    <nav className="view-tabs" aria-label="Dashboard view">
      <button type="button" className={view === 'live' ? 'is-active' : ''} aria-current={view === 'live' ? 'page' : undefined} onClick={() => setView('live')}>Live workbench</button>
      <button type="button" className={view === 'archive' ? 'is-active' : ''} aria-current={view === 'archive' ? 'page' : undefined} onClick={() => setView('archive')}>Run archive</button>
    </nav>
    {statusError && <div className="notice notice-error" role="alert">Status feed: {statusError}</div>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {view === 'live' ? <>
      <StatusBoard status={status} pendingAction={pendingAction} onAction={runAction} />
      <TelemetrySection />
      <LiveTerminal />
    </> : <ArchiveView />}
  </main>
}

export default App
