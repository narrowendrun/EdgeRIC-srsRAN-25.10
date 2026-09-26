import { copyFileSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { gnbConfigPath } from '../config.js'

export interface RfConfig extends Record<string, string> {
  device: string
  serial: string
  address: string
  masterClock: string
  sampleRate: string
  clockSource: string
  timeSource: string
  band: string
  frequency: string
  bandwidth: string
  mimo: string
  txGain: string
  rxGain: string
}

const UNKNOWN = 'unknown'

function unknownRfConfig(): RfConfig {
  return {
    device: UNKNOWN,
    serial: UNKNOWN,
    address: UNKNOWN,
    masterClock: UNKNOWN,
    sampleRate: UNKNOWN,
    clockSource: UNKNOWN,
    timeSource: UNKNOWN,
    band: UNKNOWN,
    frequency: UNKNOWN,
    bandwidth: UNKNOWN,
    mimo: UNKNOWN,
    txGain: UNKNOWN,
    rxGain: UNKNOWN,
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function present(value: unknown) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function withUnit(value: unknown, unit: string) {
  return present(value) ? `${String(value).trim()} ${unit}` : UNKNOWN
}

function deviceArguments(value: unknown) {
  const result = new Map<string, string>()
  if (!present(value)) return result
  for (const entry of String(value).split(',')) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    const key = entry.slice(0, separator).trim()
    const argument = entry.slice(separator + 1).trim()
    if (key && argument) result.set(key, argument)
  }
  return result
}

/**
 * Reads only values stated in the selected srsRAN YAML. This deliberately does not duplicate
 * srsRAN defaults or infer hardware state (such as reference lock) from process state.
 */
export function loadRfConfig(configPath = gnbConfigPath): RfConfig {
  try {
    const document = record(YAML.parse(readFileSync(configPath, 'utf8')))
    const ru = record(document.ru_sdr)
    const cell = record(document.cell_cfg)
    const args = deviceArguments(ru.device_args)
    const driver = present(ru.device_driver) ? String(ru.device_driver).trim() : null
    const deviceType = args.get('type') ?? null
    const dlArfcn = present(cell.dl_arfcn) ? String(cell.dl_arfcn).trim() : null
    const ulArfcn = present(cell.ul_arfcn) ? String(cell.ul_arfcn).trim() : null
    const dlPorts = present(cell.nof_antennas_dl) ? String(cell.nof_antennas_dl).trim() : null
    const ulPorts = present(cell.nof_antennas_ul) ? String(cell.nof_antennas_ul).trim() : null

    return {
      device: driver && deviceType ? `${driver} (${deviceType})` : driver ?? deviceType ?? UNKNOWN,
      serial: args.get('serial') ?? UNKNOWN,
      address: args.get('addr') ?? UNKNOWN,
      masterClock: args.get('master_clock_rate') ?? UNKNOWN,
      sampleRate: withUnit(ru.srate, 'MS/s'),
      clockSource: present(ru.clock) ? String(ru.clock).trim() : UNKNOWN,
      timeSource: present(ru.sync) ? String(ru.sync).trim() : UNKNOWN,
      band: present(cell.band) ? `n${String(cell.band).trim()}` : UNKNOWN,
      frequency: dlArfcn && ulArfcn
        ? `DL ARFCN ${dlArfcn} / UL ARFCN ${ulArfcn}`
        : dlArfcn ? `DL ARFCN ${dlArfcn}` : ulArfcn ? `UL ARFCN ${ulArfcn}` : UNKNOWN,
      bandwidth: withUnit(cell.channel_bandwidth_MHz, 'MHz'),
      mimo: dlPorts && ulPorts ? `${dlPorts}T${ulPorts}R` : UNKNOWN,
      txGain: withUnit(ru.tx_gain, 'dB'),
      rxGain: withUnit(ru.rx_gain, 'dB'),
    }
  } catch {
    return unknownRfConfig()
  }
}

export function loadRfStatus(configPath = gnbConfigPath): RfConfig & { reference: string } {
  return { ...loadRfConfig(configPath), reference: UNKNOWN }
}

/** Copies first and parses the copy so manifest fields describe the bytes archived with the run. */
export function archiveRfConfig(configDirectory: string, sourcePath = gnbConfigPath) {
  try {
    if (!statSync(sourcePath).isFile()) throw new Error('gNB config is not a regular file')
    const configFile = path.basename(sourcePath)
    const archivedPath = path.join(configDirectory, configFile)
    copyFileSync(sourcePath, archivedPath)
    return { configFile, rf: loadRfConfig(archivedPath) }
  } catch {
    return { configFile: null, rf: unknownRfConfig() }
  }
}
