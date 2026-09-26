import { useCallback, useEffect, useRef, useState } from 'react'
import type { HarqResponse, WindowSize } from '../types'

export function useHarqMetrics(windowSize: WindowSize, runId?: string, fullRun = false, enabled = true) {
  const [data, setData] = useState<HarqResponse | null>(null)
  const [error, setError] = useState('')
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (!enabled) { setData(null); setError(''); return }
    if (inFlight.current) return
    inFlight.current = true
    const query = `window=${windowSize}${fullRun ? '&full=1' : ''}`
    const endpoint = runId
      ? `/api/runs/${encodeURIComponent(runId)}/harq?${query}`
      : `/api/metrics/live/harq?${query}`
    try {
      const response = await fetch(endpoint, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'HARQ metrics request failed')
      setData(result); setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'HARQ metrics unavailable')
    } finally {
      inFlight.current = false
    }
  }, [enabled, fullRun, runId, windowSize])

  useEffect(() => {
    if (!enabled) { setData(null); setError(''); return }
    void refresh()
    if (runId) return
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [enabled, refresh, runId])

  return { data, error, refresh }
}
