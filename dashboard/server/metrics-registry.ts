// NOTE: this file is imported by BOTH the Express server and the Vite client.
// It must stay dependency-free -- no imports -- so that NodeNext (server) and Bundler (client)
// module resolution both accept it.

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
  /** Link column used by the picker and telemetry grid. */
  direction: 'ul' | 'dl'
  group: MetricGroup
  unit: string
  agg: MetricAgg
  /** Raw per-TTI MAC metrics are the default; HARQ metrics come from the terminal outcome ledger. */
  source?: 'ue_mac' | 'harq'
  /**
   * 'avg' and 'rate': the ue_mac column, or a SQL expression over ue_mac columns. Registry-owned
   * and never derived from user input, so an expression here is safe.
   */
  column?: string
  /**
   * SQL predicate naming the TTIs on which this metric is defined, matching what the srsRAN gNB
   * counts in its own metrics. MCS, PRBs and TBS only exist when the scheduler made an
   * allocation; the gNB writes 0 otherwise, and averaging those in drags the mean toward zero.
   * SNR is the same story -- srsRAN prints `n/a` when there was no PUSCH.
   * Omitted means "every TTI", which is right for CQI, BLER and throughput.
   */
  definedWhen?: string
  /** ue_mac columns this metric needs; defaults to `column`. Set it when column or definedWhen is an expression. */
  requires?: string[]
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
  /** One sentence for the metric notes tab and the archived schema, where a formula is not enough. */
  note?: string
}

export const METRICS: MetricDef[] = [
  // ---- Radio ----
  { key: 'snr', label: 'SNR', direction: 'ul', group: 'Radio', unit: 'dB', lineSuffix: 'SNR',
    agg: 'avg', column: 'snr', definedWhen: 'ul_crc_ok + ul_crc_fail > 0', requires: ['snr', 'ul_crc_ok', 'ul_crc_fail'],
    defaultMode: 'chart', precision: 2, note: "PUSCH SNR. Counted only on TTIs where a PUSCH was received, matching srsRAN printing n/a otherwise.", },
  { key: 'cqi', label: 'CQI', direction: 'dl', group: 'Radio', unit: 'index', lineSuffix: 'CQI',
    agg: 'avg', column: 'cqi', defaultMode: 'numeric', domain: [0, 15], precision: 2, note: "Wideband CQI reported by the UE. srsRAN reports it every period regardless of scheduling, so every TTI counts.", },

  // ---- Throughput ----
  { key: 'dlMbps', label: 'DL throughput', direction: 'dl', group: 'Throughput', unit: 'Mbps', lineSuffix: 'DL',
    agg: 'rate', column: 'dl_acked_bytes', defaultMode: 'chart', precision: 3, chartGroup: 'throughput', note: "Acknowledged MAC bytes over elapsed time. Idle TTIs count, because a rate is defined over an interval.", },
  { key: 'ulMbps', label: 'UL throughput', direction: 'ul', group: 'Throughput', unit: 'Mbps', lineSuffix: 'UL',
    agg: 'rate', column: 'ul_ok_bytes', defaultMode: 'chart', precision: 3, chartGroup: 'throughput', note: "Successfully decoded MAC bytes over elapsed time. ul_ok_bytes is the counter matching srsRAN brate; ul_tbs runs about 1.9x high.", },

  // ---- Reliability ----
  { key: 'dlBler', label: 'DL BLER', direction: 'dl', group: 'Reliability', unit: '%', lineSuffix: 'DL',
    agg: 'ratio', numerator: 'dl_harq_nack', denominator: 'dl_harq_ack',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler', note: "NACKs as a share of DL HARQ feedback, identical to the (%) column in the gNB log.", },
  { key: 'ulBler', label: 'UL BLER', direction: 'ul', group: 'Reliability', unit: '%', lineSuffix: 'UL',
    agg: 'ratio', numerator: 'ul_crc_fail', denominator: 'ul_crc_ok',
    defaultMode: 'numeric', domain: [0, 100], precision: 3, chartGroup: 'bler', note: "CRC failures as a share of UL transport blocks.", },
  { key: 'dlSuccessProbability', label: 'DL success probability', direction: 'dl', group: 'Reliability', unit: '%', lineSuffix: 'DL',
    source: 'harq', agg: 'avg', defaultMode: 'numeric', domain: [0, 100], precision: 3,
    chartGroup: 'successProbability', note: 'Terminally successful initial DL HARQ transmissions divided by resolved initial DL transmissions. Retransmissions and pending outcomes are excluded.' },
  { key: 'ulSuccessProbability', label: 'UL success probability', direction: 'ul', group: 'Reliability', unit: '%', lineSuffix: 'UL',
    source: 'harq', agg: 'avg', defaultMode: 'numeric', domain: [0, 100], precision: 3,
    chartGroup: 'successProbability', note: 'CRC-OK initial UL transmissions divided by resolved initial UL transmissions. Retransmissions and pending outcomes are excluded.' },

  // ---- Scheduling ----
  { key: 'dlMcs', label: 'DL MCS', direction: 'dl', group: 'Scheduling', unit: 'index', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_mcs', definedWhen: 'dl_prbs > 0', requires: ['dl_mcs', 'dl_prbs'], defaultMode: 'numeric', domain: [0, 28], precision: 1, chartGroup: 'mcs', note: "The modulation and coding scheme the scheduler chose, averaged only over TTIs it actually scheduled. Including unscheduled TTIs drags this toward zero, because the gNB writes 0 on them.", },
  { key: 'ulMcs', label: 'UL MCS', direction: 'ul', group: 'Scheduling', unit: 'index', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_mcs', definedWhen: 'ul_prbs > 0', requires: ['ul_mcs', 'ul_prbs'], defaultMode: 'numeric', domain: [0, 28], precision: 1, chartGroup: 'mcs', note: "As DL MCS, on the uplink.", },
  { key: 'dlPrbs', label: 'DL PRBs', direction: 'dl', group: 'Scheduling', unit: 'PRBs', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_prbs', definedWhen: 'dl_prbs > 0', requires: ['dl_prbs'], defaultMode: 'chart', precision: 1, chartGroup: 'prbs' },
  { key: 'ulPrbs', label: 'UL PRBs', direction: 'ul', group: 'Scheduling', unit: 'PRBs', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_prbs', definedWhen: 'ul_prbs > 0', requires: ['ul_prbs'], defaultMode: 'chart', precision: 1, chartGroup: 'prbs' },
  { key: 'dlTbs', label: 'DL TBS', direction: 'dl', group: 'Scheduling', unit: 'bytes', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_tbs', definedWhen: 'dl_prbs > 0', requires: ['dl_tbs', 'dl_prbs'], defaultMode: 'chart', precision: 0, chartGroup: 'tbs' },
  { key: 'ulTbs', label: 'UL TBS', direction: 'ul', group: 'Scheduling', unit: 'bytes', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_tbs', definedWhen: 'ul_prbs > 0', requires: ['ul_tbs', 'ul_prbs'], defaultMode: 'chart', precision: 0, chartGroup: 'tbs' },
  { key: 'dlBuffer', label: 'DL buffer', direction: 'dl', group: 'Scheduling', unit: 'bytes', lineSuffix: 'DL',
    agg: 'avg', column: 'dl_buffer', defaultMode: 'chart', precision: 0, chartGroup: 'buffer', note: "Bytes waiting in the DL RLC buffer -- the backlog a scheduler reacts to.", },
  { key: 'ulBuffer', label: 'UL buffer', direction: 'ul', group: 'Scheduling', unit: 'bytes', lineSuffix: 'UL',
    agg: 'avg', column: 'ul_buffer', defaultMode: 'chart', precision: 0, chartGroup: 'buffer' },

  // ---- Latency (stored as microseconds, displayed as milliseconds) ----
  { key: 'ceDelay', label: 'CE delay', direction: 'ul', group: 'Latency', unit: 'ms', lineSuffix: 'CE',
    agg: 'avg', column: 'ce_delay_us', definedWhen: 'ce_delay_valid = 1', requires: ['ce_delay_us', 'ce_delay_valid'],
    scale: 0.001, defaultMode: 'numeric', precision: 3, note: 'Native srsRAN average, defined only for report periods containing CE observations.' },
  { key: 'crcDelay', label: 'CRC delay', direction: 'ul', group: 'Latency', unit: 'ms', lineSuffix: 'CRC',
    agg: 'avg', column: 'crc_delay_us', definedWhen: 'crc_delay_valid = 1', requires: ['crc_delay_us', 'crc_delay_valid'],
    scale: 0.001, defaultMode: 'numeric', precision: 3, note: 'Native srsRAN average, defined only for report periods containing CRC observations.' },
  { key: 'pucchHarqDelay', label: 'PUCCH HARQ delay', direction: 'dl', group: 'Latency', unit: 'ms', lineSuffix: 'PUCCH',
    agg: 'avg', column: 'pucch_harq_delay_us', definedWhen: 'pucch_harq_delay_valid = 1', requires: ['pucch_harq_delay_us', 'pucch_harq_delay_valid'],
    scale: 0.001, defaultMode: 'numeric', precision: 3, note: 'Native srsRAN average, defined only for report periods containing PUCCH HARQ observations.' },
  { key: 'puschHarqDelay', label: 'PUSCH HARQ delay', direction: 'ul', group: 'Latency', unit: 'ms', lineSuffix: 'PUSCH',
    agg: 'avg', column: 'pusch_harq_delay_us', definedWhen: 'pusch_harq_delay_valid = 1', requires: ['pusch_harq_delay_us', 'pusch_harq_delay_valid'],
    scale: 0.001, defaultMode: 'numeric', precision: 3, note: 'Native srsRAN average, defined only for report periods containing PUSCH HARQ observations.' },
  { key: 'srToPuschDelay', label: 'SR to PUSCH', direction: 'ul', group: 'Latency', unit: 'ms', lineSuffix: 'SR',
    agg: 'avg', column: 'sr_to_pusch_delay_us', definedWhen: 'sr_to_pusch_delay_valid = 1', requires: ['sr_to_pusch_delay_us', 'sr_to_pusch_delay_valid'],
    scale: 0.001, defaultMode: 'numeric', precision: 3, note: 'Native srsRAN average, defined only for report periods containing handled scheduling requests.' },
  { key: 'dlAoi', label: 'DL AoI', direction: 'dl', group: 'Latency', unit: 'ms', lineSuffix: 'DL',
    source: 'harq', agg: 'avg', defaultMode: 'numeric', precision: 3, chartGroup: 'aoi',
    note: 'Retrospective slot AoI: reset to one slot at a successful initial DL transmission; increment by one per native slot otherwise.' },
  { key: 'ulAoi', label: 'UL AoI', direction: 'ul', group: 'Latency', unit: 'ms', lineSuffix: 'UL',
    source: 'harq', agg: 'avg', defaultMode: 'numeric', precision: 3, chartGroup: 'aoi',
    note: 'Retrospective slot AoI: reset to one slot at a CRC-OK initial UL transmission; increment by one per native slot otherwise.' },

  // ---- Scheduling opportunity: the context a conditioned MCS needs ----
  { key: 'dlSchedRate', label: 'DL scheduled', direction: 'dl', group: 'Scheduling', unit: '%', lineSuffix: 'DL',
    agg: 'avg', column: 'CASE WHEN dl_prbs > 0 THEN 100.0 ELSE 0.0 END', requires: ['dl_prbs'],
    defaultMode: 'numeric', domain: [0, 100], precision: 1, chartGroup: 'schedrate', note: "Share of TTIs in which this UE received a DL allocation. The context a conditioned MCS needs to be interpretable.", },
  { key: 'ulSchedRate', label: 'UL scheduled', direction: 'ul', group: 'Scheduling', unit: '%', lineSuffix: 'UL',
    agg: 'avg', column: 'CASE WHEN ul_prbs > 0 THEN 100.0 ELSE 0.0 END', requires: ['ul_prbs'],
    defaultMode: 'numeric', domain: [0, 100], precision: 1, chartGroup: 'schedrate', note: "Share of TTIs in which this UE received a UL grant.", },
]

export const METRICS_BY_KEY = new Map(METRICS.map((metric) => [metric.key, metric]))

/** Card titles for metrics that share a chartGroup. */
export const CHART_GROUP_TITLES: Record<string, string> = {
  throughput: 'Throughput', bler: 'BLER', mcs: 'MCS',
  prbs: 'PRBs', tbs: 'TBS', buffer: 'Buffer occupancy', schedrate: 'Scheduled TTIs',
  successProbability: 'Transmission success probability', aoi: 'Age of Information',
}

export interface MetricChoice {
  id: string
  title: string
  group: MetricGroup
  unit: string
  metrics: MetricDef[]
}

/** A paired UL/DL chart group is one user-facing choice; unpaired native metrics remain single choices. */
export const METRIC_CHOICES: MetricChoice[] = (() => {
  const choices: MetricChoice[] = []
  const byId = new Map<string, MetricChoice>()
  for (const metric of METRICS) {
    const id = metric.chartGroup ?? metric.key
    const existing = byId.get(id)
    if (existing) {
      existing.metrics.push(metric)
      continue
    }
    const choice = {
      id,
      title: CHART_GROUP_TITLES[id] ?? metric.label,
      group: metric.group,
      unit: metric.unit,
      metrics: [metric],
    }
    choices.push(choice)
    byId.set(id, choice)
  }
  return choices
})()

export const METRIC_CHOICES_BY_ID = new Map(METRIC_CHOICES.map((choice) => [choice.id, choice]))

/** The six metrics the dashboard charted before the registry existed. */
export const DEFAULT_METRIC_KEYS = ['dlMbps', 'ulMbps', 'snr', 'cqi', 'dlBler', 'ulBler']

/** ue_mac columns a metric needs in order to be servable. */
export function requiredColumns(metric: MetricDef): string[] {
  if (metric.source === 'harq') {
    return ['harq_outcome.outcome', 'harq_outcome.attempt_number', 'slot_observation.slot_duration_ns']
  }
  if (metric.requires) return metric.requires
  return metric.agg === 'ratio' ? [metric.numerator!, metric.denominator!] : [metric.column!]
}

export function resolveMetrics(keys: string[]): MetricDef[] {
  return keys.map((key) => METRICS_BY_KEY.get(key)).filter((m): m is MetricDef => Boolean(m))
}
