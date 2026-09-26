import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  METRIC_CHOICES, METRIC_CHOICES_BY_ID, type MetricMode,
} from '../../server/metrics-registry'

const storageKey = 'edgeric.telemetry.v1'
const storageVersion = 3

/**
 * What the dashboard shows on a fresh browser. Deliberately not the registry's defaultMode:
 * this is one object to edit if it turns out wrong in practice.
 */
const defaultSelection: Record<string, MetricMode> = {
  throughput: 'chart',
  snr: 'chart',
  mcs: 'numeric',
  bler: 'numeric',
  successProbability: 'numeric',
  aoi: 'numeric',
}

interface StoredPrefs { v: number; selected: Record<string, MetricMode> }

function load(): Record<string, MetricMode> {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return { ...defaultSelection }
    const parsed = JSON.parse(raw) as StoredPrefs
    // A version bump discards rather than half-rendering a stale shape.
    if (parsed?.v !== storageVersion || !parsed.selected) return { ...defaultSelection }
    const cleaned: Record<string, MetricMode> = {}
    for (const [key, mode] of Object.entries(parsed.selected)) {
      // Drop keys the registry no longer knows, so removing a metric cannot break a saved pref.
      if (METRIC_CHOICES_BY_ID.has(key) && (mode === 'numeric' || mode === 'chart')) cleaned[key] = mode
    }
    return Object.keys(cleaned).length ? cleaned : { ...defaultSelection }
  } catch {
    // Private windows and blocked site data both throw here.
    return { ...defaultSelection }
  }
}

function save(selected: Record<string, MetricMode>) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify({ v: storageVersion, selected } satisfies StoredPrefs))
  } catch {
    // A failed write only costs persistence, never the current view.
  }
}

export function useTelemetryPrefs() {
  const [selected, setSelected] = useState<Record<string, MetricMode>>(load)
  useEffect(() => { save(selected) }, [selected])

  const toggle = useCallback((key: string) => setSelected((current) => {
    const next = { ...current }
    if (key in next) delete next[key]
    else next[key] = METRIC_CHOICES_BY_ID.get(key)?.metrics[0]?.defaultMode ?? 'chart'
    return next
  }), [])

  const setMode = useCallback((key: string, mode: MetricMode) => setSelected((current) => (
    key in current ? { ...current, [key]: mode } : current
  )), [])

  const reset = useCallback(() => setSelected({ ...defaultSelection }), [])

  // Registry order throughout, so rows keep a stable, predictable arrangement.
  const choices = useMemo(() => METRIC_CHOICES.filter((choice) => choice.id in selected), [selected])
  const keys = useMemo(() => choices.flatMap((choice) => choice.metrics.map((metric) => metric.key)), [choices])

  return { selected, toggle, setMode, reset, keys, choices }
}
