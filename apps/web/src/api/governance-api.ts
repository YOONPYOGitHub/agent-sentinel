import { apiFetch } from './auth-fetch'
import { governancePostureSchema, type GovernancePosture } from '@agent-sentinel/domain'

function responseMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  ) {
    return value.message
  }
  return undefined
}

export const governanceApi = {
  async getPosture(): Promise<GovernancePosture> {
    const response = await apiFetch('/api/governance/posture')
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return governancePostureSchema.parse(body)
  },
}
