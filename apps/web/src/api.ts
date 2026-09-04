import { apiFetch } from './api/auth-fetch'
import { agentSentinelStateSchema, type AgentSentinelState } from '@agent-sentinel/domain'
import { z } from 'zod'

const connectorStatusSchema = z.strictObject({
  source: z.enum(['mock', 'foundry']),
  connectorId: z.string().min(1),
  mode: z.enum(['mock', 'foundry']),
  projectEndpoint: z.url().optional(),
  writeEnabled: z.boolean().optional().default(true),
})

export type ConnectorStatus = z.input<typeof connectorStatusSchema>
export type WriteCapability = Pick<ConnectorStatus, 'writeEnabled'>

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

async function request(path: string, init?: RequestInit): Promise<AgentSentinelState> {
  const requestInit: RequestInit = { ...init }
  if (init?.body !== undefined) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    requestInit.headers = headers
  }
  const response = await apiFetch(path, requestInit)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
  }
  return agentSentinelStateSchema.parse(body)
}

export const demoApi = {
  getState: (signal?: AbortSignal) =>
    request('/api/demo/state', signal === undefined ? undefined : { signal }),
  reset: () => request('/api/demo/reset', { method: 'POST' }),
  validateFinding: (findingId: string) =>
    request(`/api/demo/findings/${findingId}/validate`, { method: 'POST' }),
  proposeRemediation: (findingId: string) =>
    request(`/api/demo/findings/${findingId}/remediations`, { method: 'POST' }),
  approveRemediation: (remediationId: string, approvedBy: string, reason: string) =>
    request(`/api/demo/remediations/${remediationId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvedBy, reason }),
    }),
  executeRemediation: (remediationId: string) =>
    request(`/api/demo/remediations/${remediationId}/execute`, { method: 'POST' }),
}

export const connectorApi = {
  getConnectorStatus: async (signal?: AbortSignal): Promise<ConnectorStatus> => {
    const response = await apiFetch(
      '/api/connector/status',
      signal === undefined ? undefined : { signal },
    )
    const body: unknown = await response.json()
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return connectorStatusSchema.parse(body)
  },
}
