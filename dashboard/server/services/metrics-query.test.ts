import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queryMetrics } from './metrics-query.js'

/**
 * Fixture with deliberately round numbers so every expectation below is exact.
 *
 * 1000 TTIs, one UE:
 *   TTI   0- 99 (100)  scheduled: dl_prbs=20 dl_mcs=16, HARQ ack,  PUSCH present, snr=20
 *   TTI 100-199 (100)  scheduled: dl_prbs=10 dl_mcs=12, HARQ nack, PUSCH present, snr=20
 *   TTI 200-999 (800)  idle:      dl_prbs=0  dl_mcs=0,  no HARQ,   no PUSCH,      snr=30
 *
 * So:
 *   AVG(dl_mcs) over every TTI          = 2800/1000 = 2.8    <- what we used to report
 *   AVG(dl_mcs) where dl_prbs > 0       = 2800/ 200 = 14.0   <- what srsRAN reports
 *   DL BLER = nack/(ack+nack)           = 100/200   = 50%
 *   AVG(snr) over every TTI             = (200*20 + 800*30)/1000 = 28
 *   AVG(snr) where a PUSCH happened     = 20
 */
const BASE_US = 1_700_000_000_000_000
let dir: string
let dbPath: string

const COLS = [
  'timestamp_us', 'tti_index', 'rnti', 'snr', 'cqi', 'dl_mcs', 'ul_mcs', 'dl_prbs', 'ul_prbs',
  'dl_tbs', 'ul_tbs', 'dl_buffer', 'ul_buffer', 'dl_acked_bytes', 'ul_ok_bytes',
  'dl_harq_ack', 'dl_harq_nack', 'ul_crc_ok', 'ul_crc_fail', 'ce_delay_us', 'crc_delay_us',
  'pucch_harq_delay_us', 'pusch_harq_delay_us', 'sr_to_pusch_delay_us', 'sum_mac_delay_us',
  'ce_delay_valid', 'crc_delay_valid', 'pucch_harq_delay_valid', 'pusch_harq_delay_valid',
  'sr_to_pusch_delay_valid',
]

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-test-'))
  dbPath = path.join(dir, 'metrics.sqlite3')
  const db = new DatabaseSync(dbPath)
  db.exec(`CREATE TABLE ue_mac (id INTEGER PRIMARY KEY, raw_tti_id INTEGER, ${COLS.map((c) => `${c} ${c === 'snr' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`).join(', ')});`)
  db.exec('CREATE TABLE capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);')
  db.exec("INSERT INTO capture_stats VALUES ('messages', 1000);")
  const insert = db.prepare(`INSERT INTO ue_mac(${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`)
  for (let tti = 0; tti < 1000; tti++) {
    const scheduled = tti < 200
    const row: Record<string, number> = Object.fromEntries(COLS.map((c) => [c, 0]))
    row.timestamp_us = BASE_US + tti * 1000
    row.tti_index = tti
    row.rnti = 0x4601
    row.cqi = 10
    row.snr = scheduled ? 20 : 30
    // Missing native delay observations may leave a stale numeric payload, but validity is
    // authoritative. True zero is a valid observation and must remain distinguishable.
    row.ce_delay_us = tti < 100 ? 9999 : tti < 200 ? 0 : tti < 300 ? 4000 : 0
    row.ce_delay_valid = tti >= 100 && tti < 300 ? 1 : 0
    if (scheduled) {
      const good = tti < 100
      row.dl_mcs = good ? 16 : 12
      row.dl_prbs = good ? 20 : 10
      row.dl_acked_bytes = good ? 1000 : 0
      row.dl_harq_ack = good ? 1 : 0
      row.dl_harq_nack = good ? 0 : 1
      row.ul_crc_ok = 1
    }
    insert.run(...COLS.map((c) => row[c]))
  }
  db.close()
})

after(() => rmSync(dir, { recursive: true, force: true }))

function run(metricKeys: string[]) {
  const result = queryMetrics({
    runId: 'test', dbPath, isActive: false, window: '5m', metricKeys, fullRun: true,
  })
  assert.equal(result.series.length, 1, 'expected exactly one UE series')
  return result.series[0]
}

describe('BLER — already agrees with srsRAN, must not regress', () => {
  test('dlBler is nack/(ack+nack), matching srsRAN nok/(ok+nok)', () => {
    const s = run(['dlBler'])
    assert.equal(s.summary.dlBler.avg, 50, 'DL BLER should be 50%')
  })
})

describe('MCS — must match srsRAN, which averages over transmitted PDSCHs only', () => {
  test('average excludes TTIs with no allocation', () => {
    const s = run(['dlMcs'])
    assert.equal(s.summary.dlMcs.avg, 14,
      'srsRAN reports ~14 (2800/200 scheduled TTIs); averaging over all 1000 TTIs gives 2.8')
  })

  test('minimum is the lowest scheduled MCS, not the 0 of an idle TTI', () => {
    const s = run(['dlMcs'])
    assert.equal(s.summary.dlMcs.min, 12)
    assert.equal(s.summary.dlMcs.max, 16)
  })

  test('buckets with no allocation report no value rather than zero', () => {
    const s = run(['dlMcs'])
    const idle = s.points.filter((p) => p.timestamp >= Math.round((BASE_US + 200_000) / 1000))
    assert.ok(idle.length > 0, 'fixture should produce idle buckets')
    assert.ok(idle.every((p) => p.dlMcs === undefined),
      'an idle bucket must omit dlMcs, not report 0 — a broken line is honest, a zero is not')
  })
})

describe('PRBs and TBS share the MCS condition', () => {
  test('dlPrbs averages over scheduled TTIs', () => {
    const s = run(['dlPrbs'])
    assert.equal(s.summary.dlPrbs.avg, 15, '(100*20 + 100*10)/200 = 15')
    assert.equal(s.summary.dlPrbs.max, 20)
  })
})

describe('SNR — srsRAN prints n/a when there was no PUSCH', () => {
  test('average counts only TTIs with a PUSCH', () => {
    const s = run(['snr'])
    assert.equal(s.summary.snr.avg, 20,
      'only the 200 TTIs with UL activity count; including idle TTIs would give 28')
  })
})

describe('metrics with no qualifying observations', () => {
  test('an average metric is absent rather than summarised as zero', () => {
    // The fixture never assigns UL PRBs, so UL MCS has no observation in any TTI.
    const s = run(['ulMcs'])
    assert.ok(s.points.every((point) => point.ulMcs === undefined))
    assert.equal(s.summary.ulMcs, undefined,
      'no UL allocation must render as unavailable, not as MCS 0')
  })
})

describe('native optional MAC delays', () => {
  test('missing samples are excluded while a present zero remains a real observation', () => {
    const s = run(['ceDelay'])
    assert.equal(s.summary.ceDelay.min, 0, 'present zero must not be treated as missing')
    assert.equal(s.summary.ceDelay.max, 4)
    assert.equal(s.summary.ceDelay.avg, 2,
      '100 present zeroes and 100 present 4 ms samples average to 2 ms; absent rows do not count')
  })

  test('a delay with no native observations is undefined, not zero', () => {
    const s = run(['crcDelay'])
    assert.ok(s.points.every((point) => point.crcDelay === undefined))
    assert.equal(s.summary.crcDelay, undefined)
  })

  test('synthetic Total MAC delay is no longer a dashboard metric', () => {
    const result = queryMetrics({
      runId: 'test', dbPath, isActive: false, window: '5m', metricKeys: ['sumMacDelay'], fullRun: true,
    })
    assert.deepEqual(result.metrics, [])
    assert.deepEqual(result.unavailable, ['sumMacDelay'])
  })
})

describe('CQI — srsRAN reports it every period regardless of scheduling', () => {
  test('average covers every TTI', () => {
    const s = run(['cqi'])
    assert.equal(s.summary.cqi.avg, 10)
  })
})

describe('throughput is a rate over time and must count idle TTIs', () => {
  test('dlMbps divides by the whole window, not just scheduled TTIs', () => {
    const s = run(['dlMbps'])
    // 100 TTIs * 1000 bytes = 100_000 bytes = 800_000 bits over 1.0 s => 0.8 Mbps
    assert.ok(Math.abs(s.summary.dlMbps.avg - 0.8) < 0.01,
      `expected ~0.8 Mbps over the full window, got ${s.summary.dlMbps.avg}`)
  })
})

/**
 * A rate's denominator must be the wall-clock time the bucket actually covers. The newest bucket
 * in any window is normally partial -- and during a live run it is the one the numeric tile shows
 * as the current value, so getting this wrong makes live throughput read systematically low.
 */
describe('rate metrics and the partial final bucket', () => {
  let rateDir: string
  let ratePath: string

  function build(ttis: number, bytesPerTti: number) {
    rateDir = mkdtempSync(path.join(tmpdir(), 'metrics-rate-'))
    ratePath = path.join(rateDir, 'metrics.sqlite3')
    const db = new DatabaseSync(ratePath)
    db.exec(`CREATE TABLE ue_mac (id INTEGER PRIMARY KEY, raw_tti_id INTEGER, ${COLS.map((c) => `${c} ${c === 'snr' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`).join(', ')});`)
    db.exec('CREATE TABLE capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);')
    const insert = db.prepare(`INSERT INTO ue_mac(timestamp_us, tti_index, rnti, ul_ok_bytes) VALUES (?,?,?,?)`)
    for (let tti = 0; tti < ttis; tti++) insert.run(BASE_US + tti * 1000, tti, 0x4601, bytesPerTti)
    db.close()
  }

  after(() => rateDir && rmSync(rateDir, { recursive: true, force: true }))

  test('the last partial bucket reports the true rate, not a diluted one', () => {
    // 951 TTIs at 1 ms, 1000 B each -> a steady 8 Mbps. Window is 950 ms, buckets are 100 ms,
    // so the final bucket covers only 50 ms. Dividing its 51 kB by the full 100 ms gives 4.08.
    build(951, 1000)
    const r = queryMetrics({ runId: 't', dbPath: ratePath, isActive: false, window: '5m', metricKeys: ['ulMbps'], fullRun: true })
    const points = r.series[0].points
    assert.equal(r.bucketMs, 100, 'fixture should produce 100 ms buckets')
    const interior = points[points.length - 2].ulMbps!
    const final = points[points.length - 1].ulMbps!
    assert.ok(Math.abs(interior - 8) < 0.2, `interior bucket should be ~8 Mbps, got ${interior}`)
    assert.ok(Math.abs(final - 8) < 0.5,
      `final bucket covers half its width, so it must still read ~8 Mbps, got ${final} ` +
      '(4.08 means it was divided by the nominal bucket width)')
  })

  test('a sliver of a bucket is omitted rather than reported as a spike or a dip', () => {
    // 910 TTIs -> the final bucket covers 9 ms of 100 ms. Too little to derive a rate from.
    build(910, 1000)
    const r = queryMetrics({ runId: 't', dbPath: ratePath, isActive: false, window: '5m', metricKeys: ['ulMbps'], fullRun: true })
    const points = r.series[0].points
    const final = points[points.length - 1]
    assert.equal(final.ulMbps, undefined,
      'a bucket covering under a quarter of its width should omit the rate')
  })

  test('the window average is unaffected -- it already divides by the true span', () => {
    build(951, 1000)
    const r = queryMetrics({ runId: 't', dbPath: ratePath, isActive: false, window: '5m', metricKeys: ['ulMbps'], fullRun: true })
    assert.ok(Math.abs(r.series[0].summary.ulMbps.avg - 8) < 0.2)
  })
})

/**
 * The live path: endUs is wall-clock `now`, but the recorder commits in batches so the newest
 * sample lags it. The rate denominator must follow the data, not the clock.
 */
describe('rate metrics on a live run', () => {
  let liveDir: string
  let livePath: string

  after(() => liveDir && rmSync(liveDir, { recursive: true, force: true }))

  test('a commit lag between the last sample and now does not dilute the rate', () => {
    liveDir = mkdtempSync(path.join(tmpdir(), 'metrics-live-'))
    livePath = path.join(liveDir, 'metrics.sqlite3')
    const db = new DatabaseSync(livePath)
    db.exec(`CREATE TABLE ue_mac (id INTEGER PRIMARY KEY, raw_tti_id INTEGER, ${COLS.map((c) => `${c} ${c === 'snr' ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`).join(', ')});`)
    db.exec('CREATE TABLE capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);')
    const insert = db.prepare('INSERT INTO ue_mac(timestamp_us, tti_index, rnti, ul_ok_bytes) VALUES (?,?,?,?)')
    // 2 s of steady 8 Mbps traffic, ending 400 ms before "now" — the recorder's commit lag.
    const nowUs = Date.now() * 1000
    const startUs = nowUs - 2_400_000
    for (let i = 0; i < 2000; i++) insert.run(startUs + i * 1000, i % 10000, 0x4601, 1000)
    db.close()

    const r = queryMetrics({
      runId: 't', dbPath: livePath, isActive: true, window: '5m',
      metricKeys: ['ulMbps', 'ulBler'], fullRun: false,
    })
    const points = r.series[0].points.filter((p) => p.ulMbps !== undefined)
    assert.ok(points.length >= 3, 'expected several buckets with data')
    for (const p of points) {
      assert.ok(Math.abs(p.ulMbps! - 8) < 1.0,
        `every bucket carrying data should read ~8 Mbps, got ${p.ulMbps} at ${new Date(p.timestamp).toISOString()}`)
    }
    assert.ok(Math.abs(r.series[0].summary.ulMbps.avg - 8) < 0.1,
      `summary must exclude the recorder commit-lag tail, got ${r.series[0].summary.ulMbps.avg}`)
    assert.ok(r.series[0].points.every((point) => point.ulBler === undefined),
      'a bucket with no CRC outcomes has no BLER')
    assert.equal(r.series[0].summary.ulBler, undefined,
      'no CRC outcomes must not be summarised as perfect 0% BLER')
  })
})
