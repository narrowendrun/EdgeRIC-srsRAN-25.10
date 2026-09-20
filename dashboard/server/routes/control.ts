import { Router } from 'express'
import type { ModuleName, ServiceAction } from '../config.js'
import { controlAll, controlModule, getStatus } from '../services/systemd.js'
import type { RunStore } from '../services/run-store.js'
import { sameOrigin } from '../utils.js'

export function controlRouter(store: RunStore) {
  const router = Router()
  router.post('/control/:target/:action', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin control requests are not allowed.' })
    const target = req.params.target
    const action = req.params.action
    if (!['open5gs', 'edgeric', 'gnb', 'all'].includes(target) || !['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported control target or action.' })
    }
    const status = await getStatus()
    if (!status.controlsReady) return res.status(503).json({ error: 'Managed service controls are not installed yet.' })

    if (action === 'start' || action === 'restart') {
      if (target === 'all' && store.activeId() && Object.values(status.modules).every((item) => item.state === 'inactive')) {
        await store.finalize('interrupted')
      }
      await store.ensureActive()
    }

    if (target === 'all') {
      const results = await controlAll(action as ServiceAction)
      const failed = results.find((result) => !result.ok)
      if (!failed && action === 'stop') await store.finalize('completed')
      return res.status(failed ? 500 : 200).json({ ok: !failed, results, runId: store.activeId() })
    }

    const result = await controlModule(target as ModuleName, action as ServiceAction)
    return res.status(result.ok ? 200 : 500).json(result.ok ? { ok: true, runId: store.activeId() } : { error: result.stderr || 'Service action failed.' })
  })
  return router
}
