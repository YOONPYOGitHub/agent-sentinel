import { apiFetch } from './auth-fetch'
import { driftAnalysisResultSchema, type DriftAnalysisResult } from '@agent-sentinel/domain'

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

export const behaviorApi = {
  async getDrift(agentId: string, signal?: AbortSignal): Promise<DriftAnalysisResult> {
    const path = `/api/behavior/agents/${encodeURIComponent(agentId)}/drift`
    const response = await (signal === undefined ? apiFetch(path) : apiFetch(path, { signal }))
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return driftAnalysisResultSchema.parse(body)
  },
}
