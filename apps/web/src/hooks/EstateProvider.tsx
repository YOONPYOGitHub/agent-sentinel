import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { estateIdSchema } from '@agent-sentinel/domain'

import { estateApi, type AuthorizedEstate } from '../api/estate-api'
import { setEstateIdProvider } from '../api/auth-fetch'
import { EstateContext } from './EstateContext'

const storageKey = 'agent-sentinel.selected-estate-id'

function storedEstateId(): string | undefined {
  const parsed = estateIdSchema.safeParse(window.localStorage.getItem(storageKey))
  return parsed.success ? parsed.data : undefined
}

function selectInitialEstate(
  estates: readonly AuthorizedEstate[],
  defaultEstateId: string,
): string | undefined {
  const stored = storedEstateId()
  if (stored !== undefined && estates.some((estate) => estate.id === stored)) return stored
  if (estates.some((estate) => estate.id === defaultEstateId)) return defaultEstateId
  return estates[0]?.id
}

export function EstateProvider({ children }: { children: ReactNode }) {
  const [estates, setEstates] = useState<readonly AuthorizedEstate[]>([])
  const [selectedEstateId, setSelectedEstateId] = useState<string>()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    void estateApi
      .listAuthorized()
      .then(({ estates: authorized, defaultEstateId }) => {
        if (cancelled) return
        setEstates(authorized)
        setSelectedEstateId(selectInitialEstate(authorized, defaultEstateId))
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : 'Authorized estates could not be loaded.',
          )
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setEstateIdProvider(selectedEstateId === undefined ? undefined : () => selectedEstateId)
    return () => setEstateIdProvider(undefined)
  }, [selectedEstateId])

  const selectEstate = useCallback(
    (estateId: string) => {
      if (!estates.some((estate) => estate.id === estateId)) return
      setSelectedEstateId(estateId)
      window.localStorage.setItem(storageKey, estateId)
    },
    [estates],
  )

  const value = useMemo(
    () => ({ estates, selectedEstateId, isLoading, error, selectEstate }),
    [error, estates, isLoading, selectEstate, selectedEstateId],
  )
  return <EstateContext.Provider value={value}>{children}</EstateContext.Provider>
}
