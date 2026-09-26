import { Worker } from 'node:worker_threads'
import { queryHarqReliability, type HarqQueryRequest, type HarqResult } from './harq-query.js'

class WorkerFailure extends Error {}
interface Pending { resolve: (value: HarqResult) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let disabled = false
let nextId = 1
const pending = new Map<number, Pending>()
const inFlight = new Map<string, Promise<HarqResult>>()

function rejectAll(error: Error) {
  for (const entry of pending.values()) entry.reject(error)
  pending.clear()
}

function ensureWorker(): Worker | null {
  if (disabled) return null
  if (worker) return worker
  try {
    const specifier = import.meta.url.endsWith('.ts') ? './harq-worker.ts' : './harq-worker.js'
    const created = new Worker(new URL(specifier, import.meta.url))
    created.on('message', (message: { id: number; ok: boolean; value?: HarqResult; error?: string }) => {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.ok && message.value) entry.resolve(message.value)
      else entry.reject(new Error(message.error || 'HARQ query failed.'))
    })
    created.on('error', (error) => {
      console.warn('HARQ worker failed; falling back to in-process queries:', error.message)
      disabled = true
      worker = null
      rejectAll(new WorkerFailure(error.message))
    })
    created.on('exit', (code) => {
      worker = null
      if (code !== 0) rejectAll(new WorkerFailure(`HARQ worker exited with code ${code}`))
    })
    created.unref()
    worker = created
    return worker
  } catch (error) {
    console.warn('HARQ worker could not start; using in-process queries:', error)
    disabled = true
    return null
  }
}

async function executeHarqQuery(request: HarqQueryRequest): Promise<HarqResult> {
  const active = ensureWorker()
  if (!active) return queryHarqReliability(request)
  const id = nextId++
  try {
    return await new Promise<HarqResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      active.postMessage({ id, request })
    })
  } catch (error) {
    pending.delete(id)
    if (error instanceof WorkerFailure) return queryHarqReliability(request)
    throw error
  }
}

export function runHarqQuery(request: HarqQueryRequest): Promise<HarqResult> {
  const key = JSON.stringify(request)
  const existing = inFlight.get(key)
  if (existing) return existing

  const operation = executeHarqQuery(request).finally(() => {
    if (inFlight.get(key) === operation) inFlight.delete(key)
  })
  inFlight.set(key, operation)
  return operation
}

export async function shutdownHarqRunner() {
  const active = worker
  worker = null
  inFlight.clear()
  if (active) await active.terminate()
}
