import { readFileSync, statSync } from 'node:fs'
import {
  SCHEDULER_REDIS_KEY, SCHEDULING_ALGORITHMS, isKnownAlgorithm,
  type SchedulingAlgorithm,
} from '../scheduler-registry.js'
import { run } from '../utils.js'

const EPOCH_KEY = 'scheduling_policy_epoch'
const stateFile = '/tmp/edgeric_scheduler_state.json'
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface AppliedState {
  policyEpoch: number
  algorithm: string
  controlActive: boolean
  dlEligibleRntis: number[]
  ulEligibleRntis: number[]
  nativeSlot: number
  observedAt: number
  fresh: boolean
}

export interface SchedulerStatus {
  available: boolean
  algorithm: string | null
  known: boolean
  muappRunning: boolean
  policyEpoch: number | null
  appliedAlgorithm: string | null
  appliedEpoch: number | null
  controlActive: boolean
  dlEligibleRntis: number[]
  ulEligibleRntis: number[]
  algorithms: readonly string[]
  detail: string
}

function appliedState(): AppliedState | null {
  try {
    const value = JSON.parse(readFileSync(stateFile, 'utf8')) as Omit<AppliedState, 'fresh'>
    const fresh = Date.now() - statSync(stateFile).mtimeMs < 2500
    if (!Number.isInteger(value.policyEpoch) || typeof value.algorithm !== 'string') return null
    return { ...value, fresh }
  } catch {
    return null
  }
}

export async function readSchedulerAlgorithm() {
  const result = await run('/usr/bin/redis-cli', [
    '-h', '127.0.0.1', '-p', '6379', '--raw', 'MGET', SCHEDULER_REDIS_KEY, EPOCH_KEY,
  ], 2000)
  if (!result.ok) return { available: false, algorithm: null, policyEpoch: null }
  const [algorithm = '', epoch = ''] = result.stdout.split('\n')
  const parsedEpoch = Number(epoch)
  return {
    available: true,
    algorithm: algorithm.length > 0 ? algorithm : null,
    policyEpoch: Number.isInteger(parsedEpoch) && parsedEpoch > 0 ? parsedEpoch : null,
  }
}

export async function requestScheduler(algorithm: SchedulingAlgorithm) {
  const script = "local e=redis.call('INCR',KEYS[2]); redis.call('SET',KEYS[1],ARGV[1]); return e"
  const result = await run('/usr/bin/redis-cli', [
    '-h', '127.0.0.1', '-p', '6379', '--raw', 'EVAL', script, '2',
    SCHEDULER_REDIS_KEY, EPOCH_KEY, algorithm,
  ], 2000)
  const epoch = Number(result.stdout)
  if (!result.ok || !Number.isInteger(epoch) || epoch < 1) {
    throw new Error(result.stderr || 'Redis did not accept the scheduler change.')
  }
  return epoch
}

export async function waitForAppliedScheduler(algorithm: string, epoch: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = appliedState()
    if (state?.fresh && state.controlActive && state.policyEpoch === epoch && state.algorithm === algorithm) return state
    await delay(50)
  }
  return null
}

export async function getSchedulerStatus(muappRunning: boolean): Promise<SchedulerStatus> {
  const { available, algorithm, policyEpoch } = await readSchedulerAlgorithm()
  const applied = appliedState()
  const known = isKnownAlgorithm(algorithm)
  const appliedMatches = Boolean(applied?.fresh && applied.controlActive && applied.policyEpoch === policyEpoch && applied.algorithm === algorithm)
  return {
    available, algorithm, known, muappRunning, policyEpoch,
    appliedAlgorithm: applied?.fresh ? applied.algorithm : null,
    appliedEpoch: applied?.fresh ? applied.policyEpoch : null,
    controlActive: appliedMatches,
    dlEligibleRntis: applied?.fresh ? applied.dlEligibleRntis : [],
    ulEligibleRntis: applied?.fresh ? applied.ulEligibleRntis : [],
    algorithms: SCHEDULING_ALGORITHMS,
    detail: !available ? 'Redis is unreachable'
      : !muappRunning ? 'requested policy is not being run'
      : !known ? 'requested policy is not registered'
      : appliedMatches ? `gNB applied epoch ${policyEpoch}`
      : 'waiting for gNB application evidence',
  }
}
