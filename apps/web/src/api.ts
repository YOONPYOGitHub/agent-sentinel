import type { AgentSentinelState } from '@agent-sentinel/domain'

async function request(path: string, init?: RequestInit): Promise<AgentSentinelState> {
  const requestInit: RequestInit = { ...init }
  if (init?.body !== undefined) {
    const headers = new Headers(init.headers)
    headers.set('Content-Type', 'application/json')
    requestInit.headers = headers
  }

  const response = await fetch(path, requestInit)

  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { message?: string } | undefined
    throw new Error(body?.message ?? `Request failed with status ${response.status}.`)
  }

  return (await response.json()) as AgentSentinelState
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
