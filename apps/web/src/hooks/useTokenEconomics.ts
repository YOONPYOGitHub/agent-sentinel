import { useEffect, useState } from 'react'
import type { TokenEconomicsReport } from '@agent-sentinel/domain'
import { tokenEconomicsApi } from '../api/token-economics-api'

type TokenEconomicsState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; report: TokenEconomicsReport }

/**
 * Fetches the token economics report for a single agent.
 * Falls back to error state on network failure; never throws.
 */
export function useTokenEconomics(agentId: string): TokenEconomicsState {
  const [state, setState] = useState<TokenEconomicsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void tokenEconomicsApi
      .getReport(agentId)
      .then((report) => {
        if (!cancelled) setState({ status: 'done', report })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Token economics data could not be loaded.',
          })
      })
    return () => {
      cancelled = true
    }
  }, [agentId])

  return state
}
