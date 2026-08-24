import { apiFetch } from './auth-fetch'
import { tokenEconomicsReportSchema, type TokenEconomicsReport } from '@agent-sentinel/domain'

function responseMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  )
    return value.message
  return undefined
}

export const tokenEconomicsApi = {
  async getReport(agentId: string): Promise<TokenEconomicsReport> {
    const response = await apiFetch(`/api/token-economics/agents/${encodeURIComponent(agentId)}`)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return tokenEconomicsReportSchema.parse(body)
  },
}
