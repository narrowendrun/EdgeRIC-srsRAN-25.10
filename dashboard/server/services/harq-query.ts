import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { allowedWindows, type WindowSize } from '../config.js'

export type HarqDirection = 'dl' | 'ul'

export interface HarqReliabilitySeries {
  rnti: number
  label: string
  direction: HarqDirection
  attempts: number
  successes: number
  failures: number
  excludedRetransmissions: number
  pSuccess: number | null
  observedSlots: number
  points: Array<{ timestamp: number; pSuccessPercent?: number; aoiMs: number }>
  aoi: {
    currentSlots: number
    meanSlots: number
    maxSlots: number
    currentMs: number
    meanMs: number
    maxMs: number
  }
}

export interface HarqCaptureCompleteness {
  complete: boolean | null
  messageSequenceGaps: number
  messageSequenceReorders: number | null
  harqSequenceGaps: number | null
  harqSequenceReorders: number | null
  duplicateMessages: number | null
  contractErrors: number | null
  parseErrors: number | null
  harqEventErrors: number | null
  observedMessages: number
  detail: string
}

export interface HarqResult {
  runId: string | null
  available: boolean
  schemaVersion: number | null
  reason?: string
  startAt?: string
  endAt?: string
  capture: HarqCaptureCompleteness | null
  scopeNote?: string
  series: HarqReliabilitySeries[]
}

export interface HarqQueryRequest {
  runId: string
  dbPath: string
  isActive: boolean
  window: WindowSize
  fullRun?: boolean
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

function schemaVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, 'metadata')) return null
  const row = db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as { value?: string } | undefined
  const value = Number(row?.value)
  return Number.isFinite(value) ? value : null
}

function stats(db: DatabaseSync): Map<string, number> {
  if (!tableExists(db, 'capture_stats')) return new Map()
  const rows = db.prepare('SELECT key, value FROM capture_stats').all() as unknown as Array<{ key: string; value: number }>
  return new Map(rows.map((row) => [row.key, Number(row.value)]))
}

function captureCompleteness(db: DatabaseSync): HarqCaptureCompleteness {
  const values = stats(db)
  const hasRecorderSequenceStats = values.has('messages') && values.has('first_message_sequence_id') &&
    values.has('message_sequence_gaps')
  const observed = hasRecorderSequenceStats ? null : db.prepare(`
      SELECT COUNT(*) AS messages, MIN(message_sequence_id) AS first_id,
             MAX(message_sequence_id) AS last_id
      FROM slot_observation
    `).get() as { messages: number; first_id: number | null; last_id: number | null }
  const messages = hasRecorderSequenceStats
    ? Math.max(0, (values.get('messages') ?? 0) - (values.get('duplicate_messages') ?? 0))
    : Number(observed?.messages ?? 0)
  const firstId = hasRecorderSequenceStats
    ? Number((db.prepare('SELECT MIN(message_sequence_id) AS first_id FROM slot_observation')
      .get() as { first_id: number | null }).first_id)
    : observed?.first_id ?? null
  const internalGaps = hasRecorderSequenceStats
    ? values.get('message_sequence_gaps') ?? 0
    : firstId === null || observed?.last_id === null
      ? 0
      : Math.max(0, Number(observed?.last_id) - Number(firstId) + 1 - messages)
  // Publisher sequences start at zero. A non-zero first delivered id is loss during subscriber
  // startup and must not be hidden merely because every later message was contiguous.
  const sequenceStartsAtZero = !values.has('sequence_starts_at_zero') || values.get('sequence_starts_at_zero') === 1
  const leadingGaps = firstId === null || !sequenceStartsAtZero ? 0 : Math.max(0, Number(firstId))
  const messageSequenceGaps = leadingGaps + internalGaps
  const messageSequenceReorders = values.has('message_sequence_reorders') ? values.get('message_sequence_reorders')! : null
  const harqSequenceGaps = values.has('harq_sequence_gaps') ? values.get('harq_sequence_gaps')! : null
  const harqSequenceReorders = values.has('harq_sequence_reorders') ? values.get('harq_sequence_reorders')! : null
  const duplicateMessages = values.has('duplicate_messages') ? values.get('duplicate_messages')! : null
  const contractErrors = values.has('contract_errors') ? values.get('contract_errors')! : null
  const parseErrors = values.has('parse_errors') ? values.get('parse_errors')! : null
  const harqEventErrors = values.has('harq_event_errors') ? values.get('harq_event_errors')! : null
  const counters = [messageSequenceReorders, harqSequenceGaps, harqSequenceReorders,
    duplicateMessages, contractErrors, parseErrors, harqEventErrors]
  const hasAllCounters = values.has('message_sequence_gaps') && counters.every((value) => value !== null)
  const complete = messages === 0 || !hasAllCounters
    ? null
    : messageSequenceGaps === 0 && counters.every((value) => value === 0)
  const detail = complete === null
    ? 'Capture completeness is unknown because no observations or completeness counters are available.'
    : complete
      ? 'No message/HARQ sequence gaps or reorders, duplicates, contract errors, parse errors, or rejected HARQ events were recorded.'
      : `${messageSequenceGaps} message gap(s), ${messageSequenceReorders ?? 0} message reorder(s), ` +
        `${harqSequenceGaps ?? 0} HARQ gap(s), ${harqSequenceReorders ?? 0} HARQ reorder(s), ` +
        `${duplicateMessages ?? 0} duplicate(s), ${contractErrors ?? 0} contract error(s), ` +
        `${parseErrors ?? 0} parse error(s), and ${harqEventErrors ?? 0} rejected HARQ event(s) were recorded.`
  return {
    complete, messageSequenceGaps, messageSequenceReorders, harqSequenceGaps,
    harqSequenceReorders, duplicateMessages, contractErrors, parseErrors, harqEventErrors,
    observedMessages: messages, detail,
  }
}

function round(value: number, precision = 3): number {
  return Number(value.toFixed(precision))
}

function empty(runId: string, available: boolean, version: number | null, reason?: string): HarqResult {
  return { runId, available, schemaVersion: version, reason, capture: null, series: [] }
}

interface HarqEventRow {
  id: number
  rnti: number
  direction: HarqDirection
  tx_slot: number
  attempt_number: number
  is_retransmission: number
  outcome: string
}

interface HarqEventCache {
  lastId: number
  events: HarqEventRow[]
}

const harqEventCaches = new Map<string, HarqEventCache>()

function loadHarqEvents(db: DatabaseSync, dbPath: string, endSlot: number): HarqEventRow[] {
  let cache = harqEventCaches.get(dbPath)
  if (!cache) {
    if (harqEventCaches.size >= 8) harqEventCaches.delete(harqEventCaches.keys().next().value!)
    cache = { lastId: 0, events: [] }
    harqEventCaches.set(dbPath, cache)
  }
  const added = db.prepare(`
    SELECT id, rnti, direction, tx_slot, attempt_number, is_retransmission, outcome
    FROM harq_outcome WHERE id > ? ORDER BY id
  `).all(cache.lastId) as unknown as HarqEventRow[]
  if (added.length) {
    cache.events = cache.events.concat(added)
    cache.lastId = added[added.length - 1].id
  }
  return cache.events.filter((event) => event.tx_slot <= endSlot)
}

interface AoiSummary {
  observedSlots: number
  currentSlots: number
  meanSlots: number
  maxSlots: number
  currentMs: number
  meanMs: number
  maxMs: number
}

function isSuccess(event: HarqEventRow): boolean {
  return event.direction === 'dl'
    ? event.outcome === 'ack' || event.outcome === 'ack_on_timeout'
    : event.outcome === 'crc_ok'
}

/** Sum an arithmetic age run without materialising one row per native slot. */
function fixedDurationAoi(
  startSlot: number,
  endSlot: number,
  firstPresence: number,
  previousSuccess: number | null,
  successSlots: number[],
  slotDurationNs: number,
): AoiSummary {
  let cursor = startSlot
  let age = previousSuccess === null ? startSlot - firstPresence + 2 : startSlot - previousSuccess + 1
  let count = 0
  let sum = 0
  let maximum = 0
  let current = age

  const appendFailures = (length: number) => {
    if (length <= 0) return
    sum += length * (2 * age + length - 1) / 2
    maximum = Math.max(maximum, age + length - 1)
    current = age + length - 1
    count += length
    cursor += length
    age += length
  }

  for (const successSlot of successSlots) {
    if (successSlot < cursor || successSlot > endSlot) continue
    appendFailures(successSlot - cursor)
    sum += 1
    maximum = Math.max(maximum, 1)
    current = 1
    count += 1
    cursor = successSlot + 1
    age = 2
  }
  appendFailures(endSlot - cursor + 1)

  const durationMs = slotDurationNs / 1_000_000
  return {
    observedSlots: count,
    currentSlots: current,
    meanSlots: sum / count,
    maxSlots: maximum,
    currentMs: current * durationMs,
    meanMs: sum / count * durationMs,
    maxMs: maximum * durationMs,
  }
}

function variableDurationAoi(
  slots: Array<{ native_slot: number; slot_duration_ns: number }>,
  startSlot: number,
  endSlot: number,
  successes: Set<number>,
): AoiSummary {
  let ageSlots = 1
  let ageMs = slots.length ? slots[0].slot_duration_ns / 1_000_000 : 0
  let observedSlots = 0
  let sumSlots = 0
  let sumMs = 0
  let maxSlots = 0
  let maxMs = 0
  let currentSlots = 0
  let currentMs = 0

  for (const slot of slots) {
    const durationMs = slot.slot_duration_ns / 1_000_000
    if (successes.has(slot.native_slot)) {
      ageSlots = 1
      ageMs = durationMs
    } else {
      ageSlots += 1
      ageMs += durationMs
    }
    if (slot.native_slot < startSlot || slot.native_slot > endSlot) continue
    observedSlots += 1
    sumSlots += ageSlots
    sumMs += ageMs
    maxSlots = Math.max(maxSlots, ageSlots)
    maxMs = Math.max(maxMs, ageMs)
    currentSlots = ageSlots
    currentMs = ageMs
  }
  return {
    observedSlots, currentSlots, meanSlots: sumSlots / observedSlots, maxSlots,
    currentMs, meanMs: sumMs / observedSlots, maxMs,
  }
}

function harqMetricPoints(
  startSlot: number,
  endSlot: number,
  firstPresence: number,
  previousSuccess: number | null,
  initialEvents: HarqEventRow[],
  slotDurationNs: number,
  windowDurationUs: number,
  lastObservedSlot: number,
  lastObservedTimestampUs: number,
): Array<{ timestamp: number; pSuccessPercent?: number; aoiMs: number }> {
  const bucketUs = Math.max(100_000, Math.ceil(windowDurationUs / 360 / 100_000) * 100_000)
  const slotsPerBucket = Math.max(1, Math.round(bucketUs * 1000 / slotDurationNs))
  const events = initialEvents.filter((event) => event.tx_slot >= startSlot && event.tx_slot <= endSlot)
  let eventIndex = 0
  let latestSuccess = previousSuccess
  const points: Array<{ timestamp: number; pSuccessPercent?: number; aoiMs: number }> = []

  for (let bucketStart = startSlot; bucketStart <= endSlot; bucketStart += slotsPerBucket) {
    const bucketEnd = Math.min(endSlot, bucketStart + slotsPerBucket - 1)
    let attempts = 0
    let successes = 0
    while (eventIndex < events.length && events[eventIndex].tx_slot <= bucketEnd) {
      const event = events[eventIndex++]
      attempts += 1
      if (isSuccess(event)) {
        successes += 1
        latestSuccess = event.tx_slot
      }
    }
    const ageSlots = latestSuccess === null
      ? bucketEnd - firstPresence + 2
      : bucketEnd - latestSuccess + 1
    const timestampUs = lastObservedTimestampUs -
      (lastObservedSlot - bucketStart) * slotDurationNs / 1000
    points.push({
      timestamp: Math.round(timestampUs / 1000),
      ...(attempts ? { pSuccessPercent: round(successes / attempts * 100, 6) } : {}),
      aoiMs: round(ageSlots * slotDurationNs / 1_000_000, 6),
    })
  }
  return points
}

/**
 * Reports terminal outcomes without reconstructing HARQ state in the dashboard.
 *
 * AoI is derived from the recorder's immutable active-slot and outcome ledgers. The selected
 * window is seeded from the last success before it, so a live refresh does not replay the full
 * run. SQLite window functions then perform the recurrence and only return aggregate rows.
 */
export function queryHarqReliability(request: HarqQueryRequest): HarqResult {
  if (!existsSync(request.dbPath)) return empty(request.runId, false, null, 'Metrics database is unavailable.')

  const db = new DatabaseSync(request.dbPath, { readOnly: true })
  try {
    db.exec('PRAGMA temp_store=MEMORY')
    db.exec('PRAGMA query_only=ON')
    const version = schemaVersion(db)
    const required = ['slot_observation', 'ue_slot_observation', 'harq_outcome']
    if (!required.every((name) => tableExists(db, name))) {
      return empty(request.runId, false, version, 'HARQ outcome and active-slot ledgers are not present in this archive.')
    }

    const capture = captureCompleteness(db)
    type EdgeObservation = { native_slot: number; timestamp_us: number; slot_duration_ns: number }
    const firstObservation = db.prepare(`
      SELECT native_slot, timestamp_us, slot_duration_ns
      FROM slot_observation ORDER BY native_slot LIMIT 1
    `).get() as EdgeObservation | undefined
    const lastObservation = db.prepare(`
      SELECT native_slot, timestamp_us, slot_duration_ns
      FROM slot_observation ORDER BY native_slot DESC LIMIT 1
    `).get() as EdgeObservation | undefined
    if (!firstObservation || !lastObservation) {
      return { ...empty(request.runId, true, version), capture }
    }

    const endUs = request.isActive
      ? Math.max(Number(lastObservation.timestamp_us), Date.now() * 1000)
      : Number(lastObservation.timestamp_us)
    const requestedUs = allowedWindows[request.window].milliseconds * 1000
    const startUs = request.fullRun
      ? Number(firstObservation.timestamp_us)
      : Math.max(Number(firstObservation.timestamp_us), endUs - requestedUs)
    const elapsedFromWindowStartUs = Math.max(0, lastObservation.timestamp_us - startUs)
    const estimatedSlots = Math.floor(elapsedFromWindowStartUs * 1000 / lastObservation.slot_duration_ns)
    const startNativeSlot = request.fullRun
      ? firstObservation.native_slot
      : Math.max(firstObservation.native_slot, lastObservation.native_slot - estimatedSlots)
    const endNativeSlot = lastObservation.native_slot

    type UeBounds = { rnti: number; first_slot: number; last_slot: number }
    const ueBounds = db.prepare(`
      SELECT rnti, MIN(native_slot) AS first_slot, MAX(native_slot) AS last_slot
      FROM ue_slot_observation
      WHERE native_slot BETWEEN ? AND ?
      GROUP BY rnti ORDER BY rnti
    `).all(startNativeSlot, endNativeSlot) as unknown as UeBounds[]

    const durationBounds = db.prepare(`
      SELECT MIN(slot_duration_ns) AS min_ns, MAX(slot_duration_ns) AS max_ns
      FROM slot_observation WHERE native_slot BETWEEN ? AND ?
    `).get(startNativeSlot, endNativeSlot) as { min_ns: number; max_ns: number }
    const fixedDuration = Number(durationBounds.min_ns) === Number(durationBounds.max_ns)

    const eventRows = loadHarqEvents(db, request.dbPath, endNativeSlot)
    const eventsBySeries = new Map<string, HarqEventRow[]>()
    for (const event of eventRows) {
      const key = `${event.rnti}:${event.direction}`
      const events = eventsBySeries.get(key)
      if (events) events.push(event)
      else eventsBySeries.set(key, [event])
    }
    for (const events of eventsBySeries.values()) events.sort((left, right) => left.tx_slot - right.tx_slot)

    const firstPresenceQuery = db.prepare(
      'SELECT MIN(native_slot) AS first_slot FROM ue_slot_observation WHERE rnti = ?',
    )
    const variableSlotsQuery = db.prepare(`
      SELECT presence.native_slot, observation.slot_duration_ns
      FROM ue_slot_observation presence
      JOIN slot_observation observation ON observation.native_slot = presence.native_slot
      WHERE presence.rnti = ? AND presence.native_slot BETWEEN ? AND ?
      ORDER BY presence.native_slot
    `)
    const directions: HarqDirection[] = ['dl', 'ul']
    const series: HarqReliabilitySeries[] = []

    for (const boundsForUe of ueBounds) {
      const firstPresenceRow = firstPresenceQuery.get(boundsForUe.rnti) as { first_slot: number }
      const firstPresence = Number(firstPresenceRow.first_slot)
      for (const direction of directions) {
        const events = eventsBySeries.get(`${boundsForUe.rnti}:${direction}`) ?? []
        const initialEvents = events.filter((event) => event.attempt_number === 0 && !event.is_retransmission)
        const successes = initialEvents.filter(isSuccess)
        let previousSuccess: number | null = null
        const successSet = new Set<number>()
        for (const event of successes) {
          if (event.tx_slot < boundsForUe.first_slot) previousSuccess = event.tx_slot
          else if (event.tx_slot <= boundsForUe.last_slot) successSet.add(event.tx_slot)
        }
        const selectedInitial = initialEvents.filter(
          (event) => event.tx_slot >= boundsForUe.first_slot && event.tx_slot <= boundsForUe.last_slot,
        )
        const successfulAttempts = selectedInitial.filter(isSuccess).length
        const retransmissions = events.filter(
          (event) => (event.attempt_number > 0 || Boolean(event.is_retransmission)) &&
            event.tx_slot >= boundsForUe.first_slot && event.tx_slot <= boundsForUe.last_slot,
        ).length
        const summary = fixedDuration
          ? fixedDurationAoi(
            boundsForUe.first_slot, boundsForUe.last_slot, firstPresence, previousSuccess,
            [...successSet].sort((left, right) => left - right), Number(durationBounds.min_ns),
          )
          : variableDurationAoi(
            variableSlotsQuery.all(boundsForUe.rnti, firstPresence, boundsForUe.last_slot) as unknown as
              Array<{ native_slot: number; slot_duration_ns: number }>,
            boundsForUe.first_slot, boundsForUe.last_slot,
            new Set(successes.map((event) => event.tx_slot)),
          )
        const attempts = selectedInitial.length
        series.push({
          rnti: Number(boundsForUe.rnti),
          label: `0x${Number(boundsForUe.rnti).toString(16).toUpperCase().padStart(4, '0')}`,
          direction, attempts, successes: successfulAttempts,
          failures: attempts - successfulAttempts,
          excludedRetransmissions: retransmissions,
          pSuccess: attempts === 0 ? null : round(successfulAttempts / attempts, 6),
          observedSlots: summary.observedSlots,
          points: harqMetricPoints(
            boundsForUe.first_slot, boundsForUe.last_slot, firstPresence, previousSuccess,
            initialEvents, Number(durationBounds.min_ns), Math.max(1, endUs - startUs),
            endNativeSlot, Number(lastObservation.timestamp_us),
          ),
          aoi: {
            currentSlots: summary.currentSlots,
            meanSlots: round(summary.meanSlots),
            maxSlots: summary.maxSlots,
            currentMs: round(summary.currentMs),
            meanMs: round(summary.meanMs),
            maxMs: round(summary.maxMs),
          },
        })
      }
    }

    return {
      runId: request.runId,
      available: true,
      schemaVersion: version,
      startAt: new Date(startUs / 1000).toISOString(),
      endAt: new Date(endUs / 1000).toISOString(),
      capture,
      scopeNote: 'UE presence is currently single-cell and RNTI-scoped; do not combine cells or RNTI-reuse epochs in one run. Sequence checks detect leading/interior loss but do not yet prove that the final publisher queue drained.',
      series,
    }
  } finally {
    db.close()
  }
}
