import { windowOptions } from '../constants'
import type { WindowSize } from '../types'

export function WindowSelect({ value, onChange, label = 'History' }: { value: WindowSize; onChange: (value: WindowSize) => void; label?: string }) {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value as WindowSize)}>{windowOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
}
