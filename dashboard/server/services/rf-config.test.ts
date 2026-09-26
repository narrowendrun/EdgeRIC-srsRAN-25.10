import { afterEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { projectRoot, resolveGnbConfigPath } from '../config.js'
import { archiveRfConfig, loadRfConfig, loadRfStatus } from './rf-config.js'

const temporaryDirectories: string[] = []

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), 'edgeric-rf-config-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  while (temporaryDirectories.length) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
})

describe('gNB RF configuration reporting', () => {
  test('resolves an explicitly selected config relative to the project root', () => {
    assert.equal(resolveGnbConfigPath('configs-gnb/ota.yml'), path.join(projectRoot, 'configs-gnb', 'ota.yml'))
    assert.equal(resolveGnbConfigPath('/tmp/ota.yml'), '/tmp/ota.yml')
  })

  test('reports configured YAML values without inventing absent hardware facts', () => {
    const directory = temporaryDirectory()
    const configPath = path.join(directory, 'ota.yml')
    writeFileSync(configPath, `
ru_sdr:
  device_driver: uhd
  device_args: type=x300, addr=192.0.2.10, master_clock_rate=184.32e6
  clock: external
  sync: internal
  srate: 23.04
  tx_gain: 10
  rx_gain: 11
cell_cfg:
  dl_arfcn: 632628
  band: 78
  channel_bandwidth_MHz: 20
`)

    assert.deepEqual(loadRfConfig(configPath), {
      device: 'uhd (x300)',
      serial: 'unknown',
      address: '192.0.2.10',
      masterClock: '184.32e6',
      sampleRate: '23.04 MS/s',
      clockSource: 'external',
      timeSource: 'internal',
      band: 'n78',
      frequency: 'DL ARFCN 632628',
      bandwidth: '20 MHz',
      mimo: 'unknown',
      txGain: '10 dB',
      rxGain: '11 dB',
    })
    assert.equal(loadRfStatus(configPath).reference, 'unknown')
  })

  test('uses explicit serial, UL ARFCN, and antenna counts when present', () => {
    const directory = temporaryDirectory()
    const configPath = path.join(directory, 'explicit.yml')
    writeFileSync(configPath, `
ru_sdr:
  device_args: type=b200,serial=ABC123
cell_cfg:
  dl_arfcn: 428000
  ul_arfcn: 390000
  nof_antennas_dl: 2
  nof_antennas_ul: 1
`)
    const rf = loadRfConfig(configPath)
    assert.equal(rf.serial, 'ABC123')
    assert.equal(rf.frequency, 'DL ARFCN 428000 / UL ARFCN 390000')
    assert.equal(rf.mimo, '2T1R')
  })

  test('returns unknown fields when the selected YAML is unavailable or invalid', () => {
    for (const configPath of ['/definitely/missing/gnb.yml', path.join(temporaryDirectory(), 'invalid.yml')]) {
      if (configPath.endsWith('invalid.yml')) writeFileSync(configPath, 'ru_sdr: [not: valid')
      assert.ok(Object.values(loadRfConfig(configPath)).every((value) => value === 'unknown'))
    }
  })

  test('derives manifest RF fields from the archived config snapshot', () => {
    const directory = temporaryDirectory()
    const sourcePath = path.join(directory, 'selected.yml')
    const archiveDirectory = path.join(directory, 'archive')
    mkdirSync(archiveDirectory)
    writeFileSync(sourcePath, 'ru_sdr:\n  tx_gain: 7\ncell_cfg:\n  band: 41\n')

    const snapshot = archiveRfConfig(archiveDirectory, sourcePath)
    writeFileSync(sourcePath, 'ru_sdr:\n  tx_gain: 99\n')

    assert.equal(snapshot.configFile, 'selected.yml')
    assert.equal(snapshot.rf.txGain, '7 dB')
    assert.equal(snapshot.rf.band, 'n41')
    assert.match(readFileSync(path.join(archiveDirectory, 'selected.yml'), 'utf8'), /tx_gain: 7/)
  })

  test('does not claim a config file or RF facts when snapshotting fails', () => {
    const snapshot = archiveRfConfig(temporaryDirectory(), '/definitely/missing/gnb.yml')
    assert.equal(snapshot.configFile, null)
    assert.ok(Object.values(snapshot.rf).every((value) => value === 'unknown'))
  })
})
