import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { allowedWindows, projectRoot, type WindowSize } from '../config.js'
import type { RunStore } from './run-store.js'

interface MetricRow {
  bucket_us: number
  rnti: number
  snr: number
  cqi: number
  dl_bytes: number
  ul_bytes: number
  dl_ack: number
  dl_nack: number
  ul_ok: number
  ul_fail: number
}

export function queryMetrics(store: RunStore, id: string, window: WindowSize, fullRun = false) {
  const dbPath = path.join(store.runDir(id), 'metrics.sqlite3')
  if (!existsSync(dbPath)) return { runId: id, available: false, series: [], capture: null }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    // The production service uses ProtectSystem=strict. Keep SQLite's GROUP BY
    // scratch data in memory so read-only chart queries never need /tmp.
    db.exec('PRAGMA temp_store=MEMORY')
    db.exec('PRAGMA query_only=ON')
    const bounds = db.prepare('SELECT MIN(timestamp_us) AS min_us, MAX(timestamp_us) AS max_us FROM raw_tti').get() as { min_us: number | null; max_us: number | null }
    if (!bounds.max_us || !bounds.min_us) return { runId: id, available: true, series: [], capture: captureStats(db) }
    const manifest = store.readManifest(id)
    const endUs = manifest?.status === 'active' ? Math.max(bounds.max_us, Date.now() * 1000) : bounds.max_us
    const requestedUs = allowedWindows[window].milliseconds * 1000
    const startUs = fullRun ? bounds.min_us : Math.max(bounds.min_us, endUs - requestedUs)
    const durationUs = Math.max(1, endUs - startUs)
    const bucketUs = Math.max(100_000, Math.ceil(durationUs / 360 / 100_000) * 100_000)
    const rows = db.prepare(`
      SELECT
        CAST((timestamp_us - ?) / ? AS INTEGER) * ? + ? AS bucket_us,
        rnti,
        AVG(snr) AS snr,
        AVG(cqi) AS cqi,
        SUM(dl_acked_bytes) AS dl_bytes,
        SUM(ul_ok_bytes) AS ul_bytes,
        SUM(dl_harq_ack) AS dl_ack,
        SUM(dl_harq_nack) AS dl_nack,
        SUM(ul_crc_ok) AS ul_ok,
        SUM(ul_crc_fail) AS ul_fail
      FROM ue_mac
      WHERE timestamp_us BETWEEN ? AND ?
      GROUP BY bucket_us, rnti
      ORDER BY bucket_us, rnti
    `).all(startUs, bucketUs, bucketUs, startUs, startUs, endUs) as unknown as MetricRow[]

    const grouped = new Map<number, Array<Record<string, number>>>()
    for (const row of rows) {
      const dlTotal = row.dl_ack + row.dl_nack
      const ulTotal = row.ul_ok + row.ul_fail
      const point = {
        timestamp: Math.round(row.bucket_us / 1000),
        snr: Number(row.snr.toFixed(2)), cqi: Number(row.cqi.toFixed(2)),
        dlMbps: Number(((row.dl_bytes * 8) / bucketUs).toFixed(3)),
        ulMbps: Number(((row.ul_bytes * 8) / bucketUs).toFixed(3)),
        dlBler: dlTotal ? Number(((row.dl_nack / dlTotal) * 100).toFixed(3)) : 0,
        ulBler: ulTotal ? Number(((row.ul_fail / ulTotal) * 100).toFixed(3)) : 0,
      }
      const points = grouped.get(row.rnti) || []
      points.push(point)
      grouped.set(row.rnti, points)
    }

    return {
      runId: id, available: true, startAt: new Date(startUs / 1000).toISOString(),
      endAt: new Date(endUs / 1000).toISOString(), bucketMs: bucketUs / 1000,
      series: [...grouped.entries()].map(([rnti, points]) => ({ rnti, label: `0x${rnti.toString(16).toUpperCase().padStart(4, '0')}`, points })),
      capture: captureStats(db),
    }
  } finally {
    db.close()
  }
}

function captureStats(db: DatabaseSync) {
  const rows = db.prepare('SELECT key, value FROM capture_stats').all() as unknown as Array<{ key: string; value: number }>
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]))
}

function fieldsFromProto(file: string) {
  const content = readFileSync(path.join(projectRoot, 'edgeric', 'protobufs', file), 'utf8')
  const messages: Array<{ name: string; fields: Array<{ name: string; type: string; repeated: boolean; description: string }> }> = []
  const matcher = /message\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  let messageMatch: RegExpExecArray | null
  while ((messageMatch = matcher.exec(content))) {
    const fields = []
    for (const line of messageMatch[2].split('\n')) {
      const match = line.match(/^\s*(repeated\s+)?([\w.]+)\s+(\w+)\s*=\s*\d+\s*;\s*(?:\/\/\s*(.*))?$/)
      if (match) fields.push({ repeated: Boolean(match[1]), type: match[2], name: match[3], description: match[4] || '' })
    }
    messages.push({ name: messageMatch[1], fields })
  }
  return messages
}

export function metricsCatalog() {
  return {
    published: [{
      endpoint: 'ipc:///tmp/metrics_data', transport: 'ZMQ PUB', rootMessage: 'TtiMetrics',
      note: 'The gNB publishes a conflated latest-value stream; subscribers may observe TTI gaps.',
      messages: fieldsFromProto('metrics.proto').filter((message) => !message.name.includes('Legacy')),
    }],
    subscribed: [
      { endpoint: 'ipc:///tmp/control_weights', transport: 'ZMQ SUB', rootMessage: 'SchedulingWeights', messages: fieldsFromProto('control_weights.proto') },
      { endpoint: 'ipc:///tmp/control_mcs', transport: 'ZMQ SUB', rootMessage: 'McsControl', messages: fieldsFromProto('control_mcs.proto') },
    ],
  }
}
