import { useEffect, useState } from 'react'
import type { ExposureFinding } from '@agent-sentinel/domain'
import { exposureApi } from '../api/exposure-api'
import type { ExposureLoadState } from '../scorecard'
import { useEstate } from './useEstate'

/**
 * Fetches all exposure findings once. Pass a resetKey (e.g. agentId) to
 * reset to 'loading' and discard any in-flight request when the key changes.
 */
export function useExposures(resetKey?: string): ExposureFinding[] | ExposureLoadState {
  const { selectedEstateId } = useEstate()
  const [state, setState] = useState<ExposureFinding[] | ExposureLoadState>('loading')

  useEffect(() => {
    setState('loading')
    let cancelled = false
    void Promise.all([
      exposureApi.listAll({ status: 'open' }),
      exposureApi.listAll({ status: 'validated' }),
    ])
      .then(([open, validated]) => {
        if (!cancelled) {
          setState([
            ...new Map([...open, ...validated].map((finding) => [finding.id, finding])).values(),
          ])
        }
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [resetKey, selectedEstateId])

  return state
}
