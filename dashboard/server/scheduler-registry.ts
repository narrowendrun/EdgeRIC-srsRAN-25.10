// NOTE: imported by BOTH the Express server and the Vite client, so it must stay
// dependency-free -- no imports. Same rule as metrics-registry.ts.

/**
 * The algorithms `edgeric/muapp-scheduling/scheduling_muapp.py` implements.
 *
 * These strings must match `algorithm_mapping` in that file EXACTLY. The muApp looks the Redis
 * value up in that dictionary and, on a miss, prints "Unknown algorithm" and idles -- it does not
 * fall back. srsran-parity-style drift here is silent, so scheduler-registry.test.ts reads the
 * Python and asserts the two lists agree.
 */
export const SCHEDULING_ALGORITHMS = [
  'Fixed Weight',
  'Max CQI',
  'Max Weight',
  'Proportional Fair',
  'Round Robin',
] as const

export type SchedulingAlgorithm = typeof SCHEDULING_ALGORITHMS[number]

/** The single Redis string key the muApp polls, on db 0. */
export const SCHEDULER_REDIS_KEY = 'scheduling_algorithm'

export function isKnownAlgorithm(value: string | null): boolean {
  return value !== null && (SCHEDULING_ALGORITHMS as readonly string[]).includes(value)
}
