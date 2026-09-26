import { existsSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  criticalOpen5gsUnits, managedUnits, open5gsUnits, webuiProxyPort,
  type ModuleName, type ServiceAction,
} from '../config.js'
import { loadRfStatus } from './rf-config.js'
import { getSchedulerStatus } from './scheduler.js'
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

export async function getStatus() {
  const iperfAddress = interfaceIpv4('ogstun')
  const iperfPorts = Array.from({ length: 8 }, (_, index) => 5201 + index)
  const [open5gsStates, gnbUnit, collectorUnit, recorderUnit, iperfUnit, manualGnb, manualCollector, remoteControl, webui, iperfReachable, ues, muappRunning] = await Promise.all([
    Promise.all(open5gsUnits.map(async (unit) => [unit, await unitState(unit)] as const)),
    unitState(managedUnits.gnb), unitState(managedUnits.edgeric), unitState('edgeric-metrics-recorder.service'),
    unitState('iperf3.service'), processRunning('/build/apps/gnb/gnb'),
    processRunning('python(3)? .*collector\\.py'), tcpReachable('127.0.0.1', 55555),
    tcpReachable('127.0.0.1', 9999), iperfAddress
      ? Promise.all(iperfPorts.map((targetPort) => tcpReachable(iperfAddress, targetPort)))
      : Promise.resolve(iperfPorts.map(() => false)), latestUeSnapshot(),
    unitState(managedUnits.scheduler),
  ])
  const scheduler = await getSchedulerStatus(muappRunning === 'active')

  const stateMap = Object.fromEntries(open5gsStates)
  const activeCount = open5gsStates.filter(([, state]) => state === 'active').length
  const criticalActive = criticalOpen5gsUnits.every((unit) => stateMap[unit] === 'active')
  const controlsReady = [...Object.values(managedUnits), 'edgeric-metrics-recorder.service']
    .every((unit) => existsSync(`/etc/systemd/system/${unit}`))
  const gnbActive = gnbUnit === 'active' || manualGnb
  const collectorActive = collectorUnit === 'active' || manualCollector
  const recorderActive = recorderUnit === 'active'
  const iperfActiveCount = iperfReachable.filter(Boolean).length
  const rfConfig = loadRfStatus()

  return {
    timestamp: new Date().toISOString(), controlsReady,
    rf: rfConfig,
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
      scheduler: {
        state: muappRunning === 'active' ? 'active' : 'inactive',
        detail: muappRunning === 'active' ? 'eligibility scheduler is running' : 'scheduler muApp is not running',
        managed: muappRunning === 'active',
      },
      gnb: {
        state: gnbActive && remoteControl ? 'active' : gnbActive ? 'degraded' : 'inactive',
        detail: remoteControl ? 'cell running · control :55555' : gnbActive ? 'process running · control unavailable' : 'gNB is not running',
        managed: gnbUnit === 'active',
      },
    },
    ues,
    iperf3: {
      state: iperfUnit === 'active' && iperfActiveCount === iperfPorts.length
        ? 'active' : iperfUnit === 'active' || iperfActiveCount > 0 ? 'degraded' : 'inactive',
      address: iperfAddress || 'unavailable', port: 5201, ports: iperfPorts,
      detail: iperfUnit === 'active'
        ? `${iperfActiveCount}/${iperfPorts.length} servers accepting tests`
        : 'service is not running',
    },
    scheduler,
    webui: { available: webui, proxyPort: webuiProxyPort },
  }
}

export async function controlModule(module: ModuleName, action: ServiceAction) {
  return run('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', action, managedUnits[module]], 20_000)
}

export async function controlAll(action: ServiceAction) {
  const order: ModuleName[] = action === 'stop' ? ['gnb', 'scheduler', 'edgeric', 'open5gs'] : ['open5gs', 'edgeric', 'scheduler', 'gnb']
  const results = []
  for (const module of order) {
    const result = await controlModule(module, action)
    results.push({ module, ...result })
    if (!result.ok) break
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  return results
}
