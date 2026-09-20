import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const projectRoot = process.env.PROJECT_ROOT || path.resolve(here, '../..')
export const dashboardRoot = path.join(projectRoot, 'dashboard')
export const logsRoot = path.join(projectRoot, 'logs')
export const host = process.env.DASHBOARD_HOST || '0.0.0.0'
export const port = Number(process.env.DASHBOARD_PORT || 4173)
export const webuiProxyPort = Number(process.env.OPEN5GS_PROXY_PORT || 4174)

export const managedUnits = {
  open5gs: 'edgeric-open5gs.service',
  edgeric: 'edgeric-collector.service',
  gnb: 'edgeric-gnb.service',
} as const

export type ModuleName = keyof typeof managedUnits
export type ServiceAction = 'start' | 'stop' | 'restart'
export type WindowSize = '5m' | '15m' | '30m' | '1h'

export const open5gsUnits = [
  'open5gs-amfd.service', 'open5gs-smfd.service', 'open5gs-upfd.service',
  'open5gs-ausfd.service', 'open5gs-bsfd.service', 'open5gs-hssd.service',
  'open5gs-mmed.service', 'open5gs-nrfd.service', 'open5gs-nssfd.service',
  'open5gs-pcfd.service', 'open5gs-pcrfd.service', 'open5gs-scpd.service',
  'open5gs-seppd.service', 'open5gs-sgwcd.service', 'open5gs-sgwud.service',
  'open5gs-udmd.service', 'open5gs-udrd.service', 'open5gs-webui.service',
]

export const criticalOpen5gsUnits = [
  'open5gs-amfd.service', 'open5gs-smfd.service', 'open5gs-upfd.service',
]

export const allowedWindows: Record<WindowSize, { since: string; milliseconds: number; lineLimit: number }> = {
  '5m': { since: '5 minutes ago', milliseconds: 5 * 60_000, lineLimit: 500 },
  '15m': { since: '15 minutes ago', milliseconds: 15 * 60_000, lineLimit: 1000 },
  '30m': { since: '30 minutes ago', milliseconds: 30 * 60_000, lineLimit: 1500 },
  '1h': { since: '1 hour ago', milliseconds: 60 * 60_000, lineLimit: 2000 },
}

export const open5gsLogNames = [
  'amf', 'ausf', 'bsf', 'hss', 'mme', 'nrf', 'nssf', 'pcf', 'pcrf',
  'scp', 'sepp1', 'sgwc', 'sgwu', 'smf', 'udm', 'udr', 'upf',
]
