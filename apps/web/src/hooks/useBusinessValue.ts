import { useEffect, useState } from 'react'

import type { BusinessValueAssessment } from '@agent-sentinel/domain'

import { businessValueApi } from '../api/business-value-api'
import { useEstate } from './useEstate'

export type BusinessValueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; assessment: BusinessValueAssessment }

export function useBusinessValue(agentId: string): BusinessValueState {
  const { selectedEstateId } = useEstate()
  const [state, setState] = useState<BusinessValueState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void businessValueApi
      .getAssessment(agentId)
      .then((assessment) => {
        if (!cancelled) setState({ status: 'done', assessment })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Business outcome evidence could not be loaded.',
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentId, selectedEstateId])

  return state
}
