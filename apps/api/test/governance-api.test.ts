import { describe, expect, it, vi } from 'vitest'

import type { GovernancePosture } from '@agent-sentinel/domain'

import { createApp } from '../src/app.js'
import { buildMockExposurePage } from '../src/exposure-routes.js'

describe('governance API', () => {
  it('returns deterministic policy posture in mock mode', async () => {
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      { dataMode: 'mock' },
    )
    try {
      const response = await app.inject({ method: 'GET', url: '/api/governance/posture' })
      expect(response.statusCode).toBe(200)
      const posture: GovernancePosture = response.json()
      expect(posture.summary.totalPolicies).toBe(3)
      expect(posture.summary.policiesNeedingAttention).toBeGreaterThan(0)
      expect(posture.summary.openFindings).toBeGreaterThan(0)
      expect(posture.evaluationCoverage).toBe('complete')
      expect(posture.latestEvidenceAt).toBeDefined()
      expect(posture.policies.map((policy) => policy.id)).toEqual([
        'AS-POL-001',
        'AS-POL-002',
        'AS-POL-003',
      ])
      expect(
        posture.policies.every((policy) => policy.evidenceBasis === 'declared_configuration'),
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('does not claim compliance from findings-only live data', async () => {
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
    const repository = {
      upsert: vi.fn(),
      findById: vi.fn(),
      listByTenant: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getFacets: vi.fn(),
      resolveAbsent: vi.fn(),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      { dataMode: 'live', exposureRepository: repository },
    )
    try {
      const response = await app.inject({ method: 'GET', url: '/api/governance/posture' })
      const posture: GovernancePosture = response.json()
      expect(posture.evaluationCoverage).toBe('findings-only')
      expect(posture.summary.compliantPolicies).toBe(0)
      expect(posture.policies.every((policy) => policy.status === 'not-evaluated')).toBe(true)
      expect(posture.latestEvidenceAt).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('recomputes posture from current finding state instead of a scoring store', async () => {
    process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
    let findings = buildMockExposurePage('tenant-demo', {}).findings
    const repository = {
      upsert: vi.fn(),
      findById: vi.fn(),
      listByTenant: vi.fn().mockImplementation(() =>
        Promise.resolve({
          items: findings,
          total: findings.length,
        }),
      ),
      getFacets: vi.fn(),
      resolveAbsent: vi.fn(),
    }
    const app = await createApp(
      undefined,
      { mode: 'disabled', allowedScopes: { read: [], write: [] } },
      { dataMode: 'live', exposureRepository: repository },
    )
    try {
      const before: GovernancePosture = (
        await app.inject({ method: 'GET', url: '/api/governance/posture' })
      ).json()
      expect(before.summary.policiesNeedingAttention).toBeGreaterThan(0)

      findings = findings.map((finding) => ({ ...finding, status: 'resolved' as const }))
      const after: GovernancePosture = (
        await app.inject({ method: 'GET', url: '/api/governance/posture' })
      ).json()
      expect(after.summary.policiesNeedingAttention).toBe(0)
      expect(after.summary.openFindings).toBe(0)
      expect(after.policies.every((policy) => policy.status === 'not-evaluated')).toBe(true)
    } finally {
      await app.close()
    }
  })
})
