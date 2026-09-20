// NOTE: this file is imported by BOTH the Express server and the Vite client.
// It must stay dependency-free -- no imports -- so that NodeNext (server) and Bundler (client)
// module resolution both accept it. See docs/plans/03-metric-registry.md section 3.1.

/**
 * How a metric collapses many per-TTI rows into one bucket value.
 *  - 'avg'   : AVG(column) -- an instantaneous quantity (SNR, CQI, MCS, PRBs, buffers)
 *  - 'rate'  : SUM(column) * 8 / bucketUs -- bytes accumulated over time, in Mbit/s
 *  - 'ratio' : SUM(num) / (SUM(num) + SUM(den)) * 100 -- a percentage of events
 */
export type MetricAgg = 'avg' | 'rate' | 'ratio'
export type MetricMode = 'numeric' | 'chart'
export type MetricGroup = 'Radio' | 'Throughput' | 'Reliability' | 'Scheduling' | 'Latency'

export interface MetricDef {
  key: string
  label: string
  group: MetricGroup
  unit: string
  agg: MetricAgg
  /** 'avg' and 'rate': the ue_mac column. */
  column?: string
  /** 'ratio': the failure counter and its success counterpart. */
  numerator?: string
  denominator?: string
  /** Multiplied into the result. Renders stored microseconds as milliseconds. */
  scale?: number
  defaultMode: MetricMode
  /** Fixed Y-axis range where the metric has a natural one. */
  domain?: [number, number]
  precision: number
  /** Metrics sharing a chartGroup render as lines in one card when both are charted. */
  chartGroup?: string
  /** Legend suffix, appended after the UE label. */
  lineSuffix: string
}

export const METRICS: MetricDef[] = [
  // ---- Radio ----
  { key: 'snr', label: 'SNR', group: 'Radio', unit: 'dB', lineSuffix: 'SNR',
    agg: 'avg', column: 'snr', defaultMode: 'chart', precision: 2 },
  { key: 'cqi', label: 'CQI', group: 'Radio', unit: 'index', lineSuffix: 'CQI',
    agg: 'avg', column: 'cqi', defaultMode: 'numeric', domain: [0, 15], precision: 2 },

  // ---- Throughput ----
  { key: 'dlMbps', label: 'DL throughput', group: 'Throughput', unit: 'Mbps', lineSuffix: 'DL',
    agg: 'rate', column: 'dl_acked_bytes', defaultMode: 'chart', precision: 3, chartGroup: 'throughput' },
  { key: 'ulMbps', label: 'UL throughput', group: 'Throughput', unit: 'Mbps', lineSuffix: 'UL',
    agg: 'rate', column: 'ul_ok_bytes', defaultMode: 'chart', precision: 3, chartGroup: 'throughput' },

  // ---- Reliability ----
  { key: 'dlBler', label: 'DL BLER', group: 'Reliability', unit: '%', lineSuffix: 'DL',
    agg: 'ratio', numerator: 'dl_harq_nack', denominator: 'dl_harq_ack',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler' },
  { key: 'ulBler', label: 'UL BLER', group: 'Reliability', unit: '%', lineSuffix: 'UL',
    agg: 'ratio', numerator: 'ul_crc_fail', denominator: 'ul_crc_ok',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler' },

  // ---- Scheduling ----
  { key: 'dlMcs', label: 'DL MCS', group: 'Scheduling', unit: 'index', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_mcs', defaultMode: 'numeric', domain: [0, 28], precision: 1, chartGroup: 'mcs' },
  { key: 'ulMcs', label: 'UL MCS', group: 'Scheduling', unit: 'index', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_mcs', defaultMode: 'numeric', domain: [0, 28], precision: 1, chartGroup: 'mcs' },
  { key: 'dlPrbs', label: 'DL PRBs', group: 'Scheduling', unit: 'PRBs', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_prbs', defaultMode: 'chart', precision: 1, chartGroup: 'prbs' },
  { key: 'ulPrbs', label: 'UL PRBs', group: 'Scheduling', unit: 'PRBs', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_prbs', defaultMode: 'chart', precision: 1, chartGroup: 'prbs' },
  { key: 'dlTbs', label: 'DL TBS', group: 'Scheduling', unit: 'bytes', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_tbs', defaultMode: 'chart', precision: 0, chartGroup: 'tbs' },
  { key: 'ulTbs', label: 'UL TBS', group: 'Scheduling', unit: 'bytes', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_tbs', defaultMode: 'chart', precision: 0, chartGroup: 'tbs' },
  { key: 'dlBuffer', label: 'DL buffer', group: 'Scheduling', unit: 'bytes', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_buffer', defaultMode: 'chart', precision: 0, chartGroup: 'buffer' },
  { key: 'ulBuffer', label: 'UL buffer', group: 'Scheduling', unit: 'bytes', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_buffer', defaultMode: 'chart', precision: 0, chartGroup: 'buffer' },

  // ---- Latency (stored as microseconds, displayed as milliseconds) ----
  { key: 'ceDelay', label: 'CE delay', group: 'Latency', unit: 'ms', lineSuffix: 'CE',
    agg: 'avg', column: 'ce_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'crcDelay', label: 'CRC delay', group: 'Latency', unit: 'ms', lineSuffix: 'CRC',
    agg: 'avg', column: 'crc_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'pucchHarqDelay', label: 'PUCCH HARQ delay', group: 'Latency', unit: 'ms', lineSuffix: 'PUCCH',
    agg: 'avg', column: 'pucch_harq_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'puschHarqDelay', label: 'PUSCH HARQ delay', group: 'Latency', unit: 'ms', lineSuffix: 'PUSCH',
    agg: 'avg', column: 'pusch_harq_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'srToPuschDelay', label: 'SR to PUSCH', group: 'Latency', unit: 'ms', lineSuffix: 'SR',
    agg: 'avg', column: 'sr_to_pusch_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
  { key: 'sumMacDelay', label: 'Total MAC delay', group: 'Latency', unit: 'ms', lineSuffix: 'TOTAL',
    agg: 'avg', column: 'sum_mac_delay_us', scale: 0.001, defaultMode: 'numeric', precision: 3 },
]

export const METRICS_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]))

/** Card titles for metrics that share a chartGroup. */
export const CHART_GROUP_TITLES: Record<string, string> = {
  throughput: 'Throughput', bler: 'BLER', mcs: 'MCS',
  prbs: 'PRBs', tbs: 'TBS', buffer: 'Buffer occupancy',
}

/** The six metrics the dashboard charted before the registry existed. */
export const DEFAULT_METRIC_KEYS = ['dlMbps', 'ulMbps', 'snr', 'cqi', 'dlBler', 'ulBler']

/** ue_mac columns a metric needs in order to be servable. */
export function requiredColumns(metric: MetricDef): string[] {
  return metric.agg === 'ratio' ? [metric.numerator!, metric.denominator!] : [metric.column!]
}

export function resolveMetrics(keys: string[]): MetricDef[] {
  return keys.map((key) => METRICS_BY_KEY.get(key)).filter((m): m is MetricDef => Boolean(m))
}
