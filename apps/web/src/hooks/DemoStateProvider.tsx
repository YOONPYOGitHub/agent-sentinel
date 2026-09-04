import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AgentSentinelState } from '@agent-sentinel/domain'
import { connectorApi, demoApi, type ConnectorStatus } from '../api'
import { DemoStateContext, type DemoStateValue, type Operation } from './DemoStateContext'
import { useEstate } from './useEstate'

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const { selectedEstateId } = useEstate()
  const [state, setState] = useState<AgentSentinelState>()
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus>()
  const [operation, setOperation] = useState<Operation>('loading')
  const [error, setError] = useState<string>()
  const requestRef = useRef<AbortController | undefined>(undefined)
  const estateIdRef = useRef(selectedEstateId)
  estateIdRef.current = selectedEstateId
  const load = useCallback(async () => {
    const estateId = estateIdRef.current
    requestRef.current?.abort()
    const request = new AbortController()
    requestRef.current = request
    try {
      setError(undefined)
      setOperation('loading')
      const [nextState, status] = await Promise.all([
        demoApi.getState(request.signal),
        connectorApi.getConnectorStatus(request.signal),
      ])
      if (request.signal.aborted || estateId !== estateIdRef.current) return
      setState(nextState)
      setConnectorStatus(status)
    } catch (caught) {
      if (request.signal.aborted || estateId !== estateIdRef.current) return
      setError(caught instanceof Error ? caught.message : 'Agent estate could not be loaded.')
    } finally {
      if (
        !request.signal.aborted &&
        estateId === estateIdRef.current &&
        requestRef.current === request
      ) {
        setOperation(undefined)
      }
    }
  }, [])
  useEffect(() => {
    setState(undefined)
    setConnectorStatus(undefined)
    setError(undefined)
    void load()
    return () => requestRef.current?.abort()
  }, [load, selectedEstateId])
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
