import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import {
  exposureFindingSchema,
  exposureFindingStatusSchema,
  exposureFindingSeveritySchema,
  exposurePageSchema,
  estateSnapshotSchema,
  remediationPreviewSchema,
  type EstateContext,
  type EstateSnapshot,
  type ExposureFinding,
  type ExposureFindingListFilters,
  type ExposureFindingRepository,
  type ExposureFreshness,
  type ExposurePage,
  type RemediationPreview,
  type SnapshotRepository,
} from '@agent-sentinel/domain'
import { calculateBlastRadius, simulateEdgeRemoval } from '@agent-sentinel/graph-engine'
import { evaluateAllExposurePolicies } from '@agent-sentinel/policy-engine'
import { foundryManifest, type AgentDefinition } from '@agent-sentinel/scenarios'
import { mapAgentToSnapshot, FOUNDRY_API_VERSION } from '@agent-sentinel/foundry-connector'

import type { AdvisoryService } from './advisory-service.js'
import { requireCapability, type AuthConfig } from './auth.js'
import { requireEstateContext } from './estate-auth.js'

const listQuerySchema = z.object({
  severity: exposureFindingSeveritySchema.optional(),
  status: exposureFindingStatusSchema.optional(),
  policyId: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  tenantId: z.string().min(1).optional(),
  environment: z.string().min(1).optional(),
})

export interface ExposureRoutesOptions {
  mode: 'mock' | 'foundry'
  defaultEstate: EstateContext
  repository?: ExposureFindingRepository
  snapshotRepository?: SnapshotRepository
  advisoryService?: AdvisoryService
  authConfig?: AuthConfig
}

function agentDefinitionToFoundryAgent(
  agent: AgentDefinition,
): Parameters<typeof mapAgentToSnapshot>[0][number] {
  return {
    id: agent.name,
    name: agent.displayName,
    version: agent.version,
    description: agent.description,
    model: agent.modelDeployment,
    instructions: agent.instructions,
    tools: agent.functions.map((fn) => ({
      type: 'function',
      function: {
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      },
    })),
    metadata: {
      owner: agent.owner,
      environment: agent.environment,
      approvalRequired: agent.approvalRequired ? 'true' : 'false',
      lifecycle: agent.lifecycle,
      version: agent.version,
    },
  }
}

export function buildMockExposurePage(
  tenantId: string,
  filters: ExposureFindingListFilters,
  environment = 'validation',
): {
  page: ExposurePage
  findings: ExposureFinding[]
  freshness: ExposureFreshness
  snapshot: EstateSnapshot
} {
  const snapshot = mapAgentToSnapshot(
    foundryManifest.agents.map(agentDefinitionToFoundryAgent),
    FOUNDRY_API_VERSION,
    { tenantId, environment },
  )
  const snapshotId = `${snapshot.tenantId}-${snapshot.environment}-${snapshot.generatedAt}`
  const findings: ExposureFinding[] = evaluateAllExposurePolicies(snapshot).map((finding) => ({
    ...finding,
    sourceMode: 'mock',
    tenantId,
    snapshotId,
  }))
  const filtered = applyFilters(findings, filters)
  const facets = buildFacets(findings)
  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const start = Math.max(0, (page - 1) * pageSize)
  const paged = filtered.slice(start, start + pageSize)
  return {
    page: {
      findings: paged,
      total: filtered.length,
      facets,
      freshness: {
        snapshotId,
        generatedAt: snapshot.generatedAt,
        sourceMode: 'mock',
        agentCount: snapshot.nodes.filter((node) => node.kind === 'agent').length,
      },
    },
    findings,
    freshness: {
      snapshotId,
      generatedAt: snapshot.generatedAt,
      sourceMode: 'mock',
      agentCount: snapshot.nodes.filter((node) => node.kind === 'agent').length,
    },
    snapshot,
  }
}

export function buildExposureGraphSnapshot(
  snapshot: EstateSnapshot,
  finding: ExposureFinding,
): EstateSnapshot {
  const nodeIds = new Set([finding.affectedAgentId, ...finding.affectedNodeIds])
  const affectedEdgeIds = new Set(finding.affectedEdgeIds)
  const edges = snapshot.edges.filter((edge) => affectedEdgeIds.has(edge.id))
  for (const edge of edges) {
    nodeIds.add(edge.from)
    nodeIds.add(edge.to)
  }
  const nodes = snapshot.nodes.filter((node) => nodeIds.has(node.id))
  const evidenceIds = new Set([
    ...finding.evidenceIds,
    ...nodes.flatMap((node) => node.evidenceIds),
    ...edges.flatMap((edge) => edge.evidenceIds),
  ])
  return estateSnapshotSchema.parse({
    ...snapshot,
    nodes,
    edges,
    evidence: snapshot.evidence.filter((evidence) => evidenceIds.has(evidence.id)),
  })
}

function buildComparisonGraph(
  snapshot: EstateSnapshot,
  includedNodeIds: ReadonlySet<string>,
): EstateSnapshot {
  const nodes = snapshot.nodes.filter((node) => includedNodeIds.has(node.id))
  const edges = snapshot.edges.filter(
    (edge) => includedNodeIds.has(edge.from) && includedNodeIds.has(edge.to),
  )
  const evidenceIds = new Set([
    ...nodes.flatMap((node) => node.evidenceIds),
    ...edges.flatMap((edge) => edge.evidenceIds),
  ])
  return estateSnapshotSchema.parse({
    ...snapshot,
    nodes,
    edges,
    evidence: snapshot.evidence.filter((evidence) => evidenceIds.has(evidence.id)),
  })
}

export function buildRemediationPreview(
  snapshot: EstateSnapshot,
  finding: ExposureFinding,
): RemediationPreview {
  const targetEdgeIds = finding.affectedEdgeIds.filter((edgeId) =>
    snapshot.edges.some((edge) => edge.id === edgeId && edge.active),
  )
  const inactiveOrMissingTargetEdgeIds = finding.affectedEdgeIds.filter(
    (edgeId) => !targetEdgeIds.includes(edgeId),
  )

  const previewSnapshot = targetEdgeIds.reduce(
    (current, edgeId) => simulateEdgeRemoval(current, edgeId),
    snapshot,
  )
  const baselineFindings = evaluateAllExposurePolicies(snapshot).filter(
    (candidate) => candidate.affectedAgentId === finding.affectedAgentId,
  )
  const residualFindings = evaluateAllExposurePolicies(previewSnapshot)
    .filter((candidate) => candidate.affectedAgentId === finding.affectedAgentId)
    .map((candidate) => ({
      ...candidate,
      sourceMode: finding.sourceMode,
      tenantId: finding.tenantId,
      snapshotId: finding.snapshotId,
    }))
  const baselineCoversSelectedPolicy = baselineFindings.some(
    (candidate) => candidate.policyId === finding.policyId,
  )
  const beforeRiskScore = Math.max(
    finding.riskScore,
    ...baselineFindings.map((candidate) => candidate.riskScore),
  )
  const analyzedResidualRisk = Math.max(
    0,
    ...residualFindings.map((candidate) => candidate.riskScore),
  )
  const afterRiskScore =
    targetEdgeIds.length > 0 && baselineCoversSelectedPolicy
      ? analyzedResidualRisk
      : beforeRiskScore
  const beforeBlastRadius = calculateBlastRadius(snapshot, finding.affectedAgentId)
  const afterBlastRadius = calculateBlastRadius(previewSnapshot, finding.affectedAgentId)
  const comparisonNodeIds = new Set([
    finding.affectedAgentId,
    ...beforeBlastRadius.map((node) => node.id),
  ])
  const targetNodeNames = targetEdgeIds
    .map((edgeId) => snapshot.edges.find((edge) => edge.id === edgeId))
    .map((edge) => snapshot.nodes.find((node) => node.id === edge?.to)?.name)
    .filter((name): name is string => name !== undefined)
  const blastRadiusReduction = Math.max(0, beforeBlastRadius.length - afterBlastRadius.length)
  const residualRoutes = residualFindings.flatMap((residualFinding) => {
    const edgeIds = residualFinding.affectedEdgeIds.filter((edgeId) =>
      previewSnapshot.edges.some((edge) => edge.id === edgeId && edge.active),
    )
    if (edgeIds.length === 0) return []
    return [
      {
        findingId: residualFinding.id,
        policyId: residualFinding.policyId,
        riskScore: residualFinding.riskScore,
        nodeIds: residualFinding.affectedNodeIds,
        edgeIds,
        evidenceIds: residualFinding.evidenceIds,
      },
    ]
  })
  const analysisEvidenceIds = new Set([
    ...finding.evidenceIds,
    ...baselineFindings.flatMap((candidate) => candidate.evidenceIds),
    ...residualFindings.flatMap((candidate) => candidate.evidenceIds),
  ])
  const analysisEvidence = snapshot.evidence.filter((item) => analysisEvidenceIds.has(item.id))
  const uncertainty: RemediationPreview['uncertainty'] = []
  const availableEvidenceIds = new Set(snapshot.evidence.map((item) => item.id))
  const missingEvidenceIds = [...analysisEvidenceIds].filter(
    (evidenceId) => !availableEvidenceIds.has(evidenceId),
  )
  if (missingEvidenceIds.length > 0) {
    uncertainty.push({
      code: 'missing-evidence',
      message: 'The simulated analysis references evidence absent from the snapshot.',
      evidenceIds: missingEvidenceIds,
    })
  }
  if (targetEdgeIds.length === 0) {
    uncertainty.push({
      code: 'no-active-target-routes',
      message: 'No requested route is active, so the simulation makes no graph change.',
      evidenceIds: finding.evidenceIds,
    })
  } else if (inactiveOrMissingTargetEdgeIds.length > 0) {
    uncertainty.push({
      code: 'partial-target-coverage',
      message:
        'Only active requested routes were removed; inactive or absent target routes were unchanged.',
      evidenceIds: finding.evidenceIds,
    })
  }
  const staleEvidenceIds = analysisEvidence
    .filter((item) => item.freshness === 'stale')
    .map((item) => item.id)
  if (staleEvidenceIds.length > 0) {
    uncertainty.push({
      code: 'stale-evidence',
      message: 'The simulated analysis includes stale evidence.',
      evidenceIds: staleEvidenceIds,
    })
  }
  const unknownEvidenceIds = analysisEvidence
    .filter((item) => item.evidenceTypes.includes('unknown'))
    .map((item) => item.id)
  if (unknownEvidenceIds.length > 0) {
    uncertainty.push({
      code: 'unknown-evidence',
      message: 'The simulated analysis includes evidence with unknown provenance or type.',
      evidenceIds: unknownEvidenceIds,
    })
  }
  const syntheticEvidenceIds = analysisEvidence
    .filter((item) => item.evidenceTypes.includes('synthetic_validation'))
    .map((item) => item.id)
  if (syntheticEvidenceIds.length > 0) {
    uncertainty.push({
      code: 'synthetic-evidence',
      message: 'Synthetic validation evidence does not establish a live remediation outcome.',
      evidenceIds: syntheticEvidenceIds,
    })
  }
  if (
    analysisEvidence.length > 0 &&
    analysisEvidence.every((item) =>
      item.evidenceTypes.every((type) => type === 'declared_configuration'),
    )
  ) {
    uncertainty.push({
      code: 'declared-configuration-only',
      message: 'The preview is based only on declared configuration.',
      evidenceIds: analysisEvidence.map((item) => item.id),
    })
  }
  if (finding.validationStatus === 'theoretical') {
    uncertainty.push({
      code: 'theoretical-analysis',
      message: 'The selected finding has not been validated against observed runtime behavior.',
      evidenceIds: finding.evidenceIds,
    })
  }
  if (!baselineCoversSelectedPolicy) {
    uncertainty.push({
      code: 'analysis-coverage-unknown',
      message:
        'The current deterministic policy catalog cannot reproduce the selected finding, so no risk reduction is claimed.',
      evidenceIds: finding.evidenceIds,
    })
  }

  return remediationPreviewSchema.parse({
    findingId: finding.id,
    actionId: `preview-block-route-${finding.id}`,
    actionType: 'block-route',
    title:
      targetEdgeIds.length === 0
        ? 'No active risky routes to block'
        : targetNodeNames.length === 1
          ? `Block route to ${targetNodeNames[0]}`
          : `Block ${targetEdgeIds.length} risky routes`,
    description:
      'Simulate a Sentinel policy-layer route block. No connector or target platform is modified.',
    targetEdgeIds,
    simulationOnly: true,
    before: {
      riskScore: beforeRiskScore,
      blastRadiusCount: beforeBlastRadius.length,
    },
    after: {
      riskScore: afterRiskScore,
      blastRadiusCount: afterBlastRadius.length,
    },
    impact: {
      riskReduction: Math.max(0, beforeRiskScore - afterRiskScore),
      blastRadiusReduction,
      businessDisruption: 'unknown',
      workflowImpact: 'unknown',
      rollbackAvailable: true,
    },
    residualFindings,
    residualRoutes,
    uncertainty,
    citedEvidence: analysisEvidence,
    beforeGraph: buildComparisonGraph(snapshot, comparisonNodeIds),
    afterGraph: buildComparisonGraph(previewSnapshot, comparisonNodeIds),
  })
}

async function loadExposureContext(
  options: ExposureRoutesOptions,
  findingId: string,
  estate: EstateContext,
): Promise<{ finding: ExposureFinding; snapshot: EstateSnapshot } | null> {
  if (options.mode === 'mock') {
    const { findings, snapshot } = buildMockExposurePage(estate.tenantId, {}, estate.environment)
    const finding = findings.find((candidate) => candidate.id === findingId)
    return finding ? { finding, snapshot } : null
  }
  if (!options.repository || !options.snapshotRepository) {
    throw new Error('Live exposure graph requires finding and snapshot repository bindings.')
  }
  const finding = await options.repository.findById(findingId, estate)
  if (!finding) return null
  const snapshot = await options.snapshotRepository.findById(finding.snapshotId, estate)
  return snapshot ? { finding, snapshot } : null
}

function applyFilters(
  findings: ExposureFinding[],
  filters: ExposureFindingListFilters,
): ExposureFinding[] {
  const search = filters.search?.trim().toLocaleLowerCase() ?? ''
  return findings
    .filter((finding) => (filters.severity ? finding.severity === filters.severity : true))
    .filter((finding) => (filters.status ? finding.status === filters.status : true))
    .filter((finding) => (filters.policyId ? finding.policyId === filters.policyId : true))
    .filter((finding) => {
      if (search.length === 0) return true
      return [
        finding.title,
        finding.summary,
        finding.affectedAgentName,
        finding.policyName,
        finding.policyId,
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(search)
    })
    .sort((left, right) => right.riskScore - left.riskScore)
}

export function buildFacets(findings: ExposureFinding[]): ExposurePage['facets'] {
  const severity: Record<string, number> = {}
  const status: Record<string, number> = {}
  const policyId: Record<string, number> = {}
  for (const finding of findings) {
    severity[finding.severity] = (severity[finding.severity] ?? 0) + 1
    status[finding.status] = (status[finding.status] ?? 0) + 1
    policyId[finding.policyId] = (policyId[finding.policyId] ?? 0) + 1
  }
  return { severity, status, policyId }
}

function parseQuery(request: FastifyRequest): {
  filters: ExposureFindingListFilters
  tenantId: string | undefined
  environment: string | undefined
} {
  const parsed = listQuerySchema.parse(request.query)
  const filters: ExposureFindingListFilters = {}
  if (parsed.severity !== undefined) filters.severity = parsed.severity
  if (parsed.status !== undefined) filters.status = parsed.status
  if (parsed.policyId !== undefined) filters.policyId = parsed.policyId
  if (parsed.search !== undefined) filters.search = parsed.search
  if (parsed.page !== undefined) filters.page = parsed.page
  if (parsed.pageSize !== undefined) filters.pageSize = parsed.pageSize
  return { filters, tenantId: parsed.tenantId, environment: parsed.environment }
}

export function registerExposureRoutes(app: FastifyInstance, options: ExposureRoutesOptions): void {
  app.get('/api/exposures/status', (request) => ({
    mode: options.mode,
    ...requireEstateContext(request),
    generatedAt: new Date().toISOString(),
  }))

  app.get('/api/exposures', async (request, reply) => {
    const {
      filters,
      tenantId: tenantAssertion,
      environment: environmentAssertion,
    } = parseQuery(request)
    const estate = requireEstateContext(request)
    if (
      (tenantAssertion !== undefined && tenantAssertion !== estate.tenantId) ||
      (environmentAssertion !== undefined && environmentAssertion !== estate.environment)
    ) {
      void reply.status(403)
      return {
        error: 'forbidden',
        message: 'The requested data boundary does not match the authorized estate.',
      }
    }
    let page: ExposurePage
    if (options.mode === 'mock') {
      page = buildMockExposurePage(estate.tenantId, filters, estate.environment).page
    } else {
      if (!options.repository) throw new Error('Live exposure requires a repository binding.')
      const [filtered, facets] = await Promise.all([
        options.repository.listByTenant(estate, filters),
        options.repository.getFacets(estate),
      ])
      page = { findings: filtered.items, total: filtered.total, facets }
    }
    return exposurePageSchema.parse(page)
  })

  app.get<{ Params: { findingId: string } }>(
    '/api/exposures/:findingId/graph',
    async (request, reply) => {
      const { findingId } = request.params
      const context = await loadExposureContext(options, findingId, requireEstateContext(request))
      if (!context) {
        void reply.status(404)
        return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
      }
      return buildExposureGraphSnapshot(context.snapshot, context.finding)
    },
  )

  const narrativeGuard = options.authConfig
    ? requireCapability(options.authConfig, 'generateAdvisory')
    : undefined
  app.post<{ Params: { findingId: string } }>(
    '/api/exposures/:findingId/narrative',
    narrativeGuard !== undefined ? { preHandler: narrativeGuard } : {},
    async (request, reply) => {
      const { findingId } = request.params
      const context = await loadExposureContext(options, findingId, requireEstateContext(request))
      if (!context) {
        void reply.status(404)
        return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
      }
      if (!options.advisoryService) {
        void reply.status(503)
        return {
          error: 'advisory_unavailable',
          message: 'The advisory narrative service is not configured.',
        }
      }
      return options.advisoryService.generate(context)
    },
  )

  app.get<{ Params: { findingId: string } }>(
    '/api/exposures/:findingId/narrative',
    narrativeGuard !== undefined ? { preHandler: narrativeGuard } : {},
    async (request, reply) => {
      const { findingId } = request.params
      const context = await loadExposureContext(options, findingId, requireEstateContext(request))
      if (!context) {
        void reply.status(404)
        return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
      }
      if (!options.advisoryService) {
        void reply.status(503)
        return {
          error: 'advisory_unavailable',
          message: 'The advisory narrative service is not configured.',
        }
      }
      if (options.advisoryService.requiresAuthenticatedPost) {
        void reply.status(405)
        return {
          error: 'authenticated_post_required',
          message: 'Azure advisory generation requires an authenticated POST request.',
        }
      }
      return options.advisoryService.generate(context)
    },
  )

  app.get<{ Params: { findingId: string } }>(
    '/api/exposures/:findingId/remediation-preview',
    async (request, reply) => {
      const { findingId } = request.params
      const context = await loadExposureContext(options, findingId, requireEstateContext(request))
      if (!context) {
        void reply.status(404)
        return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
      }
      return buildRemediationPreview(context.snapshot, context.finding)
    },
  )

  app.get<{ Params: { findingId: string } }>(
    '/api/exposures/:findingId',
    async (request, reply) => {
      const { findingId } = request.params
      const estate = requireEstateContext(request)
      if (options.mode === 'mock') {
        const { findings } = buildMockExposurePage(estate.tenantId, {}, estate.environment)
        const found = findings.find((finding) => finding.id === findingId)
        if (!found) {
          void reply.status(404)
          return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
        }
        return exposureFindingSchema.parse(found)
      }
      if (!options.repository) throw new Error('Live exposure requires a repository binding.')
      const finding = await options.repository.findById(findingId, estate)
      if (!finding) {
        void reply.status(404)
        return { error: 'not_found', message: `Exposure finding not found: ${findingId}` }
      }
      return exposureFindingSchema.parse(finding)
    },
  )
}
