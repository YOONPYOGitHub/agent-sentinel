import { useEffect, useState } from 'react'
import type { DriftAnalysisResult } from '@agent-sentinel/domain'
import { behaviorApi } from '../api/behavior-api'

/**
 * Fetches drift analysis for a single agent.
 * Returns `null` when data is unavailable (live mode, network error, or
 * no windows defined). Never throws — error state silently falls back to null.
 */
export function useAgentDrift(agentId: string): DriftAnalysisResult | null {
  const [drift, setDrift] = useState<DriftAnalysisResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void behaviorApi
      .getDrift(agentId)
      .then((result) => {
        if (!cancelled) setDrift(result)
      })
      .catch(() => {
        if (!cancelled) setDrift(null)
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  return drift
}
