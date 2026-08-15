import { DefaultAzureCredential } from '@azure/identity'
import { describe, expect, it } from 'vitest'
import { FoundryAgentConnector } from '../src/index.js'
const endpoint = process.env.FOUNDRY_PROJECT_ENDPOINT
const liveDescribe = endpoint === undefined ? describe.skip : describe
liveDescribe('Foundry live integration', () => {
  it('discovers the six live scenario agents', async () => {
    if (endpoint === undefined) throw new Error('FOUNDRY_PROJECT_ENDPOINT is required.')
    const connector = new FoundryAgentConnector({ projectEndpoint: endpoint, tenantId: process.env.FOUNDRY_TENANT_ID ?? 'live-tenant', environment: process.env.FOUNDRY_ENVIRONMENT ?? 'live' }, new DefaultAzureCredential())
    const snapshot = await connector.discover()
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(6)
    expect(snapshot.evidence.every((item) => item.summary.includes('Declared configuration'))).toBe(true)
  })
})