import { useEffect, useRef, useState } from 'react'
import { moduleLabels } from '../constants'
import { useLogs } from '../hooks/useLogs'
import type { ModuleName, WindowSize } from '../types'
import { WindowSelect } from './WindowSelect'

export function LiveTerminal() {
  const [activeTab, setActiveTab] = useState<ModuleName>('gnb')
  const [windowSize, setWindowSize] = useState<WindowSize>('5m')
  const [autoScroll, setAutoScroll] = useState(true)
  const { logs, setLogs, state } = useLogs(activeTab, windowSize)
  const terminalRef = useRef<HTMLPreElement>(null)
  useEffect(() => { if (autoScroll && terminalRef.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight }, [logs, autoScroll])

  return <section className="paper-note terminal-section" aria-labelledby="terminal-heading">
    <div className="terminal-heading">
      <div><p className="section-kicker">streaming output</p><h2 id="terminal-heading">Live terminal</h2></div>
      <div className="section-tools">
        <WindowSelect value={windowSize} onChange={setWindowSize} />
        <button type="button" aria-pressed={autoScroll} onClick={() => setAutoScroll((value) => !value)}>Auto-scroll {autoScroll ? 'on' : 'off'}</button>
        <button type="button" onClick={() => setLogs([])}>Clear view</button>
      </div>
    </div>
    <div className="terminal-tabs" role="tablist" aria-label="Log source">
      {(Object.keys(moduleLabels) as ModuleName[]).map((module) => <button type="button" role="tab" aria-selected={activeTab === module} className={activeTab === module ? 'is-active' : ''} key={module} onClick={() => setActiveTab(module)}>{moduleLabels[module]}</button>)}
      <span className={`stream-state stream-${state}`}>{state}</span>
    </div>
    <pre className="terminal-output" ref={terminalRef} tabIndex={0}>{logs.length ? logs.join('\n') : `[${moduleLabels[activeTab]}] waiting for log output…`}</pre>
  </section>
}
