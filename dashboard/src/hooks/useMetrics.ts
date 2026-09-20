import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MetricsResponse, WindowSize } from '../types'

export function useMetrics(windowSize: WindowSize, metricKeys: string[], runId?: string, fullRun = false) {
  const [data, setData] = useState<MetricsResponse | null>(null)
  const [error, setError] = useState('')
  // Join to a string so a fresh array identity each render does not retrigger the fetch.
  const metricsParam = useMemo(() => metricKeys.join(','), [metricKeys])

  const refresh = useCallback(async () => {
    if (!metricsParam) { setData(null); setError(''); return }
    const query = `window=${windowSize}&metrics=${encodeURIComponent(metricsParam)}${fullRun ? '&full=1' : ''}`
    const endpoint = runId
      ? `/api/runs/${encodeURIComponent(runId)}/metrics?${query}`
      : `/api/metrics/live?${query}`
    try {
      const response = await fetch(endpoint, { cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'metrics request failed')
      setData(result); setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'metrics unavailable')
    }
  }, [fullRun, metricsParam, runId, windowSize])

  useEffect(() => {
    void refresh()
    if (runId) return
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh, runId])

  return { data, error, refresh }
}
