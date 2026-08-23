import {
  ADAPTER_DEFAULT_CONFIDENCE,
  ADAPTER_MAX_DECLARED_CONFIDENCE,
  computeManifestHash,
  manifestProvenance,
  normalizeManifestRelationship,
  stableId,
  type AdapterCapabilityDeclaration,
  type AgentDeclaration,
  type DataSourceDeclaration,
  type EvidenceDeclaration,
  type IdentityDeclaration,
  type ManifestEntityKind,
  type ManifestEnvelope,
  type ManifestEvidenceType,
  type MCPDependencyDeclaration,
  type SourceProvenance,
  type ToolDeclaration,
} from '@agent-sentinel/connector-sdk'
import {
  assertEstateSnapshot,
  type EstateSnapshot,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from '@agent-sentinel/domain'

/** Provenance marker written onto every node this adapter produces. */
export const ADAPTER_SOURCE_ID = 'custom-manifest-adapter'

const NODE_KIND_BY_ENTITY_KIND: Readonly<Record<ManifestEntityKind, NodeKind>> = {
  agent: 'agent',
  tool: 'tool',
  identity: 'identity',
  dataSources: 'data',
  mcp: 'mcp',
}

/**
 * Adapter claims are never asserted as trusted. When a manifest omits a trust
 * statement the node is `conditional`: unproven, not safe.
 */
const DEFAULT_TRUST = 'conditional'

type Declaration =
  | { readonly kind: 'agent'; readonly value: AgentDeclaration }
  | { readonly kind: 'tool'; readonly value: ToolDeclaration }
  | { readonly kind: 'identity'; readonly value: IdentityDeclaration }
  | { readonly kind: 'dataSources'; readonly value: DataSourceDeclaration }
  | { readonly kind: 'mcp'; readonly value: MCPDependencyDeclaration }

export interface NormalizeManifestOptions {
  readonly tenantId: string
  readonly environmentId?: string
}

export interface NormalizedManifest {
  readonly snapshot: EstateSnapshot
  readonly provenance: SourceProvenance
  readonly hash: string
}

export interface EffectiveEvidence {
  readonly evidenceType: ManifestEvidenceType
  readonly confidence: number
  readonly freshness: 'live' | 'recent' | 'stale'
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function utc(value: string): string {
  return new Date(value).toISOString()
}

/**
 * Decide what an adapter evidence record is actually worth.
 *
 * Runtime observation survives only when the producer declared runtime
 * telemetry support *and* deep evidence. Anything else is downgraded to
 * declared configuration and capped at the adapter ceiling.
 */
export function effectiveEvidence(
  declaration: Pick<EvidenceDeclaration, 'evidenceType' | 'confidence'>,
  capabilities: AdapterCapabilityDeclaration,
): EffectiveEvidence {
  const runtimeAccepted =
    declaration.evidenceType === 'runtime_observed' &&
    capabilities.supportsRuntimeTelemetry &&
    capabilities.evidenceDepth === 'deep'

  if (runtimeAccepted)
    return {
      evidenceType: 'runtime_observed',
      confidence: clamp(declaration.confidence),
      freshness: 'live',
    }

  return {
    evidenceType: 'declared_configuration',
    confidence: Math.min(clamp(declaration.confidence), ADAPTER_MAX_DECLARED_CONFIDENCE),
    freshness: 'recent',
  }
}

function summaryFor(evidenceType: ManifestEvidenceType, subject: string): string {
  const prefix =
    evidenceType === 'runtime_observed'
      ? 'Runtime observation supplied by the custom manifest adapter'
      : 'Declared configuration supplied by the custom manifest adapter'
  return `${prefix} for ${subject}; non-authoritative and not a source of truth.`
}

function collect(envelope: ManifestEnvelope): Declaration[] {
  return [
    ...envelope.agents.map((value): Declaration => ({ kind: 'agent', value })),
    ...envelope.tools.map((value): Declaration => ({ kind: 'tool', value })),
    ...envelope.identities.map((value): Declaration => ({ kind: 'identity', value })),
    ...envelope.dataSources.map((value): Declaration => ({ kind: 'dataSources', value })),
    ...(envelope.mcpDependencies ?? []).map((value): Declaration => ({ kind: 'mcp', value })),
  ]
}

function typeMetadata(declaration: Declaration): Record<string, string> {
  const extra: Record<string, string> = { entityKind: declaration.kind }
  switch (declaration.kind) {
    case 'agent': {
      const { platform, version, model } = declaration.value
      if (platform !== undefined) extra['platform'] = platform
      if (version !== undefined) extra['version'] = version
      if (model !== undefined) extra['model'] = model
      return extra
    }
    case 'tool': {
      const { toolType } = declaration.value
      if (toolType !== undefined) extra['toolType'] = toolType
      return extra
    }
    case 'identity': {
      const { principalType, permissions } = declaration.value
      if (principalType !== undefined) extra['principalType'] = principalType
      if (permissions !== undefined && permissions.length > 0)
        extra['permissions'] = permissions.join(', ')
      return extra
    }
    case 'dataSources': {
      const { classification } = declaration.value
      if (classification !== undefined) extra['classification'] = classification
      return extra
    }
    case 'mcp': {
      const { endpointRef, approved } = declaration.value
      if (endpointRef !== undefined) extra['endpointRef'] = endpointRef
      if (approved !== undefined) extra['approved'] = String(approved)
      return extra
    }
  }
}

function sensitivityOf(declaration: Declaration): Pick<GraphNode, 'sensitivity'> {
  if (declaration.kind !== 'dataSources') return {}
  const { sensitivity } = declaration.value
  return sensitivity === undefined ? {} : { sensitivity }
}

/**
 * Normalize a validated envelope into an EstateSnapshot.
 *
 * The manifest must already have passed `acceptManifest`. Every identifier is
 * namespaced with the manifest id so two manifests can never collide, and every
 * record is labelled non-authoritative.
 */
export function normalizeManifest(
  envelope: ManifestEnvelope,
  options: NormalizeManifestOptions,
): NormalizedManifest {
  const scope = (localId: string): string =>
    stableId('manifest', `${envelope.manifestId}::${localId}`)
  const environment = options.environmentId ?? envelope.environmentId ?? 'manifest'
  const producerLabel = `${envelope.producer.name} (custom manifest adapter)`
  const declarations = collect(envelope)

  const evidence: Evidence[] = []
  const evidenceIdsBySubject = new Map<string, string[]>()
  const attach = (subjectId: string, evidenceId: string): void => {
    const current = evidenceIdsBySubject.get(subjectId) ?? []
    current.push(evidenceId)
    evidenceIdsBySubject.set(subjectId, current)
  }

  // Baseline evidence: the manifest itself is the observation for every entity.
  for (const declaration of declarations) {
    const entity = declaration.value
    const evidenceId = scope(`evidence::declared::${entity.id}`)
    evidence.push({
      id: evidenceId,
      source: producerLabel,
      sourceObjectId: entity.id,
      observedAt: utc(entity.observedAt ?? envelope.producedAt),
      freshness: 'recent',
      confidence: ADAPTER_DEFAULT_CONFIDENCE,
      summary: summaryFor('declared_configuration', entity.displayName),
    })
    attach(entity.id, evidenceId)
  }

  // Operator-supplied evidence, gated by capability and capped by confidence.
  for (const declaration of envelope.evidence) {
    const resolved = effectiveEvidence(declaration, envelope.capabilities)
    const evidenceId = scope(`evidence::${declaration.id}`)
    evidence.push({
      id: evidenceId,
      source: producerLabel,
      sourceObjectId: declaration.subjectId,
      observedAt: utc(declaration.observedAt),
      freshness: resolved.freshness,
      confidence: resolved.confidence,
      summary: summaryFor(resolved.evidenceType, declaration.subjectId),
    })
    attach(declaration.subjectId, evidenceId)
  }

  const nodes: GraphNode[] = declarations.map((declaration) => {
    const entity = declaration.value
    return {
      id: scope(entity.id),
      kind: NODE_KIND_BY_ENTITY_KIND[declaration.kind],
      name: entity.displayName,
      description:
        entity.description ??
        `Adapter-declared ${declaration.kind} supplied by ${envelope.producer.name}.`,
      environment: entity.environment ?? environment,
      ...(entity.owner !== undefined ? { owner: entity.owner } : {}),
      ...sensitivityOf(declaration),
      trust: entity.trust ?? DEFAULT_TRUST,
      evidenceIds: evidenceIdsBySubject.get(entity.id) ?? [],
      metadata: {
        source: ADAPTER_SOURCE_ID,
        sourceOfTruth: 'false',
        isNonAuthoritative: 'true',
        manifestId: envelope.manifestId,
        producer: envelope.producer.name,
        evidenceDepth: envelope.capabilities.evidenceDepth,
        actionDepth: envelope.capabilities.supportsActions,
        schemaVersion: envelope.schemaVersion,
        ...typeMetadata(declaration),
      },
    }
  })

  const edges: GraphEdge[] = envelope.edges.map((edge, index) => {
    const relationship = normalizeManifestRelationship(edge.relationship)
    if (relationship === undefined)
      throw new Error(`Unsupported relationship ${edge.relationship} survived validation.`)
    const evidenceIds = [
      ...(evidenceIdsBySubject.get(edge.from.id) ?? []),
      ...(evidenceIdsBySubject.get(edge.to.id) ?? []),
    ]
    return {
      id: scope(`edge::${index}::${edge.from.id}::${edge.to.id}`),
      from: scope(edge.from.id),
      to: scope(edge.to.id),
      relationship,
      evidenceIds: [...new Set(evidenceIds)],
      active: true,
      removable: false,
    }
  })

  const snapshot = assertEstateSnapshot({
    tenantId: options.tenantId,
    environment,
    generatedAt: utc(envelope.producedAt),
    nodes,
    edges,
    evidence,
  })

  return { snapshot, provenance: manifestProvenance(envelope), hash: computeManifestHash(envelope) }
}
