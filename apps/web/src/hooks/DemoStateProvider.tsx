import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { AgentSentinelState } from '@agent-sentinel/domain'
import { demoApi } from '../api'
import { DemoStateContext, type DemoStateValue, type Operation } from './DemoStateContext'

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AgentSentinelState>()
  const [operation, setOperation] = useState<Operation>('loading')
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    try {
      setError(undefined)
      setOperation('loading')
      setState(await demoApi.getState())
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
    () => ({ state, operation, error, clearError: () => setError(undefined), load, run }),
    [error, load, operation, run, state],
  )
  return <DemoStateContext.Provider value={value}>{children}</DemoStateContext.Provider>
}
