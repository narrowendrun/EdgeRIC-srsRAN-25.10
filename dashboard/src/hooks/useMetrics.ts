import { useCallback, useEffect, useState } from 'react'
import type { MetricsResponse, WindowSize } from '../types'

export function useMetrics(windowSize: WindowSize, runId?: string, fullRun = false) {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    const endpoint = runId
      ? `/api/runs/${encodeURIComponent(runId)}/metrics?window=${windowSize}${fullRun ? '&full=1' : ''}`
      : `/api/metrics/live?window=${windowSize}`
    try {
      const response = await fetch(endpoint, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'metrics request failed')
      setData(result); setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'metrics unavailable')
    }
  }, [fullRun, runId, windowSize])
  useEffect(() => {
    void refresh()
    if (runId) return
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh, runId])
  return { data, error, refresh }
}
