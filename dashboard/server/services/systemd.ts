import { existsSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import {
  criticalOpen5gsUnits, managedUnits, open5gsUnits, projectRoot, webuiProxyPort,
  type ModuleName, type ServiceAction,
} from '../config.js'
import { run } from '../utils.js'

async function unitState(unit: string) {
  const result = await run('/usr/bin/systemctl', ['is-active', unit])
  return result.stdout || 'inactive'
}

async function processRunning(pattern: string) {
  const result = await run('/usr/bin/pgrep', ['-f', pattern])
  return result.ok && Boolean(result.stdout)
}

function interfaceIpv4(name: string) {
  return networkInterfaces()[name]?.find((address) => address.family === 'IPv4')?.address || ''
}

function latestUeSnapshot() {
  const stateFile = '/tmp/edgeric_ue_state.json'
  try {
    const snapshot = JSON.parse(readFileSync(stateFile, 'utf8')) as { count?: number; rntis?: string[] }
    const ageMs = Date.now() - statSync(stateFile).mtimeMs
    if (ageMs > 5000 || !Number.isInteger(snapshot.count) || !Array.isArray(snapshot.rntis)) {
      throw new Error('stale or invalid UE state')
    }
    return { count: snapshot.count as number, rntis: snapshot.rntis, fresh: true }
  } catch {
    return { count: null, rntis: [] as string[], fresh: false }
  }
}

function tcpReachable(address: string, targetPort: number, timeout = 400) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: address, port: targetPort })
    const finish = (value: boolean) => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

function loadRfConfig() {
  const configPath = path.join(projectRoot, 'gnb_rf_x310_tdd_n78_20mhz.yml')
  try {
    const document = YAML.parse(readFileSync(configPath, 'utf8'))
    const ru = document.ru_sdr || {}
    const cell = document.cell_cfg || {}
    const args = String(ru.device_args || '')
    const argValue = (name: string) => args.match(new RegExp(`(?:^|,)${name}=([^,]+)`))?.[1] || '—'
    return {
      device: 'USRP X310', serial: '308CD6E', address: argValue('addr'),
      masterClock: argValue('master_clock_rate'), sampleRate: `${ru.srate ?? '—'} MS/s`,
      clockSource: ru.clock || 'default (internal)', timeSource: ru.sync || 'default (internal)',
      band: `n${cell.band ?? '—'}`,
      frequency: cell.dl_arfcn === 632628 ? '3489.42 MHz' : `ARFCN ${cell.dl_arfcn ?? '—'}`,
      bandwidth: `${cell.channel_bandwidth_MHz ?? '—'} MHz`, mimo: '1T1R',
      txGain: `${ru.tx_gain ?? '—'} dB`, rxGain: `${ru.rx_gain ?? '—'} dB`,
    }
  } catch {
    return {
      device: 'USRP X310', serial: '308CD6E', address: 'unknown', masterClock: 'unknown',
      sampleRate: 'unknown', clockSource: 'unknown', timeSource: 'unknown', band: 'unknown',
      frequency: 'unknown', bandwidth: 'unknown', mimo: '1T1R', txGain: 'unknown', rxGain: 'unknown',
    }
  }
}

export async function getStatus() {
  const iperfAddress = interfaceIpv4('ogstun')
  const [open5gsStates, gnbUnit, collectorUnit, recorderUnit, iperfUnit, manualGnb, manualCollector, remoteControl, webui, iperfReachable, ues] = await Promise.all([
    Promise.all(open5gsUnits.map(async (unit) => [unit, await unitState(unit)] as const)),
    unitState(managedUnits.gnb), unitState(managedUnits.edgeric), unitState('edgeric-metrics-recorder.service'),
    unitState('iperf3.service'), processRunning('/build/apps/gnb/gnb'),
    processRunning('python(3)? .*collector\\.py'), tcpReachable('127.0.0.1', 55555),
    tcpReachable('127.0.0.1', 9999), iperfAddress ? tcpReachable(iperfAddress, 5201) : Promise.resolve(false), latestUeSnapshot(),
  ])

  const stateMap = Object.fromEntries(open5gsStates)
  const activeCount = open5gsStates.filter(([, state]) => state === 'active').length
  const criticalActive = criticalOpen5gsUnits.every((unit) => stateMap[unit] === 'active')
  const controlsReady = [...Object.values(managedUnits), 'edgeric-metrics-recorder.service']
    .every((unit) => existsSync(`/etc/systemd/system/${unit}`))
  const gnbActive = gnbUnit === 'active' || manualGnb
  const collectorActive = collectorUnit === 'active' || manualCollector
  const recorderActive = recorderUnit === 'active'
  const rfConfig = loadRfConfig()

  return {
    timestamp: new Date().toISOString(), controlsReady,
    rf: { ...rfConfig, reference: rfConfig.clockSource === 'external' && gnbActive ? 'locked at startup' : rfConfig.clockSource },
    modules: {
      open5gs: {
        state: criticalActive ? 'active' : activeCount > 0 ? 'degraded' : 'inactive',
        detail: `${activeCount}/${open5gsUnits.length} services active`,
        managed: existsSync(`/etc/systemd/system/${managedUnits.open5gs}`),
      },
      edgeric: {
        state: collectorActive && recorderActive ? 'active' : collectorActive || recorderActive ? 'degraded' : 'inactive',
        detail: collectorActive && recorderActive ? 'collector and metrics recorder subscribed' : collectorActive ? 'collector active · recorder inactive' : recorderActive ? 'recorder active · collector inactive' : 'collector and recorder are not running',
        managed: collectorUnit === 'active',
      },
      gnb: {
        state: gnbActive && remoteControl ? 'active' : gnbActive ? 'degraded' : 'inactive',
        detail: remoteControl ? 'cell running · control :55555' : gnbActive ? 'process running · control unavailable' : 'gNB is not running',
        managed: gnbUnit === 'active',
      },
    },
    ues,
    iperf3: {
      state: iperfUnit === 'active' && iperfReachable ? 'active' : iperfUnit === 'active' ? 'degraded' : 'inactive',
      address: iperfAddress || 'unavailable', port: 5201,
      detail: iperfReachable ? 'server accepting tests' : iperfUnit === 'active' ? 'service active, port unreachable' : 'service is not running',
    },
    webui: { available: webui, proxyPort: webuiProxyPort },
  }
}

export async function controlModule(module: ModuleName, action: ServiceAction) {
  return run('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', action, managedUnits[module]], 20_000)
}

export async function controlAll(action: ServiceAction) {
  const order: ModuleName[] = action === 'stop' ? ['gnb', 'edgeric', 'open5gs'] : ['open5gs', 'edgeric', 'gnb']
  const results = []
  for (const module of order) {
    const result = await controlModule(module, action)
    results.push({ module, ...result })
    if (!result.ok) break
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  return results
}
