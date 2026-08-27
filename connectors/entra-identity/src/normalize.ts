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

  for (const principal of inventory.servicePrincipals) {
    const principalOwners = inventory.owners.get(principal.id) ?? []
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
      summary:
        principalOwners.length === 0
          ? `Authoritative service-principal inventory record for ${principal.displayName}.`
          : `Authoritative service-principal inventory record for ${principal.displayName} with ${principalOwners.length} owner record(s).`,
    })
  }

  for (const [principalId, assignments] of inventory.appRoleAssignments) {
    const source = nodesByObjectId.get(principalId.toLowerCase())
    if (source === undefined) continue
    for (const assignment of assignments) {
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

  for (const preview of inventory.agentIdentitiesPreview) {
    const previewEvidenceId = `entra-agent-identity-preview-evidence-${preview.id}`
    let node = nodesByObjectId.get(preview.id.toLowerCase())
    evidence.push({
      id: previewEvidenceId,
      source: 'Microsoft Entra Agent ID preview (Microsoft Graph beta)',
      sourceObjectId: preview.id,
      observedAt,
      freshness: 'live',
      confidence: 0.9,
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

  const identityNodes = identities.nodes.map((node) => ({
    ...node,
    evidenceIds: [...node.evidenceIds],
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

  const baseNodes = base.nodes.map((node) => ({
    ...node,
    evidenceIds: [...node.evidenceIds],
    metadata: { ...node.metadata },
  }))
  const correlationEdges: GraphEdge[] = []
  for (const agent of baseNodes.filter((node) => node.kind === 'agent')) {
    const candidates = new Map<string, GraphNode>()
    for (const key of DIRECTORY_ID_KEYS) {
      const value = agent.metadata[key]
      if (value && UUID_PATTERN.test(value)) {
        for (const identity of byDirectoryId.get(value.toLowerCase()) ?? []) {
          candidates.set(identity.id, identity)
        }
      }
    }
    for (const key of APPLICATION_ID_KEYS) {
      const value = agent.metadata[key]
      if (value && UUID_PATTERN.test(value)) {
        for (const identity of byApplicationId.get(value.toLowerCase()) ?? []) {
          candidates.set(identity.id, identity)
        }
      }
    }
    if (candidates.size !== 1) {
      if (candidates.size > 1) agent.metadata['entraCorrelationStatus'] = 'conflict'
      continue
    }
    const identity = [...candidates.values()][0]!
    agent.metadata['entraCorrelationStatus'] = 'correlated-explicit-id'
    agent.metadata['entraIdentityNodeId'] = identity.id
    identity.metadata['correlationStatus'] = 'correlated-explicit-id'
    identity.metadata['correlatedAgentIds'] = [
      ...(identity.metadata['correlatedAgentIds']?.split(',').filter(Boolean) ?? []),
      agent.id,
    ].join(',')
    correlationEdges.push({
      id: `entra-correlation-${agent.id}-${identity.id}`,
      from: agent.id,
      to: identity.id,
      relationship: 'RUNS_AS',
      evidenceIds: [...new Set([...agent.evidenceIds, ...identity.evidenceIds])],
      active: true,
      removable: false,
    })
  }

  return assertEstateSnapshot({
    tenantId: base.tenantId,
    environment: base.environment,
    generatedAt:
      new Date(base.generatedAt).getTime() >= new Date(identities.generatedAt).getTime()
        ? base.generatedAt
        : identities.generatedAt,
    nodes: [...baseNodes, ...identityNodes],
    edges: [...base.edges, ...identities.edges, ...correlationEdges],
    evidence: [...base.evidence, ...identities.evidence],
  })
}
