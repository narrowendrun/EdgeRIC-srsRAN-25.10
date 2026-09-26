import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { METRICS, requiredColumns, type MetricDef } from '../metrics-registry.js'

/**
 * Writes a machine-readable description of how every metric is derived into the run directory.
 *
 * The point is that an archived run stays interpretable away from this codebase. `ue_mac` holds
 * raw per-TTI rows; deriving MCS from them without the `dl_prbs > 0` condition gives 1.4 where
 * srsRAN reports 15, because the gNB writes 0 on TTIs it did not schedule. Anyone analysing a run
 * in pandas a year from now needs that condition to travel with the data, not live only in
 * TypeScript.
 *
 * Emitted at run start so it reflects the definitions in force for that run, not whatever the
 * registry says later.
 */

interface ExportedMetric {
  key: string
  label: string
  group: string
  unit: string
  aggregation: MetricDef['agg']
  source: 'ue_mac' | 'harq'
  columns: string[]
  /** SQL predicate selecting the TTIs this metric is defined on; null means every TTI. */
  definedWhen: string | null
  /** The bucket-level SQL this dashboard runs, with {bucket_us} as the bucket width. */
  sql: string
  scale: number
  precision: number
  note?: string
}

function sqlFor(metric: MetricDef): string {
  if (metric.source === 'harq') {
    return metric.key.includes('SuccessProbability')
      ? 'successful resolved initial HARQ outcomes * 100 / resolved initial HARQ outcomes'
      : 'AoI=1 at a successful initial transmission; otherwise AoI=previous AoI+1 native slot'
  }
  const when = metric.definedWhen ?? '1'
  switch (metric.agg) {
    case 'avg':
      return `AVG(CASE WHEN ${when} THEN ${metric.column} END)`
    case 'rate':
      return `SUM(${metric.column}) * 8 / {covered_us}   -- Mbit/s`
    case 'ratio':
      return `SUM(${metric.numerator}) * 100.0 / (SUM(${metric.numerator}) + SUM(${metric.denominator}))`
  }
}

export function runSchema(backfilled = false) {
  return {
    schemaVersion: 4,
    ...(backfilled ? { backfilled: true, backfillNote: 'Written after the run, from the definitions in force when it was listed. The run itself predates schema capture.' } : {}),
    table: 'ue_mac',
    relatedTables: {
      slot_observation: 'One loss-detectable native scheduler-slot observation with applied scheduler policy provenance per published message.',
      ue_slot_observation: 'UE presence by native slot; currently scoped to the single-cell OTA setup.',
      harq_outcome: 'Immutable terminal native HARQ outcomes, including attempt and process identity.',
    },
    description:
      'One row per UE per TTI. Metrics must be derived with the condition below; the gNB writes ' +
      'zero for MCS, PRBs and TBS on TTIs it did not schedule, and averaging those in is wrong.',
    reference:
      "Aggregates are defined to match the srsRAN gNB's own metrics log (gnb.log in this " +
      'directory). DL BLER corresponds to its (%) column, throughput to brate, SNR to pusch, ' +
      'MCS to mcs.',
    weighting:
      'Window averages weight every qualifying TTI equally (sample-weighted). Averaging the ' +
      "gNB log's rows instead weights each metrics period equally and gives a different number; " +
      'neither is more correct, but they are not interchangeable.',
    timestamps: 'timestamp_us is Unix epoch microseconds.',
    metrics: METRICS.map((metric): ExportedMetric => ({
      key: metric.key,
      label: metric.label,
      group: metric.group,
      unit: metric.unit,
      aggregation: metric.agg,
      source: metric.source ?? 'ue_mac',
      columns: requiredColumns(metric),
      definedWhen: metric.definedWhen ?? null,
      sql: sqlFor(metric),
      scale: metric.scale ?? 1,
      precision: metric.precision,
      ...(metric.note ? { note: metric.note } : {}),
    })),
  }
}

export function writeRunSchema(runDir: string, backfilled = false) {
  writeFileSync(path.join(runDir, 'metrics-schema.json'), `${JSON.stringify(runSchema(backfilled), null, 2)}\n`)
}
