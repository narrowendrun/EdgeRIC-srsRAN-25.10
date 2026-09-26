import { Router } from 'express'
import type { ModuleName, ServiceAction } from '../config.js'
import { controlAll, controlModule, getStatus } from '../services/systemd.js'
import type { RunStore } from '../services/run-store.js'
import { sameOrigin } from '../utils.js'
import { isKnownAlgorithm, type SchedulingAlgorithm } from '../scheduler-registry.js'
import { readSchedulerAlgorithm, requestScheduler, waitForAppliedScheduler } from '../services/scheduler.js'

export function controlRouter(store: RunStore) {
  const router = Router()
  router.post('/scheduler/select', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin control requests are not allowed.' })
    const algorithm = typeof req.body?.algorithm === 'string' ? req.body.algorithm : null
    if (!isKnownAlgorithm(algorithm)) return res.status(400).json({ error: 'Unknown scheduling algorithm.' })
    if (store.busy) return res.status(409).json({ error: 'Another run or service transition is in progress.' })
    store.busy = true
    try {
      const current = await readSchedulerAlgorithm()
      if (current.algorithm === algorithm && current.policyEpoch) {
        return res.json({ ok: true, unchanged: true, policyEpoch: current.policyEpoch, runId: store.activeId() })
      }
      await store.ensureActive()
      const policyEpoch = await requestScheduler(algorithm as SchedulingAlgorithm)
      const applied = await waitForAppliedScheduler(algorithm, policyEpoch)
      if (!applied) {
        return res.status(504).json({
          error: `Scheduler epoch ${policyEpoch} was requested but the gNB did not evidence application within 5 seconds.`,
          policyEpoch,
        })
      }
      const runId = await store.rotateForScheduler(algorithm, policyEpoch)
      return res.json({ ok: true, algorithm, policyEpoch, runId, appliedAtSlot: applied.nativeSlot })
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'Scheduler switch failed.' })
    } finally {
      store.busy = false
    }
  })

  router.post('/control/:target/:action', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin control requests are not allowed.' })
    const target = req.params.target
    const action = req.params.action
    if (!['open5gs', 'edgeric', 'scheduler', 'gnb', 'all'].includes(target) || !['start', 'stop', 'restart'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported control target or action.' })
    }

    // Hold the reconciler off: mid-restart every unit reads inactive, which would otherwise
    // look like the stack having stopped outside the dashboard.
    store.busy = true
    try {
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
    } finally {
      store.busy = false
    }
  })
  return router
}
