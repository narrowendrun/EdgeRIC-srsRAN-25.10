import { useEffect, useRef, useState } from 'react'
import type { ModuleName, WindowSize } from '../types'

export function useLogs(module: ModuleName, windowSize: WindowSize) {
  const [logs, setLogs] = useState<string[]>([])
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const generation = useRef(0)
  useEffect(() => {
    generation.current += 1
    const currentGeneration = generation.current
    setLogs([])
    setState('connecting')
    const events = new EventSource(`/api/logs/${module}/stream?window=${windowSize}`)
    events.addEventListener('backfill', (event) => {
      if (generation.current !== currentGeneration) return
      const payload = JSON.parse((event as MessageEvent).data) as { lines: string[] }
      setLogs(payload.lines.slice(-2000)); setState('live')
    })
    events.addEventListener('line', (event) => {
      if (generation.current !== currentGeneration) return
      const payload = JSON.parse((event as MessageEvent).data) as { line: string }
      setLogs((current) => [...current.slice(-1999), payload.line]); setState('live')
    })
    events.addEventListener('notice', (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { line: string }
      if (payload.line) setLogs((current) => [...current.slice(-1999), `[dashboard] ${payload.line}`])
    })
    events.onerror = () => setState('offline')
    return () => events.close()
  }, [module, windowSize])
  return { logs, setLogs, state }
}
