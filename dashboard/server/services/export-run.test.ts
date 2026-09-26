import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const BASE_US = 1_700_000_000_000_000
const SCRIPT = fileURLToPath(new URL('../scripts/export_run.py', import.meta.url))
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function exportFixture(ttis: number) {
  const dir = mkdtempSync(path.join(tmpdir(), 'export-run-'))
  dirs.push(dir)
  const db = new DatabaseSync(path.join(dir, 'metrics.sqlite3'))
  db.exec(`CREATE TABLE ue_mac (
    timestamp_us INTEGER NOT NULL, rnti INTEGER NOT NULL, ul_ok_bytes INTEGER NOT NULL,
    ul_crc_fail INTEGER NOT NULL, ul_crc_ok INTEGER NOT NULL
  )`)
  const insert = db.prepare('INSERT INTO ue_mac VALUES (?, ?, ?, 0, 0)')
  for (let tti = 0; tti < ttis; tti++) insert.run(BASE_US + tti * 1000, 0x4601, 1000)
  db.close()

  writeFileSync(path.join(dir, 'metrics-schema.json'), JSON.stringify({ metrics: [
    { key: 'ulMbps', columns: ['ul_ok_bytes'], definedWhen: null, aggregation: 'rate', scale: 1, precision: 3 },
    { key: 'ulBler', columns: ['ul_crc_fail', 'ul_crc_ok'], definedWhen: null, aggregation: 'ratio', scale: 1, precision: 3 },
  ] }))

  const result = spawnSync('python3', [SCRIPT, dir, '--bucket', '0.1'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').map((line) => line.split(','))
}

test('CSV rates use the data-covered span of a partial final bucket', () => {
  const rows = exportFixture(951)
  assert.equal(rows.length, 11, 'header plus ten buckets across a 950 ms span')
  const last = rows[rows.length - 1]
  // The final bucket has 51 kB across the same 50 ms span used by the dashboard.
  assert.equal(Number(last[2]), 8.16)
  assert.equal(last[3], '', 'no CRC outcomes means BLER is blank, not zero')
})

test('CSV rates omit a final bucket covering less than a quarter of its width', () => {
  const rows = exportFixture(910)
  assert.equal(rows[rows.length - 1][2], '')
})
