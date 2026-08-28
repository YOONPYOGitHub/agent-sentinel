import { describe, expect, it } from 'vitest'

import {
  mapDefenderCloudAppsCollectionToSnapshot,
  mergeDefenderCloudAppsSnapshots,
  parseDefenderCloudAppsConfig,
  type DefenderCloudAppsCollection,
  type DefenderCloudAppsSourceConfig,
} from '../src/index.js'

const source: DefenderCloudAppsSourceConfig = {
  id: 'tenant-a',
  name: 'Tenant A',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'security-production',
  apiBaseUrl: 'https://contoso.us2.portal.cloudappsecurity.com',
}
const collection: DefenderCloudAppsCollection = {
  observedAt: '2026-08-28T08:00:00.000Z',
  alerts: [
    {
      id: 'alert-shared',
      timestamp: Date.parse('2026-08-28T07:00:00Z'),
      severityValue: 2,
      statusValue: 1,
      resolutionStatusValue: 0,
      stories: [0, 7],
      intent: [2, 9],
      serviceId: '20940',
      policyId: 'policy-a',
      policyType: 'ANOMALY_DETECTION',
    },
  ],
  activities: [
    {
      id: 'activity-shared',
      timestamp: Date.parse('2026-08-28T07:30:00Z'),
      actionType: 'Login',
      eventActionType: 'SignIn',
      takenAction: 'block',
      administrative: false,
      serviceId: '20893',
      policyId: 'policy-b',
    },
  ],
}

describe('Defender for Cloud Apps evidence mapping', () => {
  it('models unattributed control evidence with deterministic source-namespaced ids and no edges', () => {
    const first = mapDefenderCloudAppsCollectionToSnapshot(collection, source)
    const repeated = mapDefenderCloudAppsCollectionToSnapshot(
      { ...collection, observedAt: '2026-08-28T09:00:00.000Z' },
      source,
    )
    expect(first.nodes).toHaveLength(2)
    expect(first.nodes.map((node) => node.kind)).toEqual(['control', 'control'])
    expect(first.nodes.map((node) => node.id)).toEqual(repeated.nodes.map((node) => node.id))
    expect(first.edges).toEqual([])
    for (const node of first.nodes) {
      expect(node.evidenceIds).toHaveLength(1)
      expect(node.metadata).toMatchObject({
        sourceConnector: 'defender-for-cloud-apps',
        sourceConnectorId: source.id,
        sourceTenantId: source.tenantId,
        sourceEnvironment: source.environment,
        sourceApiBaseUrl: source.apiBaseUrl,
        attribution: 'unattributed',
      })
      expect(node).not.toHaveProperty('trust')
      expect(node).not.toHaveProperty('owner')
    }
    for (const evidence of first.evidence) {
      expect(evidence).toMatchObject({ confidence: 1, freshness: 'live' })
      expect(evidence.summary).toContain('unattributed')
      expect(evidence.summary).toContain('does not indicate agent attribution')
    }
  })

  it('persists only approved non-personal fields and cannot leak forbidden provider content', () => {
    const snapshot = mapDefenderCloudAppsCollectionToSnapshot(collection, source)
    const serialized = JSON.stringify(snapshot).toLowerCase()
    for (const forbidden of [
      'narrative',
      'username',
      'upn',
      'email',
      'ipaddress',
      'location',
      'deviceid',
      'sessionid',
      'filename',
      'fileurl',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(snapshot.nodes[0]?.metadata).toMatchObject({
      severity: 'high',
      readStatus: 'read',
      resolutionStatus: 'open',
      categories: '[0,7]',
      serviceId: '20940',
      policyId: 'policy-a',
      policyType: 'ANOMALY_DETECTION',
    })
    expect(snapshot.nodes[1]?.metadata).toMatchObject({
      actionType: 'Login',
      eventActionType: 'SignIn',
      takenAction: 'block',
      serviceId: '20893',
      policyId: 'policy-b',
    })
  })

  it('keeps identical provider ids collision-resistant across tenants and merges safely', () => {
    const otherSource = {
      ...source,
      id: 'tenant-b',
      tenantId: '00000000-0000-0000-0000-000000000002',
      apiBaseUrl: 'https://fabrikam.eu1.portal.cloudappsecurity.com',
    }
    const left = mapDefenderCloudAppsCollectionToSnapshot(collection, source)
    const right = mapDefenderCloudAppsCollectionToSnapshot(collection, otherSource)
    expect(left.nodes[0]?.id).not.toBe(right.nodes[0]?.id)
    const merged = mergeDefenderCloudAppsSnapshots(left, [{ source: otherSource, snapshot: right }])
    expect(new Set(merged.nodes.map((node) => node.id)).size).toBe(4)
  })
})

describe('Defender for Cloud Apps configuration', () => {
  it('supports bounded legacy settings and the conservative 24-hour default', () => {
    const config = parseDefenderCloudAppsConfig({
      DEFENDER_CLOUD_APPS_TENANT_ID: source.tenantId,
      DEFENDER_CLOUD_APPS_ENVIRONMENT: source.environment,
      DEFENDER_CLOUD_APPS_API_BASE_URL: `${source.apiBaseUrl}/`,
    })
    expect(config.sources).toEqual([
      {
        id: 'primary',
        name: 'Primary Microsoft Defender for Cloud Apps tenant',
        tenantId: source.tenantId,
        environment: source.environment,
        apiBaseUrl: source.apiBaseUrl,
      },
    ])
    expect(config.limits).toMatchObject({ lookbackHours: 24, pageSize: 100, maxItems: 4_000 })
  })

  it('accepts up to 50 unique secretless tenant sources with local environment labels', () => {
    const sources = Array.from({ length: 50 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      tenantId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      environment: `local-label-${index}`,
      portalHostname: `tenant-${index}.us${index}.portal.cloudappsecurity.com`,
      credential: {
        mode: 'federated-app' as const,
        clientId: '00000000-0000-0000-0000-000000000000',
        managedIdentityClientId: '11111111-1111-1111-1111-111111111111',
      },
    }))
    expect(
      parseDefenderCloudAppsConfig({
        DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify(sources),
      }).sources,
    ).toHaveLength(50)
  })

  it('rejects duplicate tenants, ids, portals, secret fields, excessive sources, and invalid bounds', () => {
    const base = {
      id: source.id,
      name: source.name,
      tenantId: source.tenantId,
      environment: source.environment,
      apiBaseUrl: source.apiBaseUrl,
    }
    for (const sources of [
      [base, { ...base, tenantId: '00000000-0000-0000-0000-000000000002' }],
      [
        base,
        {
          ...base,
          id: 'tenant-b',
          apiBaseUrl: 'https://other.us2.portal.cloudappsecurity.com',
        },
      ],
      [
        base,
        {
          ...base,
          id: 'tenant-b',
          tenantId: '00000000-0000-0000-0000-000000000002',
        },
      ],
      [{ ...base, clientSecret: 'must-not-be-supported' }],
      Array.from({ length: 51 }, (_, index) => ({
        ...base,
        id: `source-${index}`,
        tenantId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
        apiBaseUrl: `https://tenant-${index}.us2.portal.cloudappsecurity.com`,
      })),
    ]) {
      expect(() =>
        parseDefenderCloudAppsConfig({
          DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify(sources),
        }),
      ).toThrow()
    }
    expect(() =>
      parseDefenderCloudAppsConfig({
        DEFENDER_CLOUD_APPS_SOURCES_JSON: JSON.stringify([base]),
        DEFENDER_CLOUD_APPS_PAGE_SIZE: '101',
      }),
    ).toThrow()
  })
})
