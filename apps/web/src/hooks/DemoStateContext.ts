import { createContext } from 'react'
import type { AgentSentinelState } from '@agent-sentinel/domain'
import type { ConnectorStatus } from '../api'
export type Operation =
  'loading' | 'validating' | 'proposing' | 'approving' | 'executing' | 'resetting' | undefined
export interface DemoStateValue {
  state: AgentSentinelState | undefined
  connectorStatus: ConnectorStatus | undefined
  operation: Operation
  error: string | undefined
  clearError: () => void
  load: () => Promise<void>
  run: (
    operation: Exclude<Operation, 'loading' | undefined>,
    action: () => Promise<AgentSentinelState>,
  ) => Promise<void>
}
export const DemoStateContext = createContext<DemoStateValue | undefined>(undefined)
