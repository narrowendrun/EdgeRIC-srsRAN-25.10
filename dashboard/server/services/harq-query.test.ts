import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { queryHarqReliability } from './harq-query.js'

const BASE_US = 1_700_000_000_000_000
const RNTI = 0x4601
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(slots: Array<{ native: number; durationNs?: number; messageId?: number }> =
  [10, 11, 12, 13, 14].map((native) => ({ native }))) {
  const dir = mkdtempSync(path.join(tmpdir(), 'harq-query-'))
  dirs.push(dir)
  const dbPath = path.join(dir, 'metrics.sqlite3')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('schema_version', '3');
    CREATE TABLE capture_stats (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE TABLE slot_observation (
      native_slot INTEGER PRIMARY KEY, message_sequence_id INTEGER NOT NULL UNIQUE,
      timestamp_us INTEGER NOT NULL, tti_index INTEGER NOT NULL,
      numerology INTEGER NOT NULL, slot_duration_ns INTEGER NOT NULL
    );
    CREATE TABLE ue_slot_observation (
      native_slot INTEGER NOT NULL, rnti INTEGER NOT NULL,
      PRIMARY KEY (native_slot, rnti)
    ) WITHOUT ROWID;
    CREATE TABLE harq_outcome (
      id INTEGER PRIMARY KEY, sequence_id INTEGER NOT NULL UNIQUE,
      timestamp_us INTEGER NOT NULL, cell_index INTEGER NOT NULL, du_ue_index INTEGER NOT NULL,
      rnti INTEGER NOT NULL, direction TEXT NOT NULL, tx_slot INTEGER NOT NULL,
      feedback_slot INTEGER NOT NULL, harq_id INTEGER NOT NULL, attempt_number INTEGER NOT NULL,
      is_retransmission INTEGER NOT NULL, ndi INTEGER NOT NULL, outcome TEXT NOT NULL,
      tbs_bytes INTEGER NOT NULL
    );
  `)
  const counters = [
    'message_sequence_gaps', 'message_sequence_reorders', 'harq_sequence_gaps',
    'harq_sequence_reorders', 'duplicate_messages', 'contract_errors', 'parse_errors',
    'harq_event_errors',
  ]
  const insertCounter = db.prepare('INSERT INTO capture_stats VALUES (?, 0)')
  for (const name of counters) insertCounter.run(name)
  const insertSlot = db.prepare('INSERT INTO slot_observation VALUES (?, ?, ?, ?, 1, ?)')
  const insertUe = db.prepare('INSERT INTO ue_slot_observation VALUES (?, ?)')
  slots.forEach((slot, index) => {
    insertSlot.run(slot.native, slot.messageId ?? index, BASE_US + index * 500, index, slot.durationNs ?? 500_000)
    insertUe.run(slot.native, RNTI)
  })
  let sequence = 1
  const insertOutcome = db.prepare(`
    INSERT INTO harq_outcome(sequence_id, timestamp_us, cell_index, du_ue_index, rnti,
      direction, tx_slot, feedback_slot, harq_id, attempt_number, is_retransmission,
      ndi, outcome, tbs_bytes)
    VALUES (?, ?, 0, 1, ?, ?, ?, ?, ?, ?, ?, 1, ?, 100)
  `)
  function outcome(direction: 'dl' | 'ul', txSlot: number, name: string, attempt = 0) {
    insertOutcome.run(sequence++, BASE_US + 10_000, RNTI, direction, txSlot, txSlot + 1,
      sequence % 16, attempt, attempt > 0 ? 1 : 0, name)
  }
  return { db, dbPath, outcome }
}

function run(dbPath: string) {
  return queryHarqReliability({
    runId: 'test', dbPath, isActive: false, window: '5m', fullRun: true,
  })
}

describe('resolved initial-attempt probability and retrospective AoI', () => {
  test('keeps directions separate, counts terminal failures, and excludes retransmissions', () => {
    const { db, dbPath, outcome } = fixture()
    outcome('dl', 10, 'ack')
    outcome('dl', 11, 'nack')
    outcome('dl', 13, 'ack_on_timeout')
    outcome('dl', 14, 'ack', 1)
    outcome('ul', 12, 'crc_ok')
    outcome('ul', 14, 'crc_fail')
    db.close()

    const result = run(dbPath)
    const dl = result.series.find((series) => series.direction === 'dl')!
    const ul = result.series.find((series) => series.direction === 'ul')!
    assert.deepEqual(
      { attempts: dl.attempts, successes: dl.successes, failures: dl.failures, retrans: dl.excludedRetransmissions },
      { attempts: 3, successes: 2, failures: 1, retrans: 1 },
    )
    assert.equal(dl.pSuccess, 0.666667)
    assert.equal(dl.points.length, 1)
    assert.equal(dl.points[0].pSuccessPercent, 66.666667)
    assert.equal(dl.points[0].aoiMs, 1)
    assert.deepEqual(dl.aoi, {
      currentSlots: 2, meanSlots: 1.8, maxSlots: 3,
      currentMs: 1, meanMs: 0.9, maxMs: 1.5,
    })
    assert.deepEqual(
      { attempts: ul.attempts, successes: ul.successes, failures: ul.failures },
      { attempts: 2, successes: 1, failures: 1 },
    )
    assert.equal(ul.pSuccess, 0.5)
    assert.equal(ul.points[0].pSuccessPercent, 50)
    assert.equal(ul.points[0].aoiMs, 1.5)
    assert.deepEqual(ul.aoi, {
      currentSlots: 3, meanSlots: 2.2, maxSlots: 3,
      currentMs: 1.5, meanMs: 1.1, maxMs: 1.5,
    })
  })

  test('reports probability as unknown when no initial attempt has resolved', () => {
    const { db, dbPath } = fixture()
    db.close()
    const result = run(dbPath)
    for (const series of result.series) {
      assert.equal(series.attempts, 0)
      assert.equal(series.pSuccess, null)
    }
  })

  test('uses a(0)=1 before the first success', () => {
    const { db, dbPath, outcome } = fixture()
    outcome('dl', 12, 'ack')
    db.close()
    const dl = run(dbPath).series.find((series) => series.direction === 'dl')!
    // Ages are [2, 3, 1, 2, 3], not [1, 2, 1, 2, 3].
    assert.equal(dl.aoi.meanSlots, 2.2)
    assert.equal(dl.aoi.maxSlots, 3)
    assert.equal(dl.aoi.currentSlots, 3)
  })

  test('treats ACK_ON_TIMEOUT as a successful DL terminal outcome', () => {
    const { db, dbPath, outcome } = fixture()
    outcome('dl', 10, 'ack_on_timeout')
    db.close()
    const dl = run(dbPath).series.find((series) => series.direction === 'dl')!
    assert.equal(dl.pSuccess, 1)
    assert.equal(dl.aoi.meanSlots, 3)
  })

  test('sums actual slot durations for millisecond AoI', () => {
    const { db, dbPath } = fixture([
      { native: 10, durationNs: 500_000 },
      { native: 11, durationNs: 1_000_000 },
      { native: 12, durationNs: 500_000 },
    ])
    db.close()
    const dl = run(dbPath).series.find((series) => series.direction === 'dl')!
    assert.deepEqual(dl.aoi, {
      currentSlots: 4, meanSlots: 3, maxSlots: 4,
      currentMs: 2.5, meanMs: 1.833, maxMs: 2.5,
    })
  })
})

describe('archive trust state', () => {
  test('flags publisher message sequence gaps', () => {
    const { db, dbPath } = fixture([
      { native: 10, messageId: 0 },
      { native: 11, messageId: 2 },
    ])
    db.close()
    const result = run(dbPath)
    assert.equal(result.capture?.messageSequenceGaps, 1)
    assert.equal(result.capture?.complete, false)
  })

  test('flags messages lost before the first delivered publisher sequence', () => {
    const { db, dbPath } = fixture([
      { native: 10, messageId: 4 },
      { native: 11, messageId: 5 },
    ])
    db.close()
    const result = run(dbPath)
    assert.equal(result.capture?.messageSequenceGaps, 4)
    assert.equal(result.capture?.complete, false)
  })

  test('accepts a non-zero sequence baseline after an acknowledged lossless run rotation', () => {
    const { db, dbPath } = fixture([
      { native: 10, messageId: 4000 },
      { native: 11, messageId: 4001 },
    ])
    db.prepare("INSERT INTO capture_stats(key, value) VALUES ('sequence_starts_at_zero', 0)").run()
    db.close()
    const result = run(dbPath)
    assert.equal(result.capture?.messageSequenceGaps, 0)
    assert.equal(result.capture?.complete, true)
  })

  test('keeps pre-v3 archives explicitly unavailable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harq-legacy-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'metrics.sqlite3')
    const db = new DatabaseSync(dbPath)
    db.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('schema_version', '2')")
    db.close()
    const result = run(dbPath)
    assert.equal(result.available, false)
    assert.equal(result.schemaVersion, 2)
    assert.match(result.reason || '', /not present/i)
  })
})
