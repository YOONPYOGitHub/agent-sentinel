import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type EvidenceAuthority,
  type GraphEdge,
  type GraphNode,
} from '@agent-sentinel/domain'
import type { ExactIdentityCorrelationDiagnostics } from '@agent-sentinel/connector-sdk'

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

function assertUniqueIds<T extends { id: string }>(
  items: readonly T[],
  label: 'graph node' | 'graph edge' | 'evidence',
): void {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`Entra normalization rejects duplicate ${label} ID: ${item.id}`)
    }
    ids.add(item.id)
  }
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
  assertUniqueIds(
    inventory.servicePrincipals.map((principal) => ({
      id: principalNodeId(principal.id.toLowerCase()),
    })),
    'graph node',
  )

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

  assertUniqueIds(nodes, 'graph node')
  assertUniqueIds(edges, 'graph edge')
  assertUniqueIds(evidence, 'evidence')
  return assertEstateSnapshot({
    tenantId: config.tenantId,
    environment: config.environment,
    generatedAt: observedAt,
    nodes,
    edges,
    evidence,
  })
}

const DIRECTORY_ID_KEYS = ['entraServicePrincipalId', 'servicePrincipalId', 'objectId'] as const
const APPLICATION_ID_KEYS = ['entraAppId', 'appId', 'entraClientId', 'clientId'] as const
const AGENT_IDENTITY_ID_KEYS = ['entraAgentIdentityId', 'agentIdentityId'] as const
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type EntraCorrelationDiagnostics = Omit<
  ExactIdentityCorrelationDiagnostics,
  'ownerCoverage' | 'appRoleCoverage' | 'previewCoverage'
>

export interface EntraCompositionResult {
  snapshot: EstateSnapshot
  diagnostics: EntraCorrelationDiagnostics
}

export interface RunsAsSourceEndpoint {
  sourceId: string
  tenantId: string
  environment: string
  provider: 'azure-ai-foundry-agent-service' | 'microsoft-entra'
  sourceObjectId: string
}

export interface EntraFoundryRunsAsBinding {
  estateId: string
  foundry: RunsAsSourceEndpoint & { provider: 'azure-ai-foundry-agent-service' }
  entra: RunsAsSourceEndpoint & { provider: 'microsoft-entra' }
}

function sameAuthority(left: EvidenceAuthority, right: EvidenceAuthority): boolean {
  const sameSourceObjectId =
    left.provider === 'microsoft-entra'
      ? left.sourceObjectId.toLowerCase() === right.sourceObjectId.toLowerCase()
      : left.sourceObjectId === right.sourceObjectId
  const sameProviderObjectId =
    left.provider === 'microsoft-entra'
      ? left.providerObjectId.toLowerCase() === right.providerObjectId.toLowerCase()
      : left.providerObjectId === right.providerObjectId
  return (
    left.estateId === right.estateId &&
    left.sourceId === right.sourceId &&
    left.tenantId.toLowerCase() === right.tenantId.toLowerCase() &&
    left.environment === right.environment &&
    left.provider === right.provider &&
    sameSourceObjectId &&
    sameProviderObjectId &&
    left.snapshotGeneratedAt === right.snapshotGeneratedAt &&
    left.sourceRelease === right.sourceRelease
  )
}

function exactAuthorityEvidence(
  node: GraphNode,
  evidenceById: ReadonlyMap<string, Evidence>,
  estateId: string,
  endpoint: RunsAsSourceEndpoint,
): Evidence[] {
  if (
    node.metadata['sourceOfTruth'] !== 'true' ||
    node.metadata['estateId'] !== estateId ||
    node.metadata['sourceId'] !== endpoint.sourceId ||
    node.metadata['sourceTenantId']?.toLowerCase() !== endpoint.tenantId.toLowerCase() ||
    node.metadata['sourceEnvironment'] !== endpoint.environment ||
    node.metadata['provider'] !== endpoint.provider ||
    (endpoint.provider === 'azure-ai-foundry-agent-service'
      ? node.metadata['sourceProjectId'] !== endpoint.sourceObjectId
      : node.metadata['sourceInventoryObjectId']?.toLowerCase() !==
        endpoint.sourceObjectId.toLowerCase())
  ) {
    return []
  }
  const providerObjectId = node.metadata['providerObjectId']
  const snapshotGeneratedAt = node.metadata['snapshotGeneratedAt']
  const sourceRelease = node.metadata['sourceRelease']
  if (
    providerObjectId === undefined ||
    snapshotGeneratedAt === undefined ||
    sourceRelease === undefined
  ) {
    return []
  }
  const expected: EvidenceAuthority = {
    estateId,
    sourceId: endpoint.sourceId,
    tenantId: endpoint.tenantId,
    environment: endpoint.environment,
    provider: endpoint.provider,
    sourceObjectId: endpoint.sourceObjectId,
    providerObjectId,
    snapshotGeneratedAt,
    sourceRelease,
  }
  return node.evidenceIds.flatMap((evidenceId) => {
    const evidence = evidenceById.get(evidenceId)
    if (
      evidence?.authority === undefined ||
      !sameAuthority(evidence.authority, expected) ||
      evidence.freshness === 'stale' ||
      evidence.confidence < 0.8 ||
      evidence.evidenceTypes.includes('synthetic_validation') ||
      evidence.evidenceTypes.includes('unknown') ||
      !evidence.evidenceTypes.includes('declared_configuration')
    ) {
      return []
    }
    return [evidence]
  })
}

function composeSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  bindingForAgent: (agent: GraphNode) => EntraFoundryRunsAsBinding | undefined,
  source: EntraAggregateSource,
): EntraCompositionResult {
  const sortedById = <T extends { id: string }>(items: readonly T[]): T[] =>
    [...items].sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
    )
  const distinctStrings = (items: readonly string[]): string[] => [...new Set(items)].sort()
  assertUniqueIds(base.nodes, 'graph node')
  assertUniqueIds(base.edges, 'graph edge')
  assertUniqueIds(base.evidence, 'evidence')
  assertUniqueIds(identities.nodes, 'graph node')
  assertUniqueIds(identities.edges, 'graph edge')
  assertUniqueIds(identities.evidence, 'evidence')
  assertUniqueIds([...base.nodes, ...identities.nodes], 'graph node')
  assertUniqueIds([...base.edges, ...identities.edges], 'graph edge')
  assertUniqueIds([...base.evidence, ...identities.evidence], 'evidence')
  const identityRecords = identities.nodes.map((node) => ({
    ...node,
    evidenceIds: distinctStrings(node.evidenceIds),
    metadata: { ...node.metadata },
  }))
  const identityNodes = sortedById(identityRecords)
  const identityNodeById = new Map(identityNodes.map((node) => [node.id, node]))
  const evidenceById = new Map(
    [...base.evidence, ...identities.evidence].map((evidence) => [evidence.id, evidence]),
  )
  const byDirectoryId = new Map<string, GraphNode[]>()
  const byApplicationId = new Map<string, GraphNode[]>()
  const byAgentIdentityId = new Map<string, GraphNode[]>()
  for (const record of identityRecords) {
    const node = identityNodeById.get(record.id)!
    const directoryId = record.metadata['directoryObjectId']?.toLowerCase()
    const applicationId = record.metadata['applicationId']?.toLowerCase()
    if (directoryId)
      byDirectoryId.set(directoryId, [...(byDirectoryId.get(directoryId) ?? []), node])
    if (applicationId)
      byApplicationId.set(applicationId, [...(byApplicationId.get(applicationId) ?? []), node])
    if (directoryId && record.metadata['agentIdentityPreview'] === 'true') {
      byAgentIdentityId.set(directoryId, [...(byAgentIdentityId.get(directoryId) ?? []), node])
    }
  }
  const duplicateDirectoryIds = new Set(
    [...byDirectoryId.entries()]
      .filter(([, nodes]) => nodes.length > 1)
      .map(([directoryId]) => directoryId),
  )

  const baseNodes = sortedById(base.nodes).map((node) => ({
    ...node,
    evidenceIds: distinctStrings(node.evidenceIds),
    metadata: { ...node.metadata },
  }))
  const correlationEdges: GraphEdge[] = []
  let authoritativeAgentsConsidered = 0
  let exactObjectIdMatches = 0
  let exactApplicationIdMatches = 0
  let exactAgentIdentityMatches = 0
  let unmatched = 0
  let ambiguous = 0
  const diagnosticEvidenceIds = new Set<string>()
  for (const agent of baseNodes.filter((node) => node.kind === 'agent')) {
    const sourceBinding = bindingForAgent(agent)
    if (sourceBinding === undefined) continue
    authoritativeAgentsConsidered += 1
    for (const evidenceId of agent.evidenceIds) diagnosticEvidenceIds.add(evidenceId)
    const agentAuthorityEvidence = exactAuthorityEvidence(
      agent,
      evidenceById,
      sourceBinding.estateId,
      sourceBinding.foundry,
    )
    if (agentAuthorityEvidence.length !== 1) {
      unmatched += 1
      agent.metadata['entraCorrelationStatus'] = 'unmatched'
      agent.metadata['entraCorrelationReason'] =
        agentAuthorityEvidence.length === 0
          ? 'insufficient-authoritative-evidence'
          : 'ambiguous-authoritative-evidence'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    const candidates = new Map<
      string,
      { identity: GraphNode; kinds: Set<'object-id' | 'application-id' | 'agent-identity-id'> }
    >()
    let suppliedIdentifiers = 0
    let malformedIdentifiers = 0
    let unresolvedIdentifiers = 0
    let multiplyResolvedIdentifiers = 0
    let duplicateObjectIdResolved = false
    const resolveIdentifiers = (
      keys: readonly string[],
      index: ReadonlyMap<string, GraphNode[]>,
      kind: 'object-id' | 'application-id' | 'agent-identity-id',
    ): void => {
      for (const key of keys) {
        const value = agent.metadata[key]
        if (!value) continue
        suppliedIdentifiers += 1
        if (!UUID_PATTERN.test(value)) {
          malformedIdentifiers += 1
          continue
        }
        const identitiesForIdentifier = index.get(value.toLowerCase()) ?? []
        if (identitiesForIdentifier.length === 0) {
          unresolvedIdentifiers += 1
          continue
        }
        if (identitiesForIdentifier.length > 1) multiplyResolvedIdentifiers += 1
        for (const identity of identitiesForIdentifier) {
          const directoryId = identity.metadata['directoryObjectId']?.toLowerCase()
          if (directoryId !== undefined && duplicateDirectoryIds.has(directoryId)) {
            duplicateObjectIdResolved = true
          }
          const candidate = candidates.get(identity.id) ?? { identity, kinds: new Set() }
          candidate.kinds.add(kind)
          candidates.set(identity.id, candidate)
        }
      }
    }
    resolveIdentifiers(DIRECTORY_ID_KEYS, byDirectoryId, 'object-id')
    resolveIdentifiers(APPLICATION_ID_KEYS, byApplicationId, 'application-id')
    resolveIdentifiers(AGENT_IDENTITY_ID_KEYS, byAgentIdentityId, 'agent-identity-id')
    for (const { identity } of candidates.values()) {
      for (const evidenceId of identity.evidenceIds) diagnosticEvidenceIds.add(evidenceId)
    }
    if (duplicateObjectIdResolved) {
      ambiguous += 1
      agent.metadata['entraCorrelationStatus'] = 'ambiguous'
      agent.metadata['entraCorrelationReason'] = 'duplicate-authoritative-object-id'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    if (
      suppliedIdentifiers === 0 ||
      malformedIdentifiers > 0 ||
      (unresolvedIdentifiers > 0 && candidates.size === 0)
    ) {
      unmatched += 1
      agent.metadata['entraCorrelationStatus'] = 'unmatched'
      agent.metadata['entraCorrelationReason'] =
        suppliedIdentifiers === 0
          ? 'missing-authoritative-identifier'
          : malformedIdentifiers > 0
            ? 'malformed-authoritative-identifier'
            : 'no-exact-source-match'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    if (unresolvedIdentifiers > 0 || multiplyResolvedIdentifiers > 0 || candidates.size > 1) {
      ambiguous += 1
      agent.metadata['entraCorrelationStatus'] = 'ambiguous'
      agent.metadata['entraCorrelationReason'] =
        multiplyResolvedIdentifiers > 0
          ? 'multiple-exact-source-matches'
          : candidates.size > 1
            ? 'conflicting-exact-source-matches'
            : 'incomplete-exact-source-match'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    const candidate = [...candidates.values()][0]!
    const identity = candidate.identity
    if (
      candidate.kinds.has('application-id') &&
      !candidate.kinds.has('object-id') &&
      !candidate.kinds.has('agent-identity-id')
    ) {
      unmatched += 1
      agent.metadata['entraCorrelationStatus'] = 'unmatched'
      agent.metadata['entraCorrelationReason'] = 'application-id-authority-unavailable'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    const identityAuthorityEvidence = exactAuthorityEvidence(
      identity,
      evidenceById,
      sourceBinding.estateId,
      sourceBinding.entra,
    )
    if (identityAuthorityEvidence.length !== 1) {
      unmatched += 1
      agent.metadata['entraCorrelationStatus'] = 'unmatched'
      agent.metadata['entraCorrelationReason'] =
        identityAuthorityEvidence.length === 0
          ? 'insufficient-authoritative-evidence'
          : 'ambiguous-authoritative-evidence'
      delete agent.metadata['entraCorrelationMatchKind']
      delete agent.metadata['entraIdentityNodeId']
      continue
    }
    const matchKind = candidate.kinds.has('agent-identity-id')
      ? 'agent-identity-id'
      : candidate.kinds.has('object-id')
        ? 'object-id'
        : 'application-id'
    if (matchKind === 'agent-identity-id') exactAgentIdentityMatches += 1
    else if (matchKind === 'object-id') exactObjectIdMatches += 1
    else exactApplicationIdMatches += 1
    agent.metadata['entraCorrelationStatus'] = 'matched'
    agent.metadata['entraCorrelationMatchKind'] = matchKind
    delete agent.metadata['entraCorrelationReason']
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
      evidenceIds: [agentAuthorityEvidence[0]!.id, identityAuthorityEvidence[0]!.id],
      active: true,
      removable: false,
      runsAsBinding: {
        agent: agentAuthorityEvidence[0]!.authority!,
        identity: identityAuthorityEvidence[0]!.authority!,
        identifier: {
          kind: matchKind,
          value:
            matchKind === 'agent-identity-id'
              ? (agent.metadata['entraAgentIdentityId'] ?? agent.metadata['agentIdentityId']!)
              : matchKind === 'object-id'
                ? (agent.metadata['entraServicePrincipalId'] ??
                  agent.metadata['servicePrincipalId'] ??
                  agent.metadata['objectId']!)
                : (agent.metadata['entraAppId'] ??
                  agent.metadata['appId'] ??
                  agent.metadata['entraClientId'] ??
                  agent.metadata['clientId']!),
        },
      },
    })
  }

  const nodes = sortedById([...baseNodes, ...identityNodes])
  const edges = sortedById([...base.edges, ...identities.edges, ...correlationEdges]).map(
    (edge) => ({ ...edge, evidenceIds: distinctStrings(edge.evidenceIds) }),
  )
  const evidence = sortedById([...base.evidence, ...identities.evidence])
  return {
    snapshot: assertEstateSnapshot({
      tenantId: base.tenantId,
      environment: base.environment,
      generatedAt:
        new Date(base.generatedAt).getTime() >= new Date(identities.generatedAt).getTime()
          ? base.generatedAt
          : identities.generatedAt,
      nodes,
      edges,
      evidence,
    }),
    diagnostics: {
      kind: 'exact-identity-correlation',
      provider: 'microsoft-entra',
      sourceId: source.id,
      sourceTenantId: source.tenantId,
      sourceEnvironment: source.environment,
      authoritativeAgentsConsidered,
      exactObjectIdMatches,
      exactApplicationIdMatches,
      exactAgentIdentityMatches,
      unmatched,
      ambiguous,
      runsAsEdgesEmitted: correlationEdges.length,
      evidenceReferences: [...diagnosticEvidenceIds].sort(),
    },
  }
}

export function enrichSnapshotWithEntraAndDiagnostics(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  binding?: EntraFoundryRunsAsBinding,
): EntraCompositionResult {
  if (binding !== undefined) {
    return enrichAggregateSnapshotWithExactEntraBindingsAndDiagnostics(
      base,
      identities,
      {
        id: binding.entra.sourceId.slice('entra:'.length),
        name: 'Explicit Microsoft Entra inventory',
        tenantId: binding.entra.tenantId,
        environment: binding.entra.environment,
      },
      [binding],
      binding.estateId,
    )
  }
  if (base.tenantId.toLowerCase() !== identities.tenantId.toLowerCase()) {
    throw new Error('Cannot compose connector snapshots from different Microsoft Entra tenants.')
  }
  if (base.environment !== identities.environment) {
    throw new Error('Cannot compose connector snapshots from different environments.')
  }
  return composeSnapshotWithEntra(base, identities, () => undefined, {
    id: 'primary',
    name: 'Primary source',
    tenantId: identities.tenantId,
    environment: identities.environment,
  })
}

export function enrichSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  binding?: EntraFoundryRunsAsBinding,
): EstateSnapshot {
  return enrichSnapshotWithEntraAndDiagnostics(base, identities, binding).snapshot
}

export interface EntraAggregateSource {
  id: string
  name: string
  tenantId: string
  environment: string
  projectId?: string
}

function aggregateScopedId(sourceId: string, id: string): string {
  return `entra-source-${sourceId}--${id}`
}

export function enrichAggregateSnapshotWithEntraAndDiagnostics(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  source: EntraAggregateSource,
): EntraCompositionResult {
  assertUniqueIds(base.nodes, 'graph node')
  assertUniqueIds(base.evidence, 'evidence')
  assertUniqueIds(identities.nodes, 'graph node')
  assertUniqueIds(identities.evidence, 'evidence')
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

  return composeSnapshotWithEntra(base, scopedIdentities, () => undefined, source)
}

export function enrichAggregateSnapshotWithExactEntraBindingsAndDiagnostics(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  source: EntraAggregateSource,
  bindings: readonly EntraFoundryRunsAsBinding[],
  estateIdInput?: string,
): EntraCompositionResult {
  assertUniqueIds(base.nodes, 'graph node')
  assertUniqueIds(base.evidence, 'evidence')
  assertUniqueIds(identities.nodes, 'graph node')
  assertUniqueIds(identities.evidence, 'evidence')
  if (identities.tenantId.toLowerCase() !== source.tenantId.toLowerCase()) {
    throw new Error('Entra identity snapshot does not match its configured source tenant.')
  }
  if (identities.environment !== source.environment) {
    throw new Error('Entra identity snapshot does not match its configured source environment.')
  }
  const estateIds = new Set([
    ...bindings.map((binding) => binding.estateId),
    ...(estateIdInput === undefined ? [] : [estateIdInput]),
  ])
  if (estateIds.size !== 1) {
    throw new Error('Exact Entra bindings must belong to one estate.')
  }
  const scopedSourceId = `entra:${source.id}`
  const estateId = [...estateIds][0]
  if (estateId === undefined) {
    throw new Error('Exact Entra composition requires at least one binding.')
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
    nodes: identities.nodes.map((node) => {
      const providerObjectId = node.metadata['directoryObjectId'] ?? node.id
      return {
        ...node,
        id: nodeIds.get(node.id)!,
        evidenceIds: node.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
        metadata: {
          ...node.metadata,
          estateId,
          sourceId: scopedSourceId,
          sourceConnectorId: source.id,
          sourceConnectorName: source.name,
          sourceTenantId: source.tenantId,
          sourceEnvironment: source.environment,
          sourceInventoryObjectId: source.tenantId,
          provider: 'microsoft-entra',
          providerObjectId,
          sourceObjectId: providerObjectId,
          snapshotGeneratedAt: identities.generatedAt,
          sourceRelease: 'v1.0',
        },
      }
    }),
    edges: identities.edges.map((edge) => ({
      ...edge,
      id: aggregateScopedId(source.id, edge.id),
      from: nodeIds.get(edge.from) ?? edge.from,
      to: nodeIds.get(edge.to) ?? edge.to,
      evidenceIds: edge.evidenceIds.map((id) => evidenceIds.get(id) ?? id),
    })),
    evidence: identities.evidence.map((item) => {
      const providerObjectId = item.sourceObjectId
      const isPrincipalEvidence = item.id.startsWith('entra-service-principal-evidence-')
      return {
        ...item,
        id: evidenceIds.get(item.id)!,
        source: `${item.source} · ${source.name}`,
        sourceObjectId: `${source.id}:${item.sourceObjectId}`,
        ...(isPrincipalEvidence
          ? {
              authority: {
                estateId,
                sourceId: scopedSourceId,
                tenantId: source.tenantId,
                environment: source.environment,
                provider: 'microsoft-entra' as const,
                sourceObjectId: source.tenantId,
                providerObjectId,
                snapshotGeneratedAt: identities.generatedAt,
                sourceRelease: 'v1.0',
              },
            }
          : {}),
        metadata: {
          ...item.metadata,
          estateId,
          sourceId: scopedSourceId,
          sourceConnectorId: source.id,
          sourceConnectorName: source.name,
          sourceTenantId: source.tenantId,
          sourceEnvironment: source.environment,
          sourceInventoryObjectId: source.tenantId,
          provider: 'microsoft-entra',
          providerObjectId,
          snapshotGeneratedAt: identities.generatedAt,
          sourceRelease: isPrincipalEvidence ? 'v1.0' : 'supplemental',
        },
      }
    }),
  })
  const bindingByFoundrySource = new Map(
    bindings.map((binding) => [binding.foundry.sourceId, binding]),
  )
  return composeSnapshotWithEntra(
    base,
    scopedIdentities,
    (agent) => bindingByFoundrySource.get(agent.metadata['sourceId'] ?? ''),
    source,
  )
}

export function enrichAggregateSnapshotWithEntra(
  base: EstateSnapshot,
  identities: EstateSnapshot,
  source: EntraAggregateSource,
): EstateSnapshot {
  return enrichAggregateSnapshotWithEntraAndDiagnostics(base, identities, source).snapshot
}
