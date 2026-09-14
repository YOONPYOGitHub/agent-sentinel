import { describe, expect, it } from 'vitest'

import {
  authoritativeAgent365CatalogBinding,
  employeeAgentCatalogResponseSchema,
  employeeEntitlementEvidenceSchema,
  type EstateContext,
  type EstateSnapshot,
} from '../src/index.js'

const tenantId = '11111111-1111-4111-8111-111111111111'
const subjectId = '22222222-2222-4222-8222-222222222222'
const estate: EstateContext = { id: 'primary', tenantId, environment: 'production' }

function packageSnapshot(): EstateSnapshot {
  return {
    tenantId,
    environment: estate.environment,
    generatedAt: '2026-09-14T06:00:00.000Z',
    nodes: [
      {
        id: 'agent365-package-node',
        kind: 'agent',
        name: 'Payroll assistant',
        description: 'Answers payroll questions.',
        environment: estate.environment,
        evidenceIds: ['agent365-package-evidence'],
        metadata: {
          platform: 'Microsoft Agent 365 package catalog',
          sourceOfTruth: 'true',
          sourceConnector: 'agent365-package-catalog',
          sourceConnectorId: 'primary-source',
          sourceTenantId: tenantId,
          sourceEnvironment: estate.environment,
          providerPackageId: 'P_payroll',
          sourceProviderObjectId: 'P_payroll',
          inventoryEntityType: 'agent-package',
        },
      },
    ],
    edges: [],
    evidence: [
      {
        id: 'agent365-package-evidence',
        source: 'Microsoft Graph v1.0 Agent 365 package catalog · Primary source',
        sourceObjectId: 'primary-source:P_payroll',
        observedAt: '2026-09-14T06:00:00.000Z',
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: 'Authoritative package record.',
        metadata: {
          sourceConnector: 'agent365-package-catalog',
          sourceConnectorId: 'primary-source',
          sourceTenantId: tenantId,
          sourceEnvironment: estate.environment,
          providerPackageId: 'P_payroll',
          sourceProviderObjectId: 'P_payroll',
          inventoryEntityType: 'agent-package',
        },
      },
    ],
  }
}

describe('employee entitlement contracts', () => {
  it('normalizes exact Entra object identifiers and keeps provider package IDs exact', () => {
    const evidence = employeeEntitlementEvidenceSchema.parse({
      status: 'available',
      estate,
      subject: {
        kind: 'microsoft-entra-object-id',
        tenantId: tenantId.toUpperCase(),
        objectId: subjectId.toUpperCase(),
      },
      source: {
        provider: 'microsoft-agent-365',
        authoritative: true,
        synthetic: false,
        coverage: 'complete',
        observedAt: '2026-09-14T06:00:00.000Z',
        expiresAt: '2026-09-14T07:00:00.000Z',
      },
      decisions: [
        {
          agent: {
            authority: 'microsoft-agent-365',
            sourceConnectorId: 'primary-source',
            sourceTenantId: tenantId,
            sourceEnvironment: estate.environment,
            providerPackageId: 'P_Payroll',
          },
          decision: 'allowed',
        },
      ],
    })

    expect(evidence.subject.objectId).toBe(subjectId)
    expect(evidence.status === 'available' && evidence.decisions[0]?.agent.providerPackageId).toBe(
      'P_Payroll',
    )
  })

  it('accepts only exact authoritative Agent 365 package inventory bindings', () => {
    const snapshot = packageSnapshot()
    expect(authoritativeAgent365CatalogBinding(snapshot, snapshot.nodes[0]!, estate)).toEqual({
      authority: 'microsoft-agent-365',
      sourceConnectorId: 'primary-source',
      sourceTenantId: tenantId,
      sourceEnvironment: estate.environment,
      providerPackageId: 'P_payroll',
      observedAt: '2026-09-14T06:00:00.000Z',
    })

    const sameNameWrongPackage = structuredClone(snapshot)
    sameNameWrongPackage.nodes[0]!.metadata['providerPackageId'] = 'P_other'
    expect(
      authoritativeAgent365CatalogBinding(
        sameNameWrongPackage,
        sameNameWrongPackage.nodes[0]!,
        estate,
      ),
    ).toBeUndefined()
  })

  it.each([
    ['stale evidence', (snapshot: EstateSnapshot) => (snapshot.evidence[0]!.freshness = 'stale')],
    [
      'synthetic package',
      (snapshot: EstateSnapshot) => (snapshot.nodes[0]!.metadata['synthetic'] = 'true'),
    ],
    [
      'non-authoritative package',
      (snapshot: EstateSnapshot) => (snapshot.nodes[0]!.metadata['isNonAuthoritative'] = 'true'),
    ],
    [
      'mismatched provider object identifier',
      (snapshot: EstateSnapshot) =>
        (snapshot.evidence[0]!.metadata!['sourceProviderObjectId'] = 'P_other'),
    ],
    [
      'unexpected evidence source',
      (snapshot: EstateSnapshot) => (snapshot.evidence[0]!.source = 'Unverified package export'),
    ],
    [
      'ambiguous duplicate evidence identifier',
      (snapshot: EstateSnapshot) => snapshot.evidence.push(structuredClone(snapshot.evidence[0]!)),
    ],
    [
      'other tenant',
      (snapshot: EstateSnapshot) =>
        (snapshot.nodes[0]!.metadata['sourceTenantId'] = '33333333-3333-4333-8333-333333333333'),
    ],
  ])('rejects %s inventory instead of treating it as employee-visible', (_name, mutate) => {
    const snapshot = packageSnapshot()
    mutate(snapshot)
    expect(
      authoritativeAgent365CatalogBinding(snapshot, snapshot.nodes[0]!, estate),
    ).toBeUndefined()
  })

  it('rejects normalized identifiers and cross-authority references', () => {
    const invalidReference = {
      authority: 'microsoft-agent-365',
      sourceConnectorId: ' primary-source',
      sourceTenantId: tenantId,
      sourceEnvironment: estate.environment,
      providerPackageId: 'P_payroll',
    }
    expect(() =>
      employeeEntitlementEvidenceSchema.parse({
        status: 'available',
        estate,
        subject: { kind: 'microsoft-entra-object-id', tenantId, objectId: subjectId },
        source: {
          provider: 'microsoft-agent-365',
          authoritative: true,
          synthetic: false,
          coverage: 'complete',
          observedAt: '2026-09-14T06:00:00.000Z',
          expiresAt: '2026-09-14T07:00:00.000Z',
        },
        decisions: [{ agent: invalidReference, decision: 'allowed' }],
      }),
    ).toThrow()

    const binding = authoritativeAgent365CatalogBinding(
      packageSnapshot(),
      packageSnapshot().nodes[0]!,
      estate,
    )
    expect(binding?.authority).toBe('microsoft-agent-365')
  })

  it('requires non-enumerable failure responses to carry no agent entries', () => {
    expect(() =>
      employeeAgentCatalogResponseSchema.parse({
        status: 'unknown',
        reason: 'stale-evidence',
        agents: [{ id: 'hidden', name: 'Hidden', description: 'Must not leak.' }],
      }),
    ).toThrow()
  })
})
