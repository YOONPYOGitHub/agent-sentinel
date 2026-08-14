import { agentSentinelStateSchema, type AgentSentinelState } from '@agent-sentinel/domain'

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
  const response = await fetch(path, requestInit)
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
  }
  return agentSentinelStateSchema.parse(body)
}

export const demoApi = {
  getState: () => request('/api/demo/state'),
  reset: () => request('/api/demo/reset', { method: 'POST' }),
  validateFinding: (findingId: string) =>
    request(`/api/demo/findings/${findingId}/validate`, { method: 'POST' }),
  proposeRemediation: (findingId: string) =>
    request(`/api/demo/findings/${findingId}/remediations`, { method: 'POST' }),
  approveRemediation: (remediationId: string, approvedBy: string) =>
    request(`/api/demo/remediations/${remediationId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvedBy }),
    }),
  executeRemediation: (remediationId: string) =>
    request(`/api/demo/remediations/${remediationId}/execute`, { method: 'POST' }),
}
