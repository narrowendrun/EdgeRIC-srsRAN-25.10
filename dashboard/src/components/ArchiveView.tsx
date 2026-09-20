import { useEffect, useState } from 'react'
import type { RunManifest } from '../types'
import { ChartsSection } from './ChartsSection'

function formatBytes(bytes: number) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function ArchiveView() {
  const [runs, setRuns] = useState<RunManifest[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [selectedFile, setSelectedFile] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
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
    if (!selected || !selectedFile) { setLogLines([]); return }
    fetch(`/api/runs/${selected}/log?file=${encodeURIComponent(selectedFile)}`).then((response) => response.json()).then((data: { lines: string[] }) => setLogLines(data.lines)).catch(() => setLogLines(['Unable to read archived log.']))
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
      <ChartsSection runId={selected} archived />
      <section className="paper-note archived-logs">
        <div className="section-heading"><div><p className="section-kicker">captured output</p><h2>Archived logs</h2></div><label>Source<select value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)}>{files.map((file) => <option value={file} key={file}>{file}</option>)}</select></label></div>
        <pre className="terminal-output archived-output" tabIndex={0}>{selectedFile ? logLines.join('\n') || 'No lines captured.' : 'No archived logs found.'}</pre>
      </section>
    </div>}
  </section>
}
