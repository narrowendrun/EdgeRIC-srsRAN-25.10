import { useEffect, useState } from 'react'
import type { RunManifest } from '../types'
import { rfLabels } from '../constants'
import { TelemetrySection } from './TelemetrySection'

function formatBytes(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

/**
 * What the bench looked like for this run. Without it an archived run cannot be attributed to a
 * scheduler or an RF configuration, and comparing two runs means nothing.
 */
function RunConditions({ run }: { run?: RunManifest }) {
  if (!run) return null
  const timeline = run.schedulerTimeline ?? []
  const rf = run.rf ?? {}
  return <section className="paper-note run-conditions">
    <div className="section-heading"><div><p className="section-kicker">run conditions</p><h2>Bench details</h2></div></div>
    <div className="detail-highlight-grid">
      <div className="detail-highlight"><span>Scheduling algorithm</span>
        <strong>{timeline.length ? (timeline[0].algorithm ?? 'none set') : 'not recorded'}</strong>
        <small>{timeline.length > 1 ? `changed ${timeline.length - 1} time${timeline.length === 2 ? '' : 's'} during the run` : 'unchanged for the whole run'}</small>
      </div>
      <div className="detail-highlight"><span>Build</span>
        <strong>{run.gitCommit}</strong><small>{run.configFile || 'config not recorded'}</small>
      </div>
    </div>
    {timeline.length > 1 && <ol className="scheduler-timeline">
      {timeline.map((entry, index) => <li key={`${entry.at}-${index}`}>
        <code>{new Date(entry.at).toLocaleTimeString()}</code>
        <strong>{entry.algorithm ?? 'none set'}</strong>
      </li>)}
    </ol>}
    {Object.keys(rf).length > 0 && <div className="rf-grid">
      {Object.entries(rfLabels).filter(([key]) => rf[key]).map(([key, label]) => <div className="rf-cell" key={key}>
        <span>{label}</span><strong>{rf[key]}</strong>
      </div>)}
    </div>}
  </section>
}

export function ArchiveView() {
  const [runs, setRuns] = useState<RunManifest[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [logTruncated, setLogTruncated] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = () => fetch('/api/runs', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Archive is unavailable')
      const data = await response.json() as { runs: RunManifest[] }
      setRuns(data.runs)
    }).catch((caught) => setError(caught instanceof Error ? caught.message : 'Archive is unavailable'))
    void load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selected) { setFiles([]); setSelectedFile(''); return }
    fetch(`/api/runs/${selected}/logs`).then((response) => response.json()).then((data: { files: string[] }) => {
      setFiles(data.files); setSelectedFile(data.files[0] || '')
    }).catch(() => setFiles([]))
  }, [selected])

  useEffect(() => {
    if (!selected || !selectedFile) { setLogLines([]); setLogTruncated(false); return }
    fetch(`/api/runs/${selected}/log?file=${encodeURIComponent(selectedFile)}`)
      .then((response) => response.json())
      .then((data: { lines: string[]; truncated?: boolean }) => {
        setLogLines(data.lines); setLogTruncated(Boolean(data.truncated))
      })
      .catch(() => { setLogLines(['Unable to read archived log.']); setLogTruncated(false) })
  }, [selected, selectedFile])

  return <section className="archive-view">
    <div className="section-heading"><div><p className="section-kicker">saved experiments</p><h2>Run archive</h2></div><span className="archive-count">{runs.length} run{runs.length === 1 ? '' : 's'}</span></div>
    {error && <div className="notice notice-error">{error}</div>}
    {!error && runs.length === 0 && <div className="empty-state">No recorded runs yet. A run is created when you use Start all.</div>}
    {runs.length > 0 && <div className="archive-table-wrap"><table className="archive-table">
      <thead><tr><th>Started</th><th>Duration</th><th>Status</th><th>UEs</th><th>Messages</th><th>Database</th></tr></thead>
      <tbody>{runs.map((run) => {
        const duration = ((new Date(run.endedAt || Date.now()).getTime() - new Date(run.startedAt).getTime()) / 1000)
        return <tr key={run.id} className={selected === run.id ? 'is-selected' : ''} onClick={() => setSelected(run.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setSelected(run.id) }}>
          <td><strong>{new Date(run.startedAt).toLocaleString()}</strong><small>{run.id}</small></td><td>{duration < 60 ? `${Math.round(duration)}s` : `${(duration / 60).toFixed(1)}m`}</td><td><span className={`run-status run-${run.status}`}>{run.status}</span></td><td>{run.observedRntis.join(', ') || '—'}</td><td>{run.metrics.messages.toLocaleString()}</td><td>{formatBytes(run.databaseBytes)}</td>
        </tr>
      })}</tbody>
    </table></div>}
    {selected && <div className="archive-detail">
      <button type="button" className="archive-close" onClick={() => setSelected(null)}>Close run details</button>
      <RunConditions run={runs.find((item) => item.id === selected)} />
      <TelemetrySection runId={selected} archived />
      <section className="paper-note archived-logs">
        <div className="section-heading"><div><p className="section-kicker">captured output</p><h2>Archived logs</h2></div><label>Source<select value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>{files.map((file) => <option value={file} key={file}>{file}</option>)}</select></label></div>
        {logTruncated && <p className="log-truncation-note">Showing the last {logLines.length.toLocaleString()} lines — this file was read from its final 2 MB.</p>}
        <pre className="terminal-output archived-output" tabIndex={0}>{selectedFile ? logLines.join('\n') || 'No lines captured.' : 'No archived logs found.'}</pre>
      </section>
    </div>}
  </section>
}
