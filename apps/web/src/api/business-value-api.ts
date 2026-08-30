import { businessValueAssessmentSchema, type BusinessValueAssessment } from '@agent-sentinel/domain'

import { apiFetch } from './auth-fetch'

function responseMessage(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
    ? value.message
    : undefined
}

export const businessValueApi = {
  async getAssessment(agentId: string): Promise<BusinessValueAssessment> {
    const response = await apiFetch(`/api/business-value/agents/${encodeURIComponent(agentId)}`)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return businessValueAssessmentSchema.parse(body)
  },
}
