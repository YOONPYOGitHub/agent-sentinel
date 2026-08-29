import { describe, expect, it } from 'vitest'

import {
  mapPurviewLabelsToSnapshot,
  mergePurviewSnapshots,
  parsePurviewConfig,
  type PurviewSensitivityLabel,
  type PurviewSourceConfig,
} from '../src/index.js'

const source: PurviewSourceConfig = {
  id: 'tenant-a',
  name: 'Tenant A',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'governance-a',
}
const label: PurviewSensitivityLabel = {
  id: '10000000-0000-0000-0000-000000000001',
  displayName: 'Highly Confidential',
  name: 'HighlyConfidential',
  color: '#cc0000',
  sensitivity: 100,
  priority: 10,
  applicableTo: 'email,site,unifiedGroup,teamwork,file,schematizedData',
  isEnabled: true,
}

describe('Purview sensitivity-label evidence mapping', () => {
  it('uses the provider label id when display metadata is absent', () => {
    const snapshot = mapPurviewLabelsToSnapshot(
      [{ id: '00000000-0000-0000-0000-000000000099' }],
      source,
    )
    expect(snapshot.nodes[0]?.name).toBe('00000000-0000-0000-0000-000000000099')
  })

  it('creates deterministic control evidence with provenance and no correlation edges', () => {
    const first = mapPurviewLabelsToSnapshot([label], source, '2026-08-28T00:00:00Z')
    const repeated = mapPurviewLabelsToSnapshot([label], source, '2026-08-28T01:00:00Z')
    expect(first.nodes[0]?.id).toBe(repeated.nodes[0]?.id)
    expect(first.nodes[0]).toMatchObject({
      kind: 'control',
      name: label.displayName,
      metadata: {
        sourceConnector: 'purview-sensitivity-labels',
        sourceConnectorId: source.id,
        sourceTenantId: source.tenantId,
        sourceEnvironment: source.environment,
        providerLabelId: label.id,
        labelDisplayName: label.displayName,
        labelName: label.name,
        color: label.color,
        sensitivity: '100',
        priority: '10',
        applicableTo: label.applicableTo,
        labelStatus: 'enabled',
        attribution: 'unattributed',
      },
    })
    expect(first.nodes[0]).not.toHaveProperty('trust')
    expect(first.nodes[0]).not.toHaveProperty('owner')
    expect(first.edges).toEqual([])
    expect(first.evidence[0]).toMatchObject({ confidence: 1, freshness: 'live' })
    expect(first.evidence[0]?.summary).toContain('catalog observation only')
  })

  it('never models content, users, activity, usage, agent attribution, trust, or compliance', () => {
    const serialized = JSON.stringify(mapPurviewLabelsToSnapshot([label], source)).toLowerCase()
    for (const forbidden of [
      'filename',
      'fileurl',
      'username',
      'userprincipal',
      'emailaddress',
      'activityid',
      'usagecount',
      'agentid',
      'compliant:true',
      'trusted:true',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('keeps identical provider IDs source-namespaced and rejects duplicates', () => {
    const otherSource = {
      ...source,
      id: 'tenant-b',
      tenantId: '00000000-0000-0000-0000-000000000002',
    }
    const left = mapPurviewLabelsToSnapshot([label], source)
    const right = mapPurviewLabelsToSnapshot([label], otherSource)
    expect(left.nodes[0]?.id).not.toBe(right.nodes[0]?.id)
    expect(
      mergePurviewSnapshots(left, [{ source: otherSource, snapshot: right }]).nodes,
    ).toHaveLength(2)
    expect(() => mapPurviewLabelsToSnapshot([label, label], source)).toThrow(
      'duplicate sensitivity-label identifier',
    )
  })
})

describe('Purview configuration', () => {
  it('supports legacy source settings, fixed Global Graph, and bounded defaults', () => {
    const config = parsePurviewConfig({
      PURVIEW_TENANT_ID: source.tenantId,
      PURVIEW_ENVIRONMENT: source.environment,
    })
    expect(config).toMatchObject({
      graphBaseUrl: 'https://graph.microsoft.com',
      limits: { maxPages: 20, maxItems: 5_000 },
      sources: [
        {
          id: 'primary',
          name: 'Primary Microsoft Purview tenant',
          tenantId: source.tenantId,
          environment: source.environment,
        },
      ],
    })
  })

  it('accepts at most 50 unique tenant sources with only secretless credential modes', () => {
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
      parsePurviewConfig({ PURVIEW_SOURCES_JSON: JSON.stringify(sources) }).sources,
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
      expect(() => parsePurviewConfig({ PURVIEW_SOURCES_JSON: JSON.stringify(sources) })).toThrow()
    }
    expect(() =>
      parsePurviewConfig({
        PURVIEW_SOURCES_JSON: JSON.stringify([base]),
        PURVIEW_MAX_PAGES: '101',
      }),
    ).toThrow()
  })
})
