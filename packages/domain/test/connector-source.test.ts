import { describe, expect, it } from 'vitest'

import {
  connectorSourceDefinitionSchema,
  connectorSourceTestResultSchema,
  redactConnectorSourceForApi,
} from '../src/index.js'

describe('connectorSourceDefinitionSchema', () => {
  it('rejects URLs, secrets, and unknown fields', () => {
    const result = connectorSourceDefinitionSchema.safeParse({
      id: 'azure-graph-primary',
      estateId: 'default',
      tenantId: 'tenant-demo',
      environment: 'demo',
      connectorType: 'azure-resource-graph',
      displayName: 'https://example.com',
      enabled: true,
      origin: 'user',
      config: { kind: 'azure-resource-graph', subscriptionId: 'sub-123', resourceGroup: 'rg-1' },
      credential: { mode: 'managed-identity', identityName: 'agent-sentinel-mi' },
      version: 1,
      etag: 'etag-1',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      actor: { type: 'user', id: 'alice' },
      status: 'ready',
      lastTest: {
        status: 'passed',
        checkedAt: '2026-08-27T00:00:00.000Z',
        evidence: 'live',
        reasonCode: 'success',
        message: 'Validated',
      },
      auditHistory: [],
      extra: 'bad',
    })

    expect(result.success).toBe(false)
  })

  it('requires a passing live test before ready status is valid', () => {
    const result = connectorSourceDefinitionSchema.safeParse({
      id: 'azure-graph-primary',
      estateId: 'default',
      tenantId: 'tenant-demo',
      environment: 'demo',
      connectorType: 'azure-resource-graph',
      displayName: 'Primary graph source',
      enabled: true,
      origin: 'deployment',
      config: { kind: 'azure-resource-graph', subscriptionId: 'sub-123' },
      credential: { mode: 'managed-identity', identityName: 'agent-sentinel-mi' },
      version: 1,
      etag: 'etag-1',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      actor: { type: 'deployment', id: 'deployment-agent-sentinel' },
      status: 'ready',
      lastTest: {
        status: 'failed',
        checkedAt: '2026-08-27T00:00:00.000Z',
        evidence: 'none',
        reasonCode: 'failed',
        message: 'Connectivity failed',
      },
      auditHistory: [],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('status'))).toBe(true)
    }
  })

  it('redacts secret markers from API-safe payloads', () => {
    const source = connectorSourceDefinitionSchema.parse({
      id: 'source-1',
      estateId: 'default',
      tenantId: 'tenant-demo',
      environment: 'demo',
      connectorType: 'foundry',
      displayName: 'Foundry source',
      enabled: true,
      origin: 'user',
      config: { kind: 'foundry', projectName: 'agent-project', deploymentName: 'prod' },
      credential: { mode: 'key-vault-reference', vaultName: 'vault-demo', secretName: 'source-secret' },
      version: 2,
      etag: 'etag-2',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      actor: { type: 'user', id: 'alice-user' },
      status: 'ready',
      lastTest: {
        status: 'passed',
        checkedAt: '2026-08-28T00:00:00.000Z',
        evidence: 'live',
        reasonCode: 'success',
        message: 'Validated live',
      },
      auditHistory: [],
    })

    const redacted = redactConnectorSourceForApi({
      ...source,
      credential: { mode: 'key-vault-reference', vaultName: 'vault-demo', secretName: 'source-secret', secretValue: 'top-secret' } as never,
    })
    expect(redacted.credential).toMatchObject({
      mode: 'key-vault-reference',
      vaultName: 'vault-demo',
      secretName: 'source-secret',
    })
    expect(JSON.stringify(redacted)).not.toContain('top-secret')
  })
})

describe('connectorSourceTestResultSchema', () => {
  it('accepts only evidence-backed success states for live validation', () => {
    expect(
      connectorSourceTestResultSchema.parse({
        status: 'passed',
        checkedAt: '2026-08-27T00:00:00.000Z',
        evidence: 'live',
        reasonCode: 'success',
        message: 'Connection succeeded',
      }),
    ).toMatchObject({ evidence: 'live', status: 'passed' })
  })
})
