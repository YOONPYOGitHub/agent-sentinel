import { describe, expect, it } from 'vitest'

import {
  mapTeamsDistributionAppsToSnapshot,
  mergeTeamsDistributionSnapshots,
  parseTeamsDistributionConfig,
  type TeamsApp,
  type TeamsDistributionSourceConfig,
} from '../src/index.js'

const source: TeamsDistributionSourceConfig = {
  id: 'tenant-a',
  name: 'Tenant A',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'catalog-a',
}
const app: TeamsApp = {
  id: '10000000-0000-0000-0000-000000000001',
  externalId: '20000000-0000-0000-0000-000000000001',
  displayName: 'Contoso catalog app',
  distributionMethod: 'organization',
}

describe('Teams tenant app catalog evidence mapping', () => {
  it('creates deterministic control evidence with direct provenance and no edges', () => {
    const first = mapTeamsDistributionAppsToSnapshot([app], source, '2026-08-29T00:00:00Z')
    const repeated = mapTeamsDistributionAppsToSnapshot([app], source, '2026-08-29T01:00:00Z')
    expect(first.nodes[0]?.id).toBe(repeated.nodes[0]?.id)
    expect(first.nodes[0]).toMatchObject({
      kind: 'control',
      name: app.displayName,
      metadata: {
        sourceConnector: 'teams-distribution-catalog',
        sourceConnectorId: source.id,
        sourceTenantId: source.tenantId,
        sourceEnvironment: source.environment,
        providerTeamsAppId: app.id,
        appDisplayName: app.displayName,
        externalId: app.externalId,
        distributionMethod: 'organization',
        observationType: 'tenant-teams-app-catalog',
        attribution: 'unattributed',
      },
    })
    expect(first.nodes[0]?.description).toContain('does not prove an agent')
    expect(first.nodes[0]).not.toHaveProperty('trust')
    expect(first.nodes[0]).not.toHaveProperty('owner')
    expect(first.edges).toEqual([])
    expect(first.evidence[0]).toMatchObject({ confidence: 1, freshness: 'live' })
    expect(first.evidence[0]?.summary).toContain('observation only')
  })

  it('does not retain or infer personal, package-content, installation, or deployment fields', () => {
    const snapshot = mapTeamsDistributionAppsToSnapshot([app], source)
    expect(snapshot.nodes.every((node) => node.kind === 'control')).toBe(true)
    expect(snapshot.edges).toEqual([])
    const serialized = JSON.stringify(snapshot).toLowerCase()
    for (const forbidden of [
      'userprincipalname',
      'emailaddress',
      'teamid',
      'chatid',
      'groupid',
      'installedfor',
      'manifest',
      'iconurl',
      'fileurl',
      'publishingstate',
      'version',
      'trusted:true',
      'deployed:true',
      'installed:true',
      'entitled:true',
      'hasaccess:true',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('uses the provider id when display metadata is absent', () => {
    const withoutName: TeamsApp = {
      id: '10000000-0000-0000-0000-000000000099',
      distributionMethod: 'organization',
    }
    expect(mapTeamsDistributionAppsToSnapshot([withoutName], source).nodes[0]?.name).toBe(
      withoutName.id,
    )
  })

  it('keeps equal provider IDs source-namespaced and rejects duplicates', () => {
    const otherSource = {
      ...source,
      id: 'tenant-b',
      tenantId: '00000000-0000-0000-0000-000000000002',
    }
    const left = mapTeamsDistributionAppsToSnapshot([app], source)
    const right = mapTeamsDistributionAppsToSnapshot([app], otherSource)
    expect(left.nodes[0]?.id).not.toBe(right.nodes[0]?.id)
    expect(
      mergeTeamsDistributionSnapshots(left, [{ source: otherSource, snapshot: right }]).nodes,
    ).toHaveLength(2)
    expect(() => mapTeamsDistributionAppsToSnapshot([app, app], source)).toThrow(
      'duplicate Teams app identifier',
    )
  })
})

describe('Teams distribution configuration', () => {
  it('supports legacy source settings, fixed Global Graph, and bounded defaults', () => {
    const config = parseTeamsDistributionConfig({
      TEAMS_DISTRIBUTION_TENANT_ID: source.tenantId,
      TEAMS_DISTRIBUTION_ENVIRONMENT: source.environment,
    })
    expect(config).toMatchObject({
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: { maxPages: 20, maxItems: 5_000 },
      sources: [
        {
          id: 'primary',
          name: 'Primary Microsoft Teams tenant app catalog',
          tenantId: source.tenantId,
          environment: source.environment,
        },
      ],
    })
  })

  it('accepts at most 50 unique tenant sources with only secretless credentials', () => {
    const sources = Array.from({ length: 50 }, (_, index) => ({
      id: `source-${index}`,
      name: `Source ${index}`,
      tenantId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      environment: `environment-${index}`,
      credential: {
        mode: 'federated-app' as const,
        clientId: '00000000-0000-0000-0000-000000000000',
        managedIdentityClientId: '11111111-1111-1111-1111-111111111111',
      },
    }))
    expect(
      parseTeamsDistributionConfig({
        TEAMS_DISTRIBUTION_SOURCES_JSON: JSON.stringify(sources),
      }).sources,
    ).toHaveLength(50)
  })

  it('rejects duplicate tenants/ids, secrets, excessive sources, and invalid limits', () => {
    const base = {
      id: source.id,
      name: source.name,
      tenantId: source.tenantId,
      environment: source.environment,
    }
    for (const sources of [
      [base, { ...base, tenantId: '00000000-0000-0000-0000-000000000002' }],
      [base, { ...base, id: 'tenant-b', environment: 'other' }],
      [{ ...base, clientSecret: 'not-supported' }],
      Array.from({ length: 51 }, (_, index) => ({
        ...base,
        id: `source-${index}`,
        tenantId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      })),
    ]) {
      expect(() =>
        parseTeamsDistributionConfig({
          TEAMS_DISTRIBUTION_SOURCES_JSON: JSON.stringify(sources),
        }),
      ).toThrow()
    }
    expect(() =>
      parseTeamsDistributionConfig({
        TEAMS_DISTRIBUTION_SOURCES_JSON: JSON.stringify([base]),
        TEAMS_DISTRIBUTION_MAX_PAGES: '101',
      }),
    ).toThrow()
  })
})
