import { parentPort } from 'node:worker_threads'
import { queryMetrics, type QueryRequest } from './metrics-query.js'

if (!parentPort) throw new Error('metrics-worker.ts must be run as a worker thread')
const port = parentPort

port.on('message', (message: { id: number; request: QueryRequest }) => {
  try {
    port.postMessage({ id: message.id, ok: true, value: queryMetrics(message.request) })
  } catch (error) {
    port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
