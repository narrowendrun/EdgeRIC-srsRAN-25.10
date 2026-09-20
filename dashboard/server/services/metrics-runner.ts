import { Worker } from 'node:worker_threads'
import { queryMetrics, type MetricsResult, type QueryRequest } from './metrics-query.js'

/**
 * node:sqlite's DatabaseSync has no async API, so a chart query blocks the entire event loop --
 * measured at 0.265 s for a 5 m window, against a 2 s poll. That stalls SSE log streaming,
 * /api/status and control POSTs behind it. Running the query in a worker thread keeps the main
 * loop free without changing the query itself.
 *
 * Falls back to running in-process if the worker cannot start, so the dashboard degrades to its
 * previous behaviour rather than failing.
 */

/** Marks a worker-level failure, as opposed to a query that legitimately threw. */
class WorkerFailure extends Error {}

interface Pending { resolve: (value: MetricsResult) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let disabled = false
let nextId = 1
const pending = new Map<number, Pending>()

function rejectAll(error: Error) {
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}

function ensureWorker(): Worker | null {
  if (disabled) return null
  if (worker) return worker
  try {
    // tsx runs the .ts sources directly in development; the build emits .js.
    const specifier = import.meta.url.endsWith('.ts') ? './metrics-worker.ts' : './metrics-worker.js'
    const created = new Worker(new URL(specifier, import.meta.url))
    created.on('message', (message: { id: number; ok: boolean; value?: MetricsResult; error?: string }) => {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok && message.value) entry.resolve(message.value)
      else entry.reject(new Error(message.error || 'Metrics query failed.'))
    })
    created.on('error', (error) => {
      console.warn('Metrics worker failed; falling back to in-process queries:', error.message)
      disabled = true
      worker = null
      rejectAll(new WorkerFailure(error.message))
    })
    created.on('exit', (code) => {
      worker = null
      if (code !== 0) rejectAll(new WorkerFailure(`Metrics worker exited with code ${code}`))
    })
    // Must not hold the process open at shutdown.
    created.unref()
    worker = created
    return worker
  } catch (error) {
    console.warn('Metrics worker could not start; using in-process queries:', error)
    disabled = true
    return null
  }
}

export async function runMetricsQuery(request: QueryRequest): Promise<MetricsResult> {
  const active = ensureWorker()
  if (!active) return queryMetrics(request)
  const id = nextId++
  try {
    return await new Promise<MetricsResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      active.postMessage({ id, request })
    })
  } catch (error) {
    pending.delete(id)
    // The worker itself died -- serve this request inline rather than failing it.
    if (error instanceof WorkerFailure) return queryMetrics(request)
    throw error
  }
}

export async function shutdownMetricsRunner() {
  const active = worker
  worker = null
  if (active) await active.terminate()
}
