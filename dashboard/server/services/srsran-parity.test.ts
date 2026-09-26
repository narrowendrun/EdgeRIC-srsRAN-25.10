import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { logsRoot } from '../config.js'
import { queryMetrics } from './metrics-query.js'
import { METRICS_BY_KEY } from '../metrics-registry.js'
import { blerOf, meanOf, parseSrsranMetricsLog, type SrsranMetricRow } from './srsran-metrics-log.js'

/**
 * Integration parity check: our aggregates against the srsRAN gNB's own reported metrics, over
 * the same window of the same run. This is the test that keeps us honest -- the unit tests in
 * metrics-query.test.ts pin the arithmetic, this one pins it to reality.
 *
 * Skips when no recorded run carries both a parseable gnb.log and matching ue_mac rows, so it is
 * harmless on a machine that has never run an experiment.
 */

interface Candidate { id: string; rnti: number; rows: ReturnType<typeof parseSrsranMetricsLog>; dbPath: string }

function findCandidate(): Candidate | null {
  const runsRoot = path.join(logsRoot, 'runs')
  if (!existsSync(runsRoot)) return null
  const ids = readdirSync(runsRoot).filter((n) => /^[0-9]{8}T[0-9]{6}Z[0-9A-F]{4}$/.test(n)).sort().reverse()
  for (const id of ids) {
    const dir = path.join(runsRoot, id)
    const log = path.join(dir, 'gnb.log')
    const dbPath = path.join(dir, 'metrics.sqlite3')
    if (!existsSync(log) || !existsSync(dbPath)) continue
    // Never compare against a run still being recorded or one whose recorder observed missing
    // TTIs: in either case the gNB log and database do not describe the same complete window.
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
        status?: string
        metrics?: { missedTtis?: number }
      }
      if (manifest.status === 'active' || Number(manifest.metrics?.missedTtis ?? 0) > 0) continue
    } catch { continue }
    if (statSync(log).size > 64 * 1024 * 1024) continue
    const rows = parseSrsranMetricsLog(readFileSync(log, 'utf8'))
    if (rows.length < 200) continue
    // Pick the busiest UE: parity is only meaningful where the gNB actually scheduled something.
    const byRnti = new Map<number, number>()
    for (const r of rows) if (r.dl.ok + r.dl.nok > 0) byRnti.set(r.rnti, (byRnti.get(r.rnti) || 0) + 1)
    const best = [...byRnti.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!best || best[1] < 100) continue
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = (db.prepare('SELECT COUNT(*) AS n FROM ue_mac WHERE rnti = ?').get(best[0]) as { n: number }).n
    db.close()
    if (has < 1000) continue
    return { id, rnti: best[0], rows: rows.filter((r) => r.rnti === best[0]), dbPath }
  }
  return null
}

const candidate = findCandidate()

describe('parity with the srsRAN gNB metrics log', { skip: candidate ? false : 'no suitable recorded run found' }, () => {
  const c = candidate!
  const label = `0x${c?.rnti.toString(16).toUpperCase()}`

  test(`run ${c?.id}, UE ${label}: DL BLER matches srsRAN`, () => {
    const srsran = blerOf(c.rows.map((r) => r.dl))
    assert.ok(srsran !== null, 'srsRAN reported no DL HARQ activity')
    const ours = ourSummary(c, ['dlBler']).dlBler.avg
    assert.ok(Math.abs(ours - srsran) < 0.25,
      `DL BLER: srsRAN ${srsran.toFixed(3)}%, ours ${ours.toFixed(3)}%`)
  })

  // --- Weighting-independent metrics are compared over the whole window. ---
  // A ratio of sums and bytes-over-elapsed-time are both invariant to how samples are weighted.

  test(`run ${c?.id}, UE ${label}: DL throughput matches srsRAN brate`, () => {
    const srsran = meanOf(c.rows.map((r) => r.dl.brateBps))! / 1e6
    const ours = ourSummary(c, ['dlMbps']).dlMbps.avg
    assert.ok(within(ours, srsran, 0.1),
      `DL throughput: srsRAN ${srsran.toFixed(3)} Mbps, ours ${ours.toFixed(3)} Mbps`)
  })

  test(`run ${c?.id}, UE ${label}: UL throughput matches srsRAN brate`, () => {
    const srsran = meanOf(c.rows.map((r) => r.ul.brateBps))! / 1e6
    const ours = ourSummary(c, ['ulMbps']).ulMbps.avg
    assert.ok(within(ours, srsran, 0.1),
      `UL throughput: srsRAN ${srsran.toFixed(3)} Mbps, ours ${ours.toFixed(3)} Mbps — ` +
      'ul_ok_bytes is the matching counter; ul_tbs runs ~1.9x high')
  })

  // --- Weighting-sensitive metrics are compared per second. ---
  //
  // srsRAN publishes a value per metrics period; we aggregate per TTI. Any window-level
  // comparison therefore mixes two different weightings and the result depends on bucket width
  // (this run buckets at 7.6 s). Aligning per second removes that entirely and tests what parity
  // is actually about: do we count the same TTIs and compute the same quantity. Bucketing itself
  // is covered by metrics-query.test.ts.

  test(`run ${c?.id}, UE ${label}: DL MCS matches srsRAN, per second`, () => {
    const srsran = perSecond(c.rows, (r) => (r.dl.ok + r.dl.nok > 0 && r.dl.mcs > 0 ? r.dl.mcs : null))
    const ours = ourPerSecond(c, 'dlMcs', [...srsran.keys()])
    assertAgrees('DL MCS', srsran, ours, 0.05)
  })

  test(`run ${c?.id}, UE ${label}: CQI matches srsRAN, per second`, () => {
    const srsran = perSecond(c.rows, (r) => r.dl.cqi)
    const ours = ourPerSecond(c, 'cqi', [...srsran.keys()])
    assertAgrees('CQI', srsran, ours, 0.05)
  })

  test(`run ${c?.id}, UE ${label}: SNR matches srsRAN pusch, per second`, () => {
    // srsRAN prints n/a with no PUSCH and we skip those, which is the condition our snr
    // metric applies.
    const srsran = perSecond(c.rows, (r) => r.ul.snr)
    const ours = ourPerSecond(c, 'snr', [...srsran.keys()])
    assertAgrees('SNR', srsran, ours, 0.05)
  })
})

/** Mean of a per-row field within each wall-clock second, skipping nulls. */
function perSecond(rows: SrsranMetricRow[], pick: (r: SrsranMetricRow) => number | null): Map<number, number> {
  const buckets = new Map<number, number[]>()
  for (const row of rows) {
    const value = pick(row)
    if (value === null) continue
    const second = Math.floor(row.timestampMs / 1000)
    const list = buckets.get(second) ?? []
    list.push(value)
    buckets.set(second, list)
  }
  return new Map([...buckets].map(([s, v]) => [s, v.reduce((a, b) => a + b, 0) / v.length]))
}

/** The same quantity from ue_mac, built from the registry so the predicates themselves are tested. */
function ourPerSecond(c: Candidate, metricKey: string, seconds: number[]): Map<number, number> {
  const metric = METRICS_BY_KEY.get(metricKey)!
  const when = metric.definedWhen ?? '1'
  const db = new DatabaseSync(c.dbPath, { readOnly: true })
  const stmt = db.prepare(
    `SELECT AVG(CASE WHEN ${when} THEN ${metric.column} END) AS v FROM ue_mac ` +
    'WHERE rnti = ? AND timestamp_us >= ? AND timestamp_us < ?',
  )
  const out = new Map<number, number>()
  for (const second of seconds) {
    const row = stmt.get(c.rnti, second * 1_000_000, (second + 1) * 1_000_000) as { v: number | null }
    if (row?.v !== null && row?.v !== undefined) out.set(second, row.v)
  }
  db.close()
  return out
}

function assertAgrees(name: string, srsran: Map<number, number>, ours: Map<number, number>, tolerance: number) {
  const common = [...srsran.keys()].filter((s) => ours.has(s))
  // Drop the first and last second: both are partially covered by the log and the database.
  const seconds = common.sort((a, b) => a - b).slice(1, -1)
  assert.ok(seconds.length > 30, `expected a meaningful overlap, got ${seconds.length} seconds`)
  const a = seconds.reduce((sum, s) => sum + srsran.get(s)!, 0) / seconds.length
  const b = seconds.reduce((sum, s) => sum + ours.get(s)!, 0) / seconds.length
  assert.ok(Math.abs(b - a) / Math.abs(a) <= tolerance,
    `${name}: srsRAN ${a.toFixed(3)}, ours ${b.toFixed(3)} over ${seconds.length} aligned seconds`)
}

/** Relative comparison; srsRAN averages its own per-period means, we average per TTI. */
function within(ours: number, reference: number, tolerance: number): boolean {
  if (reference === 0) return Math.abs(ours) < 0.01
  return Math.abs(ours - reference) / Math.abs(reference) <= tolerance
}

function ourSummary(c: Candidate, metricKeys: string[]) {
  const startMs = Math.min(...c.rows.map((r) => r.timestampMs))
  const endMs = Math.max(...c.rows.map((r) => r.timestampMs))
  const result = queryMetrics({
    runId: c.id, dbPath: c.dbPath, isActive: false, window: '1h', metricKeys, fullRun: true,
  })
  const series = result.series.find((s) => s.rnti === c.rnti)
  assert.ok(series, `no series for ${c.rnti} in our metrics`)
  assert.ok(endMs > startMs, 'degenerate window')
  return series.summary
}
