import path from 'node:path'
import { Router } from 'express'
import { allowedWindows, type WindowSize } from '../config.js'
import { DEFAULT_METRIC_KEYS, METRICS, METRICS_BY_KEY } from '../metrics-registry.js'
import { metricsCatalog } from '../services/metrics-catalog.js'
import { runMetricsQuery } from '../services/metrics-runner.js'
import type { RunStore } from '../services/run-store.js'

export function metricsRouter(store: RunStore) {
  const router = Router()

  /**
   * Metric keys are validated against the registry, so nothing from the query string ever
   * reaches the SQL builder -- only registry-owned column names do.
   */
  function parseMetrics(raw: unknown): string[] {
    if (typeof raw !== 'string' || !raw) return DEFAULT_METRIC_KEYS
    const keys = [...new Set(raw.split(',').map((key) => key.trim()).filter((key) => METRICS_BY_KEY.has(key)))]
    return keys.length ? keys.slice(0, METRICS.length) : DEFAULT_METRIC_KEYS
  }

  function request(id: string, window: WindowSize, metricKeys: string[], fullRun: boolean) {
    return {
      runId: id,
      dbPath: path.join(store.runDir(id), 'metrics.sqlite3'),
      isActive: store.readManifest(id)?.status === 'active',
      window, metricKeys, fullRun,
    }
  }

  router.get('/metrics/catalog', (_req, res) => res.json(metricsCatalog()))

  router.get('/metrics/live', async (req, res) => {
    const window = String(req.query.window || '5m') as WindowSize
    if (!(window in allowedWindows)) return res.status(400).json({ error: 'Unsupported metrics window.' })
    const id = store.activeId()
    if (!id) return res.json({ runId: null, available: false, metrics: [], unavailable: [], series: [], capture: null })
    try { return res.json(await runMetricsQuery(request(id, window, parseMetrics(req.query.metrics), false))) }
    catch (error) {
      console.error('Live metrics query failed:', error)
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Metrics are unavailable.' })
    }
  })

  router.get('/runs/:id/metrics', async (req, res) => {
    const window = String(req.query.window || '5m') as WindowSize
    if (!(window in allowedWindows)) return res.status(400).json({ error: 'Unsupported metrics window.' })
    if (!store.readManifest(req.params.id)) return res.status(404).json({ error: 'Run not found.' })
    try { return res.json(await runMetricsQuery(request(req.params.id, window, parseMetrics(req.query.metrics), req.query.full === '1'))) }
    catch (error) {
      console.error(`Archived metrics query failed for ${req.params.id}:`, error)
      return res.status(503).json({ error: error instanceof Error ? error.message : 'Metrics are unavailable.' })
    }
  })

  return router
}
