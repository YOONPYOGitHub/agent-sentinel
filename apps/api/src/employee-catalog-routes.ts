import type { FastifyInstance } from 'fastify'

import {
  authoritativeAgent365CatalogBinding,
  employeeAgentCatalogResponseSchema,
  employeeEntitlementEvidenceSchema,
  employeeEntitlementSubjectSchema,
  type EmployeeAgentCatalogEntry,
  type EmployeeAgentCatalogResponse,
  type EmployeeAgentReference,
  type EmployeeEntitlementEvidence,
  type EstateContext,
  type EstateSnapshot,
} from '@agent-sentinel/domain'

import { requireCapability, type AuthConfig, type AuthPrincipal } from './auth.js'
import { requireEstateContext } from './estate-auth.js'

export interface EmployeeEntitlementRequest {
  estate: EstateContext
  subject: {
    kind: 'microsoft-entra-object-id'
    tenantId: string
    objectId: string
  }
}

export type EmployeeEntitlementResolver = (request: EmployeeEntitlementRequest) => Promise<unknown>

export interface EmployeeCatalogRouteOptions {
  authConfig: AuthConfig
  dataMode: 'mock' | 'live'
  entitlementResolver?: EmployeeEntitlementResolver
  loadSnapshot: (estate: EstateContext) => Promise<EstateSnapshot>
  clock?: () => Date
}

function emptyFailure(
  status: 'unknown' | 'unavailable',
  reason: Extract<EmployeeAgentCatalogResponse, { status: typeof status }>['reason'],
): EmployeeAgentCatalogResponse {
  return { status, reason, agents: [] }
}

function sameTenant(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function sameEstate(left: EstateContext, right: EstateContext): boolean {
  return (
    left.id === right.id &&
    sameTenant(left.tenantId, right.tenantId) &&
    left.environment === right.environment
  )
}

function sameSubject(
  evidence: EmployeeEntitlementEvidence['subject'],
  expected: EmployeeEntitlementRequest['subject'],
): boolean {
  return (
    evidence.kind === expected.kind &&
    sameTenant(evidence.tenantId, expected.tenantId) &&
    evidence.objectId.toLowerCase() === expected.objectId.toLowerCase()
  )
}

function referenceKey(reference: EmployeeAgentReference): string {
  return JSON.stringify([
    reference.authority,
    reference.sourceConnectorId,
    reference.sourceTenantId.toLowerCase(),
    reference.sourceEnvironment,
    reference.providerPackageId,
  ])
}

function catalogEntry(node: EstateSnapshot['nodes'][number]): EmployeeAgentCatalogEntry {
  return {
    id: node.id,
    name: node.name,
    description: node.description,
    ...(node.metadata['platform'] === undefined ? {} : { platform: node.metadata['platform'] }),
    ...(node.metadata['version'] === undefined ? {} : { version: node.metadata['version'] }),
  }
}

function mockCatalog(snapshot: EstateSnapshot): EmployeeAgentCatalogResponse {
  return {
    status: 'mock',
    synthetic: true,
    agents: snapshot.nodes
      .filter((node) => node.kind === 'agent')
      .map(catalogEntry)
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
  }
}

export async function resolveEmployeeAgentCatalog(
  options: EmployeeCatalogRouteOptions & {
    estate: EstateContext
    principal?: AuthPrincipal
  },
): Promise<EmployeeAgentCatalogResponse> {
  if (options.authConfig.mode !== 'jwt') {
    if (options.dataMode !== 'mock') {
      return emptyFailure('unavailable', 'principal-identifier-unavailable')
    }
    try {
      return mockCatalog(await options.loadSnapshot(options.estate))
    } catch {
      return emptyFailure('unavailable', 'inventory-evidence-unavailable')
    }
  }

  const principal = options.principal
  if (principal?.actorType !== 'user' || principal.objectId === undefined) {
    return emptyFailure('unknown', 'principal-identifier-unavailable')
  }
  const subjectResult = employeeEntitlementSubjectSchema.safeParse({
    kind: 'microsoft-entra-object-id',
    tenantId: principal.tenantId,
    objectId: principal.objectId,
  })
  if (!subjectResult.success) {
    return emptyFailure('unknown', 'principal-identifier-unavailable')
  }
  if (options.entitlementResolver === undefined) {
    return emptyFailure('unavailable', 'evidence-source-unconfigured')
  }

  let rawEvidence: unknown
  try {
    rawEvidence = await options.entitlementResolver({
      estate: options.estate,
      subject: subjectResult.data,
    })
  } catch {
    return emptyFailure('unavailable', 'evidence-source-unavailable')
  }
  const parsedEvidence = employeeEntitlementEvidenceSchema.safeParse(rawEvidence)
  if (!parsedEvidence.success) return emptyFailure('unknown', 'invalid-evidence')
  const evidence = parsedEvidence.data
  if (
    !sameEstate(evidence.estate, options.estate) ||
    !sameSubject(evidence.subject, subjectResult.data)
  ) {
    return emptyFailure('unknown', 'boundary-mismatch')
  }
  if (evidence.status === 'unavailable') {
    return emptyFailure('unavailable', 'evidence-source-unavailable')
  }
  if (evidence.status === 'unsupported') {
    return emptyFailure('unknown', 'unsupported-evidence')
  }
  if (!evidence.source.authoritative) {
    return emptyFailure('unknown', 'non-authoritative-evidence')
  }
  if (evidence.source.synthetic) return emptyFailure('unknown', 'synthetic-evidence')
  const nowTime = (options.clock ?? (() => new Date()))().getTime()
  const entitlementObservedAt = Date.parse(evidence.source.observedAt)
  const entitlementExpiresAt = Date.parse(evidence.source.expiresAt)
  if (
    !Number.isFinite(nowTime) ||
    !Number.isFinite(entitlementObservedAt) ||
    !Number.isFinite(entitlementExpiresAt) ||
    entitlementObservedAt > nowTime ||
    entitlementExpiresAt <= nowTime
  ) {
    return emptyFailure('unknown', 'stale-evidence')
  }
  if (evidence.source.coverage !== 'complete') {
    return emptyFailure('unknown', 'incomplete-evidence')
  }
  if (
    evidence.decisions.some(
      (decision) =>
        decision.agent.authority !== evidence.source.provider ||
        !sameTenant(decision.agent.sourceTenantId, options.estate.tenantId) ||
        decision.agent.sourceEnvironment !== options.estate.environment,
    )
  ) {
    return emptyFailure('unknown', 'boundary-mismatch')
  }

  const decisions = new Map<string, (typeof evidence.decisions)[number]>()
  for (const decision of evidence.decisions) {
    const key = referenceKey(decision.agent)
    if (decisions.has(key)) return emptyFailure('unknown', 'ambiguous-evidence')
    decisions.set(key, decision)
  }
  const allowed = [...decisions.values()].filter((decision) => decision.decision === 'allowed')
  if (allowed.length === 0) {
    return {
      status: 'denied',
      authority: evidence.source.provider,
      observedAt: evidence.source.observedAt,
      agents: [],
    }
  }

  let snapshot: EstateSnapshot
  try {
    snapshot = await options.loadSnapshot(options.estate)
  } catch {
    return emptyFailure('unknown', 'inventory-evidence-unavailable')
  }
  if (
    !sameTenant(snapshot.tenantId, options.estate.tenantId) ||
    snapshot.environment !== options.estate.environment
  ) {
    return emptyFailure('unknown', 'boundary-mismatch')
  }

  if (
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    Date.parse(snapshot.generatedAt) > nowTime
  ) {
    return emptyFailure('unknown', 'inventory-evidence-unavailable')
  }

  const inventory = new Map<string, EstateSnapshot['nodes']>()
  for (const node of snapshot.nodes) {
    const binding = authoritativeAgent365CatalogBinding(snapshot, node, options.estate)
    if (binding === undefined) continue
    if (
      !Number.isFinite(Date.parse(binding.observedAt)) ||
      Date.parse(binding.observedAt) > nowTime
    ) {
      continue
    }
    const key = referenceKey(binding)
    const matches = inventory.get(key) ?? []
    matches.push(node)
    inventory.set(key, matches)
  }

  const entitled: EmployeeAgentCatalogEntry[] = []
  for (const decision of allowed) {
    const matches = inventory.get(referenceKey(decision.agent))
    if (matches?.length !== 1) {
      return emptyFailure('unknown', 'inventory-evidence-unavailable')
    }
    entitled.push(catalogEntry(matches[0]!))
  }
  entitled.sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )

  return {
    status: 'available',
    authority: evidence.source.provider,
    observedAt: evidence.source.observedAt,
    agents: entitled,
  }
}

export function registerEmployeeCatalogRoutes(
  app: FastifyInstance,
  options: EmployeeCatalogRouteOptions,
): void {
  app.get(
    '/api/employee/agent-catalog',
    { preHandler: requireCapability(options.authConfig, 'read') },
    async (request) => {
      const estate = requireEstateContext(request)
      const result = employeeAgentCatalogResponseSchema.safeParse(
        await resolveEmployeeAgentCatalog({
          ...options,
          estate,
          ...(request.authPrincipal === undefined ? {} : { principal: request.authPrincipal }),
        }),
      )
      return result.success ? result.data : emptyFailure('unknown', 'invalid-evidence')
    },
  )
}
