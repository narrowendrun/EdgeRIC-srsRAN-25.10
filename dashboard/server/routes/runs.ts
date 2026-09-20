import { readFileSync } from 'node:fs'
import { Router } from 'express'
import type { RunStore } from '../services/run-store.js'

export function runsRouter(store: RunStore) {
  const router = Router()
  router.get('/runs', (_req, res) => res.json({ activeRunId: store.activeId(), runs: store.list() }))
  router.get('/runs/:id/logs', (req, res) => {
    if (!store.readManifest(req.params.id)) return res.status(404).json({ error: 'Run not found.' })
    res.json({ files: store.logFiles(req.params.id) })
  })
  router.get('/runs/:id/log', (req, res) => {
    const file = store.resolveLog(req.params.id, String(req.query.file || ''))
    if (!file) return res.status(404).json({ error: 'Archived log not found.' })
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(-5000)
    res.json({ file: String(req.query.file), lines })
  })
  return router
}
