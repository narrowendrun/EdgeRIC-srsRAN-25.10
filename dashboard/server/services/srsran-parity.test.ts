import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { logsRoot } from '../config.js'
import { queryMetrics } from './metrics-query.js'
import { blerOf, meanMcsWhenTransmitting, parseSrsranMetricsLog } from './srsran-metrics-log.js'

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

  test(`run ${c?.id}, UE ${label}: DL MCS matches srsRAN`, () => {
    const srsran = meanMcsWhenTransmitting(c.rows.map((r) => r.dl))
    assert.ok(srsran !== null, 'srsRAN reported no DL transmissions')
    const ours = ourSummary(c, ['dlMcs']).dlMcs.avg
    // srsRAN averages its own per-period means, we average per TTI, so they differ slightly.
    // A failure here means a semantic divergence, not rounding.
    assert.ok(Math.abs(ours - srsran) < 1.5,
      `DL MCS: srsRAN ${srsran.toFixed(2)}, ours ${ours.toFixed(2)} — ` +
      'a large gap means we are averaging over TTIs srsRAN excludes')
  })
})

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
