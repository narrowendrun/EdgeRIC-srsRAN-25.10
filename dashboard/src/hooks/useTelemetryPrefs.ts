import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CHART_GROUP_TITLES, METRICS, METRICS_BY_KEY, type MetricDef, type MetricMode,
} from '../../server/metrics-registry'
import type { ChartCard } from '../components/MetricChart'

const storageKey = 'edgeric.telemetry.v1'
const storageVersion = 1

/**
 * What the dashboard shows on a fresh browser. Deliberately not the registry's defaultMode:
 * this is one object to edit if it turns out wrong in practice.
 */
const defaultSelection: Record<string, MetricMode> = {
  dlMbps: 'chart', ulMbps: 'chart',
  snr: 'chart',
  dlMcs: 'numeric', ulMcs: 'numeric',
  dlBler: 'numeric', ulBler: 'numeric',
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
      if (METRICS_BY_KEY.has(key) && (mode === 'numeric' || mode === 'chart')) cleaned[key] = mode
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

/** Groups charted metrics into cards; those sharing a chartGroup become one multi-line card. */
export function chartCards(metrics: MetricDef[]): ChartCard[] {
  const cards: ChartCard[] = []
  const seen = new Set<string>()
  for (const metric of metrics) {
    if (!metric.chartGroup) {
      cards.push({ title: metric.label, unit: metric.unit, domain: metric.domain, metrics: [metric] })
      continue
    }
    if (seen.has(metric.chartGroup)) continue
    seen.add(metric.chartGroup)
    const members = metrics.filter((item) => item.chartGroup === metric.chartGroup)
    cards.push({
      title: CHART_GROUP_TITLES[metric.chartGroup] || metric.label,
      unit: metric.unit, domain: metric.domain, metrics: members,
    })
  }
  return cards
}

export function useTelemetryPrefs() {
  const [selected, setSelected] = useState<Record<string, MetricMode>>(load)
  useEffect(() => { save(selected) }, [selected])

  const toggle = useCallback((key: string) => setSelected((current) => {
    const next = { ...current }
    if (key in next) delete next[key]
    else next[key] = METRICS_BY_KEY.get(key)?.defaultMode ?? 'chart'
    return next
  }), [])

  const setMode = useCallback((key: string, mode: MetricMode) => setSelected((current) => (
    key in current ? { ...current, [key]: mode } : current
  )), [])

  const reset = useCallback(() => setSelected({ ...defaultSelection }), [])

  // Registry order throughout, so cards and tiles keep a stable, predictable arrangement.
  const keys = useMemo(() => METRICS.filter((m) => m.key in selected).map((m) => m.key), [selected])
  const numeric = useMemo(() => METRICS.filter((m) => selected[m.key] === 'numeric'), [selected])
  const charted = useMemo(() => METRICS.filter((m) => selected[m.key] === 'chart'), [selected])

  return { selected, toggle, setMode, reset, keys, numeric, charted }
}
