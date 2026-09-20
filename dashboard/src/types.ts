export type ModuleName = 'open5gs' | 'edgeric' | 'gnb'
export type ModuleState = 'active' | 'degraded' | 'inactive' | 'unknown'
export type Action = 'start' | 'stop' | 'restart'
export type WindowSize = '5m' | '15m' | '30m' | '1h'

export interface ModuleStatus { state: ModuleState; detail: string; managed: boolean }
export interface DashboardStatus {
  timestamp: string
  controlsReady: boolean
  rf: Record<string, string>
  modules: Record<ModuleName, ModuleStatus>
  ues: { count: number | null; rntis: string[]; fresh: boolean }
  iperf3: { state: ModuleState; address: string; port: number; detail: string }
  webui: { available: boolean; proxyPort: number }
}

/**
 * Keys are metric keys from server/metrics-registry.ts, so this is an index signature rather
 * than a fixed shape -- the served set is chosen at runtime.
 */
export interface MetricPoint { timestamp: number; [metricKey: string]: number }
export interface MetricSummary { last: number; min: number; max: number; avg: number }
export interface MetricSeries {
  rnti: number
  label: string
  points: MetricPoint[]
  summary: Record<string, MetricSummary>
}
export interface MetricsResponse {
  runId: string | null
  available: boolean
  startAt?: string
  endAt?: string
  bucketMs?: number
  /** Metric keys actually served. */
  metrics: string[]
  /** Requested but absent from this run's database (a pre-v2 archive). */
  unavailable: string[]
  series: MetricSeries[]
  capture: Record<string, number> | null
}

export interface RunManifest {
  id: string
  startedAt: string
  endedAt: string | null
  status: 'active' | 'completed' | 'interrupted'
  gitCommit: string
  observedRntis: string[]
  metrics: { messages: number; ueSamples: number; missedTtis: number }
  databaseBytes: number
}
