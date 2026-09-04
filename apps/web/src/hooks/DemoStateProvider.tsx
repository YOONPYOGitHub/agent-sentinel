import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentSentinelState } from '@agent-sentinel/domain'
import { connectorApi, demoApi, type ConnectorStatus } from '../api'
import { DemoStateContext, type DemoStateValue, type Operation } from './DemoStateContext'

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentSentinelState>()
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus>()
  const [operation, setOperation] = useState<Operation>('loading')
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const load = useCallback(async () => {
    const currentRequest = requestId.current + 1
    requestId.current = currentRequest
    try {
      setState(undefined)
      setConnectorStatus(undefined)
      setError(undefined)
      setOperation('loading')
      const [nextState, status] = await Promise.all([
        demoApi.getState(),
        connectorApi.getConnectorStatus(),
      ])
      if (requestId.current !== currentRequest) return
      setState(nextState)
      setConnectorStatus(status)
    } catch (caught) {
      if (requestId.current !== currentRequest) return
      setError(caught instanceof Error ? caught.message : 'Agent estate could not be loaded.')
    } finally {
      if (requestId.current === currentRequest) setOperation(undefined)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => {
      requestId.current += 1
    }
  }, [load])
  const run = useCallback(
    async (
      nextOperation: Exclude<Operation, 'loading' | undefined>,
      action: () => Promise<AgentSentinelState>,
    ) => {
      const currentRequest = requestId.current + 1
      requestId.current = currentRequest
      try {
        setError(undefined)
        setOperation(nextOperation)
        const nextState = await action()
        if (requestId.current === currentRequest) setState(nextState)
      } catch (caught) {
        if (requestId.current !== currentRequest) return
        setError(caught instanceof Error ? caught.message : 'The operation could not be completed.')
      } finally {
        if (requestId.current === currentRequest) setOperation(undefined)
      }
    },
    [],
  )
  const value = useMemo<DemoStateValue>(
    () => ({
      state,
      connectorStatus,
      operation,
      error,
      clearError: () => setError(undefined),
      load,
      run,
    }),
    [connectorStatus, error, load, operation, run, state],
  )
  return <DemoStateContext.Provider value={value}>{children}</DemoStateContext.Provider>
}
