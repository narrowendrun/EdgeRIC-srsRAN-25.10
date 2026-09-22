import { SCHEDULER_REDIS_KEY, isKnownAlgorithm } from '../scheduler-registry.js'
import { run } from '../utils.js'

/**
 * Reads which scheduling algorithm the EdgeRIC muApp is currently running.
 *
 * Read-only by design: the algorithm is set from a shell with
 * `redis-cli SET scheduling_algorithm "Max CQI"`, and the muApp owns the lifecycle. The dashboard
 * reports, it does not drive.
 *
 * Uses redis-cli through the same run() helper the server already uses for systemctl, journalctl
 * and pgrep. One string key polled alongside the existing status refresh does not justify a
 * client library or a connection pool.
 */

export interface SchedulerStatus {
  /** Redis answered. */
  available: boolean
  /** The current value, or null when the key is unset. */
  algorithm: string | null
  /** Whether that value is one the muApp recognises. */
  known: boolean
  /** Whether scheduling_muapp.py is running to act on it. */
  muappRunning: boolean
  detail: string
}

export async function readSchedulerAlgorithm(): Promise<{ available: boolean; algorithm: string | null }> {
  const result = await run('/usr/bin/redis-cli', ['-h', '127.0.0.1', '-p', '6379', 'GET', SCHEDULER_REDIS_KEY], 2000)
  if (!result.ok) return { available: false, algorithm: null }
  const value = result.stdout.trim()
  return { available: true, algorithm: value.length > 0 ? value : null }
}

export async function getSchedulerStatus(muappRunning: boolean): Promise<SchedulerStatus> {
  const { available, algorithm } = await readSchedulerAlgorithm()
  const known = isKnownAlgorithm(algorithm)
  return {
    available, algorithm, known, muappRunning,
    detail: !available ? 'Redis is unreachable'
      : !algorithm ? 'no algorithm set in Redis'
      : !known ? 'value is not one the muApp recognises'
      : muappRunning ? 'muApp is applying this algorithm'
      : 'set in Redis, but the muApp is not running',
  }
}
