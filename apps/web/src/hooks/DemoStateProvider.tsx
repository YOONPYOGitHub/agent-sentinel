import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { AgentSentinelState } from '@agent-sentinel/domain'
import { connectorApi, demoApi, type ConnectorStatus } from '../api'
import { DemoStateContext, type DemoStateValue, type Operation } from './DemoStateContext'

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentSentinelState>()
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus>()
  const [operation, setOperation] = useState<Operation>('loading')
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try {
      setError(undefined)
      setOperation('loading')
      const [nextState, status] = await Promise.all([demoApi.getState(), connectorApi.getConnectorStatus()])
      setState(nextState)
      setConnectorStatus(status)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Agent estate could not be loaded.')
    } finally {
      setOperation(undefined)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const run = useCallback(
    async (
      nextOperation: Exclude<Operation, 'loading' | undefined>,
      action: () => Promise<AgentSentinelState>,
    ) => {
      try {
        setError(undefined)
        setOperation(nextOperation)
        setState(await action())
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'The operation could not be completed.')
      } finally {
        setOperation(undefined)
      }
    },
    [],
  )
  const value = useMemo<DemoStateValue>(
    () => ({ state, connectorStatus, operation, error, clearError: () => setError(undefined), load, run }),
    [connectorStatus, error, load, operation, run, state],
  )
  return <DemoStateContext.Provider value={value}>{children}</DemoStateContext.Provider>
}
