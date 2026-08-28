import { describe, expect, it } from 'vitest'

import {
  mapPowerPlatformAgentsToSnapshot,
  mergePowerPlatformSnapshots,
  powerPlatformResourceItemSchema,
  powerPlatformSourceConfigSchema,
} from '../src/index.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const source = powerPlatformSourceConfigSchema.parse({
  id: 'studio',
  name: 'Copilot Studio',
  tenantId,
  environment: 'environment-a',
})
const resource = powerPlatformResourceItemSchema.parse({
  name: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  type: 'microsoft.copilotstudio/agents',
  tenantId,
  location: 'unitedstates',
  environmentId: 'environment-a',
  environmentName: 'Production',
  properties: {
    displayName: 'Service Agent',
    name: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    environmentId: 'environment-a',
    createdAt: '2026-08-20T01:02:03Z',
    createdBy: 'maker-1',
    ownerId: 'owner-1',
    lastPublishedAt: null,
    createdIn: 'Copilot Studio',
    schemaName: 'contoso_service_agent',
    entraAppId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    entraAgentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    entraAgentBlueprintId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    previewOnlyField: { ignored: true },
  },
})

describe('Power Platform normalization', () => {
  it('maps authoritative inventory with complete provenance and identity metadata', () => {
    const snapshot = mapPowerPlatformAgentsToSnapshot([resource], source, '2026-08-28T00:00:00Z')
    expect(snapshot).toMatchObject({
      tenantId,
      environment: 'environment-a',
      edges: [],
      nodes: [
        {
          kind: 'agent',
          name: 'Service Agent',
          environment: 'environment-a',
          metadata: {
            sourceConnector: 'power-platform',
            sourceConnectorId: 'studio',
            sourceConnectorName: 'Copilot Studio',
            sourceTenantId: tenantId,
            sourceEnvironment: 'environment-a',
            sourceEnvironmentId: 'environment-a',
            sourceProviderType: 'microsoft.copilotstudio/agents',
            sourceProviderObjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            entraAppId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            entraAgentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entraAgentIdentityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            entraAgentBlueprintId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          },
        },
      ],
      evidence: [
        {
          confidence: 1,
          freshness: 'live',
          sourceObjectId: 'studio:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        },
      ],
    })
    expect(snapshot.nodes[0]).not.toHaveProperty('trust')
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes.some((node) => node.kind === 'tool')).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('previewOnlyField')
  })

  it('generates deterministic namespaced IDs and isolates identical provider IDs by source', () => {
    const first = mapPowerPlatformAgentsToSnapshot([resource], source, '2026-08-28T00:00:00Z')
    const second = mapPowerPlatformAgentsToSnapshot([resource], source, '2026-08-29T00:00:00Z')
    const otherResource = powerPlatformResourceItemSchema.parse({
      ...resource,
      environmentId: 'environment-b',
      properties: { ...resource.properties, environmentId: 'environment-b' },
    })
    const other = mapPowerPlatformAgentsToSnapshot(
      [otherResource],
      { ...source, id: 'builder', name: 'Agent Builder', environment: 'environment-b' },
      '2026-08-28T00:00:00Z',
    )
    expect(first.nodes[0]!.id).toBe(second.nodes[0]!.id)
    expect(first.evidence[0]!.id).toBe(second.evidence[0]!.id)
    expect(other.nodes[0]!.id).not.toBe(first.nodes[0]!.id)
  })

  it('preserves the exact aggregate estate boundary and rejects a source mismatch', () => {
    const addition = mapPowerPlatformAgentsToSnapshot([resource], source, '2026-08-28T00:00:00Z')
    const base = {
      tenantId: 'estate-tenant',
      environment: 'portfolio',
      generatedAt: '2026-08-27T00:00:00Z',
      nodes: [],
      edges: [],
      evidence: [],
    }
    expect(mergePowerPlatformSnapshots(base, [{ source, snapshot: addition }])).toMatchObject({
      tenantId: 'estate-tenant',
      environment: 'portfolio',
      nodes: addition.nodes,
    })
    expect(() =>
      mergePowerPlatformSnapshots(base, [
        { source: { ...source, environment: 'wrong' }, snapshot: addition },
      ]),
    ).toThrow('environment boundary')
  })
})
