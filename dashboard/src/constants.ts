import type { ModuleName, WindowSize } from './types'

export const moduleLabels: Record<ModuleName, string> = {
  open5gs: 'Open5GS', edgeric: 'EdgeRIC', gnb: 'srsRAN gNB',
}

export const rfLabels: Record<string, string> = {
  device: 'Radio', serial: 'Serial', address: 'UHD address', band: 'Band',
  frequency: 'DL / UL', bandwidth: 'Channel BW', mimo: 'Ports', masterClock: 'Master clock',
  sampleRate: 'Sample rate', clockSource: 'Clock source', timeSource: 'Time source',
  reference: 'Reference', txGain: 'TX gain', rxGain: 'RX gain',
}

export const windowOptions: Array<{ value: WindowSize; label: string }> = [
  { value: '5m', label: '5 minutes' }, { value: '15m', label: '15 minutes' },
  { value: '30m', label: '30 minutes' }, { value: '1h', label: '1 hour' },
]
