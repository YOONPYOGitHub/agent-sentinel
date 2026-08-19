import type { FastifyInstance } from 'fastify'

import {
  governancePostureSchema,
  type ExposureFinding,
  type ExposureFindingRepository,
  type GovernancePosture,
} from '@agent-sentinel/domain'
import { exposurePolicyCatalog } from '@agent-sentinel/policy-engine'

import { buildMockExposurePage } from './exposure-routes.js'

export interface GovernanceRoutesOptions {
  mode: 'mock' | 'foundry'
  defaultTenantId: string
  repository?: ExposureFindingRepository
}

function buildPosture(findings: ExposureFinding[], mode: 'mock' | 'foundry'): GovernancePosture {
  const evaluationCoverage = mode === 'mock' ? ('complete' as const) : ('findings-only' as const)
  const openFindings = findings.filter(
    (finding) => finding.status === 'open' || finding.status === 'validated',
  )
  const policies = exposurePolicyCatalog.map((policy) => {
    const policyFindings = openFindings.filter((finding) => finding.policyId === policy.id)
    return {
      ...policy,
      status:
        policyFindings.length > 0
          ? ('needs-attention' as const)
          : evaluationCoverage === 'complete'
            ? ('compliant' as const)
            : ('not-evaluated' as const),
      openFindings: policyFindings.length,
      affectedAgents: new Set(policyFindings.map((finding) => finding.affectedAgentId)).size,
      evidenceBasis: 'declared_configuration' as const,
    }
  })
  return governancePostureSchema.parse({
    policies,
    summary: {
      totalPolicies: policies.length,
      compliantPolicies: policies.filter((policy) => policy.status === 'compliant').length,
      policiesNeedingAttention: policies.filter((policy) => policy.status === 'needs-attention')
        .length,
      openFindings: openFindings.length,
      affectedAgents: new Set(openFindings.map((finding) => finding.affectedAgentId)).size,
    },
    latestEvidenceAt: findings
      .map((finding) => finding.lastSeen)
      .sort((left, right) => right.localeCompare(left))[0],
    sourceMode: mode,
    evidenceBasis: 'declared_configuration',
    evaluationCoverage,
  })
}

export function registerGovernanceRoutes(
  app: FastifyInstance,
  options: GovernanceRoutesOptions,
): void {
  app.get('/api/governance/posture', async () => {
    if (options.mode === 'mock') {
      const { findings } = buildMockExposurePage(options.defaultTenantId, {})
      return buildPosture(findings, 'mock')
    }
    if (!options.repository) {
      throw new Error('Live governance posture requires a repository binding.')
    }
    const findings: ExposureFinding[] = []
    let page = 1
    let total = Number.POSITIVE_INFINITY
    while (findings.length < total) {
      const result = await options.repository.listByTenant(options.defaultTenantId, {
        page,
        pageSize: 200,
      })
      findings.push(...result.items)
      total = result.total
      if (result.items.length === 0) break
      page += 1
    }
    return buildPosture(findings, 'foundry')
  })
}
