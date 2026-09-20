import { useCallback, useEffect, useState } from 'react'
import type { DashboardStatus } from '../types'

export function useStatus() {
  const [status, setStatus] = useState<DashboardStatus | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' })
      if (!response.ok) throw new Error(`status request failed (${response.status})`)
      setStatus(await response.json())
      setError('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'dashboard server unavailable')
    }
  }, [])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [refresh])
  return { status, error, refresh }
}
