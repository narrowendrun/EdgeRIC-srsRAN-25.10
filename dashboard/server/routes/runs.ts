import { statSync } from 'node:fs'
import { Router } from 'express'
import type { RunStore } from '../services/run-store.js'
import { run } from '../utils.js'

/** Bounded so a multi-hundred-megabyte capture cannot be read into memory in one go. */
const logTailBytes = 2 * 1024 * 1024
const logTailLines = 5000

export function runsRouter(store: RunStore) {
  const router = Router()
  router.get('/runs', async (_req, res) => res.json({ activeRunId: store.activeId(), runs: await store.list() }))
  router.get('/runs/:id/logs', (req, res) => {
    if (!store.readManifest(req.params.id)) return res.status(404).json({ error: 'Run not found.' })
    res.json({ files: store.logFiles(req.params.id) })
  })
  router.get('/runs/:id/log', async (req, res) => {
    const file = store.resolveLog(req.params.id, String(req.query.file || ''))
    if (!file) return res.status(404).json({ error: 'Archived log not found.' })
    const truncated = statSync(file).size > logTailBytes
    const result = await run('/usr/bin/tail', ['-c', String(logTailBytes), file], 10_000)
    if (!result.ok) return res.status(500).json({ error: 'Unable to read archived log.' })
    const all = result.stdout.split(/\r?\n/)
    // A byte-bounded tail can cut the first line mid-way.
    const lines = (truncated ? all.slice(1) : all).slice(-logTailLines)
    res.json({ file: String(req.query.file), lines, truncated })
  })
  return router
}
