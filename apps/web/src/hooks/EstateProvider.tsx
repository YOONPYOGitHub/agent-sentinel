import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { EstateApiError, estateApi, type AuthorizedEstate } from '../api/estate-api'
import { setActiveEstateId } from '../api/auth-fetch'
import { EstateContext, type EstateContextValue, type EstateState } from './EstateContext'
import { clearAgentDriftCache } from './useAgentDrift'

export const ESTATE_STORAGE_KEY = 'agent-sentinel.estate-id'

function activateEstate(estateId: string | undefined): void {
  clearAgentDriftCache()
  setActiveEstateId(estateId)
}

function initialEstate(
  estates: readonly AuthorizedEstate[],
  defaultEstateId: string,
): AuthorizedEstate | undefined {
  const storedId = localStorage.getItem(ESTATE_STORAGE_KEY)
  const stored = storedId === null ? undefined : estates.find((estate) => estate.id === storedId)
  if (stored !== undefined) return stored
  if (storedId !== null) localStorage.removeItem(ESTATE_STORAGE_KEY)
  return estates.find((estate) => estate.id === defaultEstateId) ?? estates[0]
}

function failureState(error: unknown): EstateState {
  if (error instanceof EstateApiError) return { status: error.kind, message: error.message }
  return {
    status: 'unavailable',
    message: error instanceof Error ? error.message : 'Authorized estates could not be loaded.',
  }
}

export function EstateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EstateState>({ status: 'loading' })
  const loadId = useRef(0)
  const loadController = useRef<AbortController | null>(null)

  const reload = useCallback(async () => {
    const currentLoad = loadId.current + 1
    loadId.current = currentLoad
    loadController.current?.abort()
    const controller = new AbortController()
    loadController.current = controller
    activateEstate(undefined)
    setState({ status: 'loading' })
    try {
      const response = await estateApi.list(controller.signal)
      if (controller.signal.aborted || loadId.current !== currentLoad) return
      const selectedEstate = initialEstate(response.estates, response.defaultEstateId)
      if (selectedEstate === undefined) {
        localStorage.removeItem(ESTATE_STORAGE_KEY)
        setState({ status: 'empty' })
        return
      }
      localStorage.setItem(ESTATE_STORAGE_KEY, selectedEstate.id)
      activateEstate(selectedEstate.id)
      setState({ status: 'ready', estates: response.estates, selectedEstate })
    } catch (error: unknown) {
      if (controller.signal.aborted || loadId.current !== currentLoad) return
      localStorage.removeItem(ESTATE_STORAGE_KEY)
      setState(failureState(error))
    }
  }, [])

  useEffect(() => {
    void reload()
    return () => {
      loadId.current += 1
      loadController.current?.abort()
      activateEstate(undefined)
    }
  }, [reload])

  const selectEstate = useCallback(
    (estateId: string) => {
      if (state.status !== 'ready') throw new Error('No estate is available to select.')
      const selectedEstate = state.estates.find((estate) => estate.id === estateId)
      if (selectedEstate === undefined) throw new Error('The selected estate is not authorized.')
      if (selectedEstate.id === state.selectedEstate.id) return
      localStorage.setItem(ESTATE_STORAGE_KEY, selectedEstate.id)
      activateEstate(selectedEstate.id)
      setState({ ...state, selectedEstate })
    },
    [state],
  )

  const value = useMemo<EstateContextValue>(
    () => ({ state, reload, selectEstate }),
    [reload, selectEstate, state],
  )

  return (
    <EstateContext.Provider value={value}>
      {state.status === 'ready' ? (
        <EstateBoundary key={state.selectedEstate.id}>{children}</EstateBoundary>
      ) : (
        children
      )}
    </EstateContext.Provider>
  )
}

function EstateBoundary({ children }: { children: ReactNode }) {
  return children
}
