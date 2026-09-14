import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const jose = vi.hoisted(() => ({
  createRemoteJWKSet: vi.fn(() => ({ mocked: 'jwks' })),
  jwtVerify: vi.fn(),
}))

vi.mock('jose', () => jose)

import { MockAgentConnector } from '@agent-sentinel/mock-connector'
import type {
  EmployeeEntitlementEvidence,
  EstateContext,
  EstateSnapshot,
} from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'
import type { AuthConfig } from '../src/auth.js'
import { DemoService } from '../src/demo-service.js'
import { resolveEmployeeAgentCatalog } from '../src/employee-catalog-routes.js'
import { buildEstateRegistry } from '../src/estate-config.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const employeeObjectId = '22222222-2222-4222-8222-222222222222'
const estate: EstateContext = { id: 'primary', tenantId, environment: 'production' }
const observedAt = '2026-09-14T06:00:00.000Z'
const expiresAt = '2026-09-14T08:00:00.000Z'

const jwtConfig: AuthConfig = {
  mode: 'jwt',
  tenantId,
  audience: 'api://agent-sentinel',
  issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
  allowedScopes: { read: ['AgentSentinel.Read'], write: ['AgentSentinel.Write'] },
  spaConfig: {
    tenantId,
    clientId: '33333333-3333-4333-8333-333333333333',
    authority: `https://login.microsoftonline.com/${tenantId}`,
    scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    redirectUri: 'https://sentinel.example/auth/callback',
    postLogoutRedirectUri: 'https://sentinel.example/',
  },
}

function packageNode(
  id: string,
  name: string,
  providerPackageId: string,
): EstateSnapshot['nodes'][number] {
  return {
    id,
    kind: 'agent',
    name,
    description: `${name} description.`,
    environment: estate.environment,
    evidenceIds: [`evidence-${id}`],
    metadata: {
      platform: 'Microsoft Agent 365 package catalog',
      sourceOfTruth: 'true',
      sourceConnector: 'agent365-package-catalog',
      sourceConnectorId: 'agent365-primary',
      sourceTenantId: tenantId,
      sourceEnvironment: estate.environment,
      providerPackageId,
      sourceProviderObjectId: providerPackageId,
      inventoryEntityType: 'agent-package',
      version: '1.0',
    },
  }
}

function snapshot(): EstateSnapshot {
  const visible = packageNode('visible-node', 'Payroll assistant', 'P_payroll')
  const hidden = packageNode('hidden-node', 'Legal investigation agent', 'P_legal-secret')
  return {
    tenantId,
    environment: estate.environment,
    generatedAt: observedAt,
    nodes: [visible, hidden],
    edges: [],
    evidence: [visible, hidden].map((node) => ({
      id: node.evidenceIds[0]!,
      source: 'Microsoft Graph v1.0 Agent 365 package catalog · Primary source',
      sourceObjectId: `agent365-primary:${node.metadata['providerPackageId']!}`,
      observedAt,
      freshness: 'live' as const,
      confidence: 1,
      evidenceTypes: ['declared_configuration' as const],
      summary: 'Authoritative package record.',
      metadata: {
        sourceConnector: 'agent365-package-catalog',
        sourceConnectorId: 'agent365-primary',
        sourceTenantId: tenantId,
        sourceEnvironment: estate.environment,
        providerPackageId: node.metadata['providerPackageId']!,
        sourceProviderObjectId: node.metadata['providerPackageId']!,
        inventoryEntityType: 'agent-package',
      },
    })),
  }
}

function reference(providerPackageId: string) {
  return {
    authority: 'microsoft-agent-365' as const,
    sourceConnectorId: 'agent365-primary',
    sourceTenantId: tenantId,
    sourceEnvironment: estate.environment,
    providerPackageId,
  }
}

function entitlement(
  patch: Partial<Extract<EmployeeEntitlementEvidence, { status: 'available' }>> = {},
): Extract<EmployeeEntitlementEvidence, { status: 'available' }> {
  return {
    status: 'available',
    estate,
    subject: {
      kind: 'microsoft-entra-object-id',
      tenantId,
      objectId: employeeObjectId,
    },
    source: {
      provider: 'microsoft-agent-365',
      authoritative: true,
      synthetic: false,
      coverage: 'complete',
      observedAt,
      expiresAt,
    },
    decisions: [
      { agent: reference('P_payroll'), decision: 'allowed' },
      { agent: reference('P_legal-secret'), decision: 'denied' },
    ],
    ...patch,
  }
}

function signedInPayload(
  roles = ['AgentSentinel.Analyst'],
  objectId: string | null = employeeObjectId,
) {
  return {
    sub: 'employee-subject',
    tid: tenantId,
    idtyp: 'user',
    ...(objectId === null ? {} : { oid: objectId }),
    roles,
  }
}

async function application(resolve: (() => Promise<unknown>) | undefined, candidate = snapshot()) {
  const connector = new MockAgentConnector()
  vi.spyOn(connector, 'discover').mockResolvedValue(candidate)
  const app = await createApp(new DemoService(estate, connector, 'mock'), jwtConfig, {
    dataMode: 'mock',
    estateRegistry: buildEstateRegistry({}, { ...estate, authTenantId: tenantId }),
    ...(resolve === undefined ? {} : { employeeEntitlementResolver: resolve }),
    employeeCatalogClock: () => new Date('2026-09-14T07:00:00.000Z'),
  })
  return app
}

const apps: Awaited<ReturnType<typeof createApp>>[] = []

beforeEach(() => {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  jose.jwtVerify.mockReset()
  jose.jwtVerify.mockResolvedValue({ payload: signedInPayload() })
})

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  delete process.env['AGENT_SENTINEL_CONNECTOR']
})

async function getCatalog(app: Awaited<ReturnType<typeof createApp>>) {
  return app.inject({
    method: 'GET',
    url: '/api/employee/agent-catalog',
    headers: { authorization: 'Bearer test-token' },
  })
}

describe('employee agent catalog API', () => {
  it('labels mock inventory as synthetic and never presents live data without a JWT principal', async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(snapshot())
    await expect(
      resolveEmployeeAgentCatalog({
        authConfig: { mode: 'disabled' },
        dataMode: 'mock',
        estate,
        loadSnapshot,
      }),
    ).resolves.toMatchObject({
      status: 'mock',
      synthetic: true,
    })
    expect(loadSnapshot).toHaveBeenCalledOnce()

    loadSnapshot.mockClear()
    await expect(
      resolveEmployeeAgentCatalog({
        authConfig: { mode: 'disabled' },
        dataMode: 'live',
        estate,
        loadSnapshot,
      }),
    ).resolves.toEqual({
      status: 'unavailable',
      reason: 'principal-identifier-unavailable',
      agents: [],
    })
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it('includes only exact authoritative entitlements without hidden name, ID, or count leakage', async () => {
    const resolver = vi.fn().mockResolvedValue(entitlement())
    const app = await application(resolver)
    apps.push(app)

    const response = await getCatalog(app)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'available',
      authority: 'microsoft-agent-365',
      observedAt,
      agents: [
        {
          id: 'visible-node',
          name: 'Payroll assistant',
          description: 'Payroll assistant description.',
          platform: 'Microsoft Agent 365 package catalog',
          version: '1.0',
        },
      ],
    })
    expect(response.body).not.toContain('Legal investigation agent')
    expect(response.body).not.toContain('hidden-node')
    expect(response.body).not.toContain('P_legal-secret')
    expect(response.body).not.toMatch(/total|inventoryCount|packageCount/i)
    expect(resolver).toHaveBeenCalledWith({
      estate,
      subject: {
        kind: 'microsoft-entra-object-id',
        tenantId,
        objectId: employeeObjectId,
      },
    })
  })

  it('fails closed when evidence is missing or the exact Entra object ID is unavailable', async () => {
    const withoutSource = await application(undefined)
    apps.push(withoutSource)
    expect((await getCatalog(withoutSource)).json()).toEqual({
      status: 'unavailable',
      reason: 'evidence-source-unconfigured',
      agents: [],
    })

    jose.jwtVerify.mockResolvedValueOnce({ payload: signedInPayload(undefined, null) })
    const resolver = vi.fn().mockResolvedValue(entitlement())
    const withoutObjectId = await application(resolver)
    apps.push(withoutObjectId)
    expect((await getCatalog(withoutObjectId)).json()).toEqual({
      status: 'unknown',
      reason: 'principal-identifier-unavailable',
      agents: [],
    })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('rejects tenant, estate, and subject boundary mismatches without returning inventory', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValue(entitlement({ estate: { ...estate, id: 'other-estate' } }))
    const app = await application(resolver)
    apps.push(app)

    expect((await getCatalog(app)).json()).toEqual({
      status: 'unknown',
      reason: 'boundary-mismatch',
      agents: [],
    })
  })

  it.each([
    [
      'subject',
      entitlement({
        subject: {
          kind: 'microsoft-entra-object-id',
          tenantId,
          objectId: '44444444-4444-4444-8444-444444444444',
        },
      }),
    ],
    [
      'decision source',
      entitlement({
        decisions: [
          {
            agent: {
              ...reference('P_payroll'),
              sourceTenantId: '44444444-4444-4444-8444-444444444444',
            },
            decision: 'allowed',
          },
        ],
      }),
    ],
  ])('rejects a cross-boundary %s', async (_label, evidence) => {
    const app = await application(() => Promise.resolve(evidence))
    apps.push(app)

    expect((await getCatalog(app)).json()).toEqual({
      status: 'unknown',
      reason: 'boundary-mismatch',
      agents: [],
    })
  })

  it.each([
    [
      'unavailable',
      {
        status: 'unavailable',
        estate,
        subject: entitlement().subject,
        reason: 'provider unavailable',
      },
      'evidence-source-unavailable',
      'unavailable',
    ],
    [
      'unsupported',
      {
        status: 'unsupported',
        estate,
        subject: entitlement().subject,
        reason: 'permission not supported',
      },
      'unsupported-evidence',
      'unknown',
    ],
    ['invalid', { status: 'available' }, 'invalid-evidence', 'unknown'],
  ] as const)('fails closed for %s resolver evidence', async (_label, evidence, reason, status) => {
    const app = await application(() => Promise.resolve(evidence))
    apps.push(app)
    expect((await getCatalog(app)).json()).toEqual({ status, reason, agents: [] })
  })

  it('fails closed when the entitlement resolver is unavailable', async () => {
    const app = await application(() => Promise.reject(new Error('provider details')))
    apps.push(app)

    expect((await getCatalog(app)).json()).toEqual({
      status: 'unavailable',
      reason: 'evidence-source-unavailable',
      agents: [],
    })
  })

  it.each([
    ['synthetic', { source: { ...entitlement().source, synthetic: true } }, 'synthetic-evidence'],
    [
      'non-authoritative',
      { source: { ...entitlement().source, authoritative: false } },
      'non-authoritative-evidence',
    ],
    [
      'stale',
      { source: { ...entitlement().source, expiresAt: '2026-09-14T06:30:00.000Z' } },
      'stale-evidence',
    ],
    [
      'partial',
      { source: { ...entitlement().source, coverage: 'partial' as const } },
      'incomplete-evidence',
    ],
  ])('rejects %s entitlement evidence', async (_label, patch, reason) => {
    const app = await application(() => Promise.resolve(entitlement(patch)))
    apps.push(app)
    expect((await getCatalog(app)).json()).toEqual({ status: 'unknown', reason, agents: [] })
  })

  it('fails closed on ambiguous decisions and unresolved package identifiers', async () => {
    const ambiguous = entitlement({
      decisions: [
        { agent: reference('P_payroll'), decision: 'allowed' },
        { agent: reference('P_payroll'), decision: 'denied' },
      ],
    })

    const ambiguousApp = await application(() => Promise.resolve(ambiguous))
    apps.push(ambiguousApp)
    expect((await getCatalog(ambiguousApp)).json()).toEqual({
      status: 'unknown',
      reason: 'ambiguous-evidence',
      agents: [],
    })

    const unresolvedApp = await application(() =>
      Promise.resolve(
        entitlement({ decisions: [{ agent: reference('P_missing'), decision: 'allowed' }] }),
      ),
    )
    apps.push(unresolvedApp)
    expect((await getCatalog(unresolvedApp)).json()).toEqual({
      status: 'unknown',
      reason: 'inventory-evidence-unavailable',
      agents: [],
    })

    const duplicateInventory = snapshot()
    duplicateInventory.nodes.push({
      ...structuredClone(duplicateInventory.nodes[0]!),
      id: 'duplicate-visible-node',
    })
    const duplicateApp = await application(() => Promise.resolve(entitlement()), duplicateInventory)
    apps.push(duplicateApp)
    expect((await getCatalog(duplicateApp)).json()).toEqual({
      status: 'unknown',
      reason: 'inventory-evidence-unavailable',
      agents: [],
    })
  })

  it('rejects future or cross-tenant inventory evidence', async () => {
    const futureInventory = snapshot()
    futureInventory.generatedAt = '2026-09-14T08:00:00.000Z'
    const futureApp = await application(() => Promise.resolve(entitlement()), futureInventory)
    apps.push(futureApp)
    expect((await getCatalog(futureApp)).json()).toEqual({
      status: 'unknown',
      reason: 'inventory-evidence-unavailable',
      agents: [],
    })

    const crossTenantInventory = snapshot()
    crossTenantInventory.tenantId = '44444444-4444-4444-8444-444444444444'
    const crossTenantApp = await application(
      () => Promise.resolve(entitlement()),
      crossTenantInventory,
    )
    apps.push(crossTenantApp)
    expect((await getCatalog(crossTenantApp)).json()).toEqual({
      status: 'unknown',
      reason: 'boundary-mismatch',
      agents: [],
    })
  })

  it('does not bind publishing-platform decisions to Agent 365 inventory', async () => {
    const crossAuthority = entitlement({
      source: { ...entitlement().source, provider: 'publishing-platform' },
      decisions: [
        {
          agent: { ...reference('P_payroll'), authority: 'publishing-platform' },
          decision: 'allowed',
        },
      ],
    })
    const app = await application(() => Promise.resolve(crossAuthority))
    apps.push(app)

    expect((await getCatalog(app)).json()).toEqual({
      status: 'unknown',
      reason: 'inventory-evidence-unavailable',
      agents: [],
    })
  })

  it('requires the existing read capability before resolving employee entitlements', async () => {
    jose.jwtVerify.mockResolvedValueOnce({ payload: signedInPayload([]) })
    const resolver = vi.fn().mockResolvedValue(entitlement())
    const app = await application(resolver)
    apps.push(app)

    const response = await getCatalog(app)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      error: 'forbidden',
      message: 'The token does not grant the required permission.',
    })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('does not resolve employee entitlements for service principals', async () => {
    jose.jwtVerify.mockResolvedValueOnce({
      payload: {
        ...signedInPayload(),
        idtyp: 'app',
        scp: undefined,
      },
    })
    const resolver = vi.fn().mockResolvedValue(entitlement())
    const app = await application(resolver)
    apps.push(app)

    expect((await getCatalog(app)).json()).toEqual({
      status: 'unknown',
      reason: 'principal-identifier-unavailable',
      agents: [],
    })
    expect(resolver).not.toHaveBeenCalled()
  })

  it('returns denied without inventory details when complete authority grants no agents', async () => {
    const app = await application(() => Promise.resolve(entitlement({ decisions: [] })))
    apps.push(app)
    expect((await getCatalog(app)).json()).toEqual({
      status: 'denied',
      authority: 'microsoft-agent-365',
      observedAt,
      agents: [],
    })
  })

  it('keeps operational estate inventory on its existing separate read-capability gate', async () => {
    const app = await application(() => Promise.resolve(entitlement()))
    apps.push(app)

    const operatorResponse = await app.inject({
      method: 'GET',
      url: '/api/demo/state',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(operatorResponse.statusCode).toBe(200)

    jose.jwtVerify.mockResolvedValueOnce({ payload: signedInPayload([]) })
    const unprivilegedResponse = await app.inject({
      method: 'GET',
      url: '/api/demo/state',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(unprivilegedResponse.statusCode).toBe(403)
  })
})
