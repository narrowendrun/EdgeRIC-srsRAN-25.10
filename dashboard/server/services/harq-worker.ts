import { parentPort } from 'node:worker_threads'
import { queryHarqReliability, type HarqQueryRequest } from './harq-query.js'

if (!parentPort) throw new Error('harq-worker.ts must be run as a worker thread')
const port = parentPort

port.on('message', (message: { id: number; request: HarqQueryRequest }) => {
  try {
    port.postMessage({ id: message.id, ok: true, value: queryHarqReliability(message.request) })
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
