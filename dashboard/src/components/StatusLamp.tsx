import type { ModuleState } from '../types'

export function StatusLamp({ state }: { state: ModuleState }) {
  return <span className={`status-lamp status-${state}`} aria-hidden="true" />
}
