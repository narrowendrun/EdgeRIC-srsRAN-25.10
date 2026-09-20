import path from 'node:path'
import { Router } from 'express'
import { allowedWindows, type WindowSize } from '../config.js'
import { DEFAULT_METRIC_KEYS } from '../metrics-registry.js'
import { metricsCatalog } from '../services/metrics-catalog.js'
import { runMetricsQuery } from '../services/metrics-runner.js'
import type { RunStore } from '../services/run-store.js'

export function metricsRouter(store: RunStore) {
  const router = Router()

  function request(id: string, window: WindowSize, fullRun: boolean) {
    return {
      runId: id,
      dbPath: path.join(store.runDir(id), 'metrics.sqlite3'),
      isActive: store.readManifest(id)?.status === 'active',
      window, metricKeys: DEFAULT_METRIC_KEYS, fullRun,
    }
  }

  router.get('/metrics/catalog', (_req, res) => res.json(metricsCatalog()))

  router.get('/metrics/live', async (req, res) => {
    const window = String(req.query.window || '5m') as WindowSize
    if (!(window in allowedWindows)) return res.status(400).json({ error: 'Unsupported metrics window.' })
    const id = store.activeId()
    if (!id) return res.json({ runId: null, available: false, metrics: [], unavailable: [], series: [], capture: null })
    try { return res.json(await runMetricsQuery(request(id, window, false))) }
    catch (error) {
      console.error('Live metrics query failed:', error)
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Metrics are unavailable.' })
    }
  })

  router.get('/runs/:id/metrics', async (req, res) => {
    const window = String(req.query.window || '5m') as WindowSize
    if (!(window in allowedWindows)) return res.status(400).json({ error: 'Unsupported metrics window.' })
    if (!store.readManifest(req.params.id)) return res.status(404).json({ error: 'Run not found.' })
    try { return res.json(await runMetricsQuery(request(req.params.id, window, req.query.full === '1'))) }
    catch (error) {
      console.error(`Archived metrics query failed for ${req.params.id}:`, error)
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Metrics are unavailable.' })
    }
  })

  return router
}
