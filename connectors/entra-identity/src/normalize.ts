import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphEdge,
  type GraphNode,
} from '@agent-sentinel/domain'

import type {
  AgentIdentityPreview,
  EntraAppRoleAssignment,
  EntraDirectoryOwner,
  EntraIdentityConnectorConfig,
  EntraServicePrincipal,
} from './schemas.js'

export interface EntraInventory {
  servicePrincipals: readonly EntraServicePrincipal[]
  owners: ReadonlyMap<string, readonly EntraDirectoryOwner[]>
  appRoleAssignments: ReadonlyMap<string, readonly EntraAppRoleAssignment[]>
  agentIdentitiesPreview: readonly AgentIdentityPreview[]
}

export type EntraCoverageStatus =
  | 'available'
  | 'degraded'
  | 'disabled'
  | 'authorization-required'
  | 'unavailable'
  | 'unknown'

export interface EntraCapabilityCoverage {
  status: EntraCoverageStatus
  covered: number
  total: number
  evidenceIds: readonly string[]
  diagnosticReferences: readonly string[]
}

export interface EntraCorrelationCoverageSummary {
  authoritativeAgentsConsidered: number
  exactObjectIdMatches: number
  exactAppClientIdMatches: number
  exactAgentIdentityMatches: number
  unmatched: number
  ambiguous: number
  runsAsEdgesEmitted: number
  ownerCoverage: EntraCapabilityCoverage
  appRoleCoverage: EntraCapabilityCoverage
  previewCoverage: EntraCapabilityCoverage
  evidenceIds: readonly string[]
  diagnosticReferences: readonly string[]
}

export interface EntraCompositionResult {
  snapshot: EstateSnapshot
  coverage: EntraCorrelationCoverageSummary
}

function principalNodeId(id: string): string {
  return `entra-service-principal-${id}`
}

function principalEvidenceId(id: string): string {
  return `entra-service-principal-evidence-${id}`
}

function compactMetadata(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function ownerLabel(owner: EntraDirectoryOwner): string {
  return owner.displayName ?? owner.userPrincipalName ?? owner.id
}

export function mapEntraInventoryToSnapshot(
  inventory: EntraInventory,
  config: Pick<EntraIdentityConnectorConfig, 'tenantId' | 'environment'>,
  observedAt = new Date().toISOString(),
): EstateSnapshot {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const evidence: Evidence[] = []
  const nodesByObjectId = new Map<string, GraphNode>()

  for (const principal of [...inventory.servicePrincipals].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const principalOwners = [...(inventory.owners.get(principal.id) ?? [])].sort((left, right) =>
      left.id.localeCompare(right.id),
    )
    const evidenceId = principalEvidenceId(principal.id)
    const node: GraphNode = {
      id: principalNodeId(principal.id),
      kind: 'identity',
      name: principal.displayName,
      description: principal.description ?? 'Microsoft Entra service principal.',
      environment: config.environment,
      ...(principalOwners.length > 0 ? { owner: principalOwners.map(ownerLabel).join(', ') } : {}),
      trust: principal.accountEnabled === true ? 'trusted' : 'conditional',
      evidenceIds: [evidenceId],
      metadata: compactMetadata({
        platform: 'Microsoft Entra ID',
        sourceOfTruth: 'true',
        principalType:
          principal.servicePrincipalType === 'ManagedIdentity'
            ? 'managed-identity'
            : 'service-principal',
        directoryObjectId: principal.id,
        applicationId: principal.appId,
        servicePrincipalType: principal.servicePrincipalType ?? undefined,
        accountEnabled:
          principal.accountEnabled === null || principal.accountEnabled === undefined
            ? undefined
            : String(principal.accountEnabled),
        appOwnerOrganizationId: principal.appOwnerOrganizationId ?? undefined,
        ownerObjectIds:
          principalOwners.length > 0
            ? principalOwners.map((owner) => owner.id).join(',')
            : undefined,
        ownerObjectTypes:
          principalOwners.length > 0
            ? principalOwners.map((owner) => owner['@odata.type'] ?? 'unknown').join(',')
            : undefined,
        correlationStatus: 'uncorrelated',
      }),
    }
    nodes.push(node)
    nodesByObjectId.set(principal.id.toLowerCase(), node)
    evidence.push({
      id: evidenceId,
      source: 'Microsoft Entra ID (Microsoft Graph v1.0)',
      sourceObjectId: principal.id,
      observedAt,
      freshness: 'live',
      confidence: 1,
      evidenceTypes: ['declared_configuration'],
      summary:
        principalOwners.length === 0
          ? `Authoritative service-principal inventory record for ${principal.displayName}.`
          : `Authoritative service-principal inventory record for ${principal.displayName} with ${principalOwners.length} owner record(s).`,
    })
  }

  for (const [principalId, assignments] of [...inventory.appRoleAssignments.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const source = nodesByObjectId.get(principalId.toLowerCase())
    if (source === undefined) continue
    for (const assignment of [...assignments].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const assignmentEvidenceId = `entra-app-role-evidence-${assignment.id}`
      let target = nodesByObjectId.get(assignment.resourceId.toLowerCase())
      if (target === undefined) {
        target = {
          id: principalNodeId(assignment.resourceId),
          kind: 'identity',
          name: assignment.resourceDisplayName ?? assignment.resourceId,
          description:
            'Microsoft Entra resource service principal referenced by an app-role assignment.',
          environment: config.environment,
          trust: 'conditional',
          evidenceIds: [assignmentEvidenceId],
          metadata: {
            platform: 'Microsoft Entra ID',
            sourceOfTruth: 'true',
            principalType: 'service-principal',
            directoryObjectId: assignment.resourceId,
            correlationStatus: 'uncorrelated',
            inventoryCoverage: 'assignment-reference-only',
          },
        }
        nodes.push(target)
        nodesByObjectId.set(assignment.resourceId.toLowerCase(), target)
      }
      evidence.push({
        id: assignmentEvidenceId,
        source: 'Microsoft Entra ID app-role assignments (Microsoft Graph v1.0)',
        sourceObjectId: assignment.id,
        observedAt,
        freshness: 'live',
        confidence: 1,
        evidenceTypes: ['declared_configuration'],
        summary: `Authoritative app-role assignment ${assignment.appRoleId} from ${principalId} to resource ${assignment.resourceId}.`,
      })
      edges.push({
        id: `entra-app-role-${assignment.id}`,
        from: source.id,
        to: target.id,
        relationship: 'CAN_CALL',
        evidenceIds: [assignmentEvidenceId],
        active: true,
        removable: false,
      })
    }
  }

  for (const preview of [...inventory.agentIdentitiesPreview].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const previewEvidenceId = `entra-agent-identity-preview-evidence-${preview.id}`
    let node = nodesByObjectId.get(preview.id.toLowerCase())
    evidence.push({
      id: previewEvidenceId,
      source: 'Microsoft Entra Agent ID preview (Microsoft Graph beta)',
      sourceObjectId: preview.id,
      observedAt,
      freshness: 'live',
      confidence: 0.9,
      evidenceTypes: ['declared_configuration'],
      summary: `Preview Agent Identity classification for ${preview.displayName}; beta API evidence is isolated from stable inventory.`,
    })
    if (node === undefined) {
      node = {
        id: principalNodeId(preview.id),
        kind: 'identity',
        name: preview.displayName,
        description:
          'Microsoft Entra Agent Identity observed through an optional preview endpoint.',
        environment: config.environment,
        trust: preview.accountEnabled === true ? 'trusted' : 'conditional',
        evidenceIds: [previewEvidenceId],
        metadata: {
          platform: 'Microsoft Entra Agent ID preview',
          sourceOfTruth: 'true',
          principalType: 'service-principal',
          directoryObjectId: preview.id,
          applicationId: preview.appId,
          agentIdentityPreview: 'true',
          correlationStatus: 'uncorrelated',
        },
      }
      nodes.push(node)
      nodesByObjectId.set(preview.id.toLowerCase(), node)
    } else {
      node.evidenceIds.push(previewEvidenceId)
      node.metadata = {
        ...node.metadata,
        agentIdentityPreview: 'true',
        ...(preview.agentIdentityBlueprintId
          ? { agentIdentityBlueprintId: preview.agentIdentityBlueprintId }
          : {}),
        ...(preview.managerApplications
          ? { managerApplicationIds: preview.managerApplications.join(',') }
          : {}),
      }
    }
  }

  return assertEstateSnapshot({
    tenantId: config.tenantId,
    environment: config.environment,
    generatedAt: observedAt,
    nodes,
    edges,
    evidence,
  })
}

const DIRECTORY_ID_KEYS = [
  'entraServicePrincipalId',
  'servicePrincipalId',
  'entraAgentIdentityId',
  'agentIdentityId',
] as const
const APPLICATION_ID_KEYS = ['entraAppId', 'appId', 'entraClientId', 'clientId'] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function composeSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  shouldCorrelate: (agent: GraphNode) => boolean,
  capabilityStatus: Pick<
    EntraCorrelationCoverageSummary,
    'ownerCoverage' | 'appRoleCoverage' | 'previewCoverage'
  > = {
    ownerCoverage: {
      status: 'unknown',
      covered: 0,
      total: 0,
      evidenceIds: [],
      diagnosticReferences: [],
    },
    appRoleCoverage: {
      status: 'unknown',
      covered: 0,
      total: 0,
      evidenceIds: [],
      diagnosticReferences: [],
    },
    previewCoverage: {
      status: 'unknown',
      covered: 0,
      total: 0,
      evidenceIds: [],
      diagnosticReferences: [],
    },
  },
): EntraCompositionResult {
  const distinctById = <T extends { id: string }>(items: readonly T[]): T[] => {
    const sorted = [...items].sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
    return sorted.filter((item, index) => index === 0 || sorted[index - 1]?.id !== item.id)
  }
  const distinctStrings = (items: readonly string[]): string[] => [...new Set(items)].sort()
  const identityNodes = distinctById(identities.nodes).map((node) => ({
    ...node,
    evidenceIds: distinctStrings(node.evidenceIds),
    metadata: { ...node.metadata },
  }))
  const byDirectoryId = new Map<string, GraphNode[]>()
  const byApplicationId = new Map<string, GraphNode[]>()
  for (const node of identityNodes) {
    const directoryId = node.metadata['directoryObjectId']?.toLowerCase()
    const applicationId = node.metadata['applicationId']?.toLowerCase()
    if (directoryId)
      byDirectoryId.set(directoryId, [...(byDirectoryId.get(directoryId) ?? []), node])
    if (applicationId)
      byApplicationId.set(applicationId, [...(byApplicationId.get(applicationId) ?? []), node])
  }

  const baseNodes = distinctById(base.nodes).map((node) => ({
    ...node,
    evidenceIds: distinctStrings(node.evidenceIds),
    metadata: { ...node.metadata },
  }))
  const correlationEdges: GraphEdge[] = []
  let exactObjectIdMatches = 0
  let exactAppClientIdMatches = 0
  let exactAgentIdentityMatches = 0
  let unmatched = 0
  let ambiguous = 0
  const consideredAgents = baseNodes.filter((node) => node.kind === 'agent' && shouldCorrelate(node))
  for (const agent of consideredAgents) {
    const candidates = new Map<string, GraphNode>()
    const objectCandidates = new Map<string, GraphNode>()
    const appCandidates = new Map<string, GraphNode>()
    const agentIdentityCandidates = new Map<string, GraphNode>()
    for (const key of DIRECTORY_ID_KEYS) {
      const value = agent.metadata[key]
      if (value && UUID_PATTERN.test(value)) {
        for (const identity of byDirectoryId.get(value.toLowerCase()) ?? []) {
          if (
            key === 'agentIdentityId' &&
            identity.metadata['agentIdentityPreview'] !== 'true'
          )
            continue
          candidates.set(identity.id, identity)
          if (key === 'agentIdentityId') agentIdentityCandidates.set(identity.id, identity)
          else objectCandidates.set(identity.id, identity)
        }
      }
    }
    for (const key of APPLICATION_ID_KEYS) {
      const value = agent.metadata[key]
      if (value && UUID_PATTERN.test(value)) {
        for (const identity of byApplicationId.get(value.toLowerCase()) ?? []) {
          candidates.set(identity.id, identity)
          appCandidates.set(identity.id, identity)
        }
      }
    }
    if (objectCandidates.size === 1) exactObjectIdMatches += 1
    if (appCandidates.size === 1) exactAppClientIdMatches += 1
    if (agentIdentityCandidates.size === 1) exactAgentIdentityMatches += 1
    if (candidates.size !== 1) {
      if (candidates.size > 1) agent.metadata['entraCorrelationStatus'] = 'conflict'
      if (candidates.size > 1) ambiguous += 1
      else unmatched += 1
      continue
    }
    const identity = [...candidates.values()][0]!
    agent.metadata['entraCorrelationStatus'] = 'correlated-explicit-id'
    agent.metadata['entraIdentityNodeId'] = identity.id
    identity.metadata['correlationStatus'] = 'correlated-explicit-id'
    identity.metadata['correlatedAgentIds'] = distinctStrings([
      ...(identity.metadata['correlatedAgentIds']?.split(',').filter(Boolean) ?? []),
      agent.id,
    ]).join(',')
    correlationEdges.push({
      id: `entra-correlation-${agent.id}-${identity.id}`,
      from: agent.id,
      to: identity.id,
      relationship: 'RUNS_AS',
      evidenceIds: distinctStrings([...agent.evidenceIds, ...identity.evidenceIds]),
      active: true,
      removable: false,
    })
  }

  const nodes = distinctById([...baseNodes, ...identityNodes])
  const edges = distinctById([...base.edges, ...identities.edges, ...correlationEdges]).map(
    (edge) => ({ ...edge, evidenceIds: distinctStrings(edge.evidenceIds) }),
  )
  const evidence = distinctById([...base.evidence, ...identities.evidence])
  const snapshot = assertEstateSnapshot({
    tenantId: base.tenantId,
    environment: base.environment,
    generatedAt:
      new Date(base.generatedAt).getTime() >= new Date(identities.generatedAt).getTime()
        ? base.generatedAt
        : identities.generatedAt,
    nodes,
    edges,
    evidence,
  })
  const identityEvidenceIds = distinctStrings(identities.evidence.map((item) => item.id))
  return {
    snapshot,
    coverage: {
      authoritativeAgentsConsidered: consideredAgents.length,
      exactObjectIdMatches,
      exactAppClientIdMatches,
      exactAgentIdentityMatches,
      unmatched,
      ambiguous,
      runsAsEdgesEmitted: correlationEdges.length,
      ...capabilityStatus,
      evidenceIds: identityEvidenceIds,
      diagnosticReferences: [
        ...identityEvidenceIds.slice(0, 100).map((id) => `evidence:${id}`),
      ],
    },
  }
}

export function enrichSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
): EstateSnapshot {
  if (base.tenantId.toLowerCase() !== identities.tenantId.toLowerCase()) {
    throw new Error('Cannot compose connector snapshots from different Microsoft Entra tenants.')
  }
  if (base.environment !== identities.environment) {
    throw new Error('Cannot compose connector snapshots from different environments.')
  }
  return composeSnapshotWithEntra(base, identities, () => true).snapshot
}

export function enrichSnapshotWithEntraDiagnostics(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  capabilityStatus?: Pick<
    EntraCorrelationCoverageSummary,
    'ownerCoverage' | 'appRoleCoverage' | 'previewCoverage'
  >,
): EntraCompositionResult {
  if (base.tenantId.toLowerCase() !== identities.tenantId.toLowerCase()) {
    throw new Error('Cannot compose connector snapshots from different Microsoft Entra tenants.')
  }
  if (base.environment !== identities.environment) {
    throw new Error('Cannot compose connector snapshots from different environments.')
  }
  return composeSnapshotWithEntra(base, identities, () => true, capabilityStatus)
}

export function summarizeEntraCorrelationCoverage(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  shouldCorrelate: (agent: GraphNode) => boolean,
  capabilityStatus?: Pick<
    EntraCorrelationCoverageSummary,
    'ownerCoverage' | 'appRoleCoverage' | 'previewCoverage'
  >,
): EntraCorrelationCoverageSummary {
  return composeSnapshotWithEntra(base, identities, shouldCorrelate, capabilityStatus).coverage
}

export interface EntraAggregateSource {
  id: string
  name: string
  tenantId: string
  environment: string
}

function aggregateScopedId(sourceId: string, id: string): string {
  return `entra-source-${sourceId}--${id}`
}

export function enrichAggregateSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  source: EntraAggregateSource,
): EstateSnapshot {
  if (identities.tenantId.toLowerCase() !== source.tenantId.toLowerCase()) {
    throw new Error('Entra identity snapshot does not match its configured source tenant.')
  }
  if (identities.environment !== source.environment) {
    throw new Error('Entra identity snapshot does not match its configured source environment.')
  }

  const nodeIds = new Map(
    identities.nodes.map((node) => [node.id, aggregateScopedId(source.id, node.id)]),
  )
  const evidenceIds = new Map(
    identities.evidence.map((item) => [item.id, aggregateScopedId(source.id, item.id)]),
  )
  const scopedIdentities = assertEstateSnapshot({
    tenantId: base.tenantId,
    environment: base.environment,
    generatedAt: identities.generatedAt,
    nodes: identities.nodes.map((node) => ({
      ...node,
      id: nodeIds.get(node.id)!,
      evidenceIds: node.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
      metadata: {
        ...node.metadata,
        sourceConnectorId: source.id,
        sourceConnectorName: source.name,
        sourceTenantId: source.tenantId,
        sourceEnvironment: source.environment,
      },
    })),
    edges: identities.edges.map((edge) => ({
      ...edge,
      id: aggregateScopedId(source.id, edge.id),
      from: nodeIds.get(edge.from) ?? edge.from,
      to: nodeIds.get(edge.to) ?? edge.to,
      evidenceIds: edge.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
    })),
    evidence: identities.evidence.map((item) => ({
      ...item,
      id: evidenceIds.get(item.id)!,
      source: `${item.source} · ${source.name}`,
      sourceObjectId: `${source.id}:${item.sourceObjectId}`,
      metadata: {
        ...item.metadata,
        sourceConnectorId: source.id,
        sourceConnectorName: source.name,
        sourceTenantId: source.tenantId,
        sourceEnvironment: source.environment,
      },
    })),
  })

  return composeSnapshotWithEntra(
    base,
    scopedIdentities,
    (agent) =>
      agent.metadata['sourceTenantId']?.toLowerCase() === source.tenantId.toLowerCase() &&
      agent.metadata['sourceEnvironment'] === source.environment,
  ).snapshot
}
