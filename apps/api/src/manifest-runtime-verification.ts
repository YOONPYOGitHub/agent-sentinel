import { stableId, type ManifestIngestionRecord } from '@agent-sentinel/connector-sdk'
import {
  manifestConfigurationReconciliationSchema,
  manifestRuntimeVerificationSchema,
  type EstateSnapshot,
  type GraphNode,
  type ManifestConfigurationComparableField,
  type ManifestConfigurationReconciliation,
  type ManifestRuntimeClaimVerificationStatus,
  type ManifestRuntimeVerification,
} from '@agent-sentinel/domain'

export interface RuntimeQueryCoverage {
  configured: boolean
  queriedAgentIds: ReadonlySet<string>
  failedAgentIds: ReadonlySet<string>
  projectionFailedAgentIds: ReadonlySet<string>
}

type VerificationClaim = ManifestRuntimeVerification['claims'][number]
type ReconciliationClaim = ManifestConfigurationReconciliation['claims'][number]
type ReconciliationComparison = ReconciliationClaim['comparisons'][number]
type ComparableValue = ReconciliationComparison['manifestValue']

type ManifestSubject =
  | {
      readonly kind: 'agent'
      readonly value: ManifestIngestionRecord['envelope']['agents'][number]
    }
  | {
      readonly kind: 'tool'
      readonly value: ManifestIngestionRecord['envelope']['tools'][number]
    }
  | {
      readonly kind: 'identity'
      readonly value: ManifestIngestionRecord['envelope']['identities'][number]
    }
  | {
      readonly kind: 'data'
      readonly value: ManifestIngestionRecord['envelope']['dataSources'][number]
    }
  | {
      readonly kind: 'mcp'
      readonly value: NonNullable<ManifestIngestionRecord['envelope']['mcpDependencies']>[number]
    }

interface ComparableDeclaration {
  readonly field: ManifestConfigurationComparableField
  readonly manifestValue: ComparableValue
  readonly authoritativeMetadataKey?: string
  readonly authoritativeNodeField?: 'sensitivity'
  readonly valueType: 'string' | 'boolean'
}

function manifestSubject(
  record: ManifestIngestionRecord,
  subjectId: string,
): ManifestSubject | undefined {
  const agent = record.envelope.agents.find((item) => item.id === subjectId)
  if (agent !== undefined) return { kind: 'agent', value: agent }
  const tool = record.envelope.tools.find((item) => item.id === subjectId)
  if (tool !== undefined) return { kind: 'tool', value: tool }
  const identity = record.envelope.identities.find((item) => item.id === subjectId)
  if (identity !== undefined) return { kind: 'identity', value: identity }
  const data = record.envelope.dataSources.find((item) => item.id === subjectId)
  if (data !== undefined) return { kind: 'data', value: data }
  const mcp = record.envelope.mcpDependencies?.find((item) => item.id === subjectId)
  if (mcp !== undefined) return { kind: 'mcp', value: mcp }
  return undefined
}

function manifestSubjectKind(
  record: ManifestIngestionRecord,
  subjectId: string,
): GraphNode['kind'] | undefined {
  return manifestSubject(record, subjectId)?.kind
}

function authoritative(node: GraphNode): boolean {
  return (
    node.metadata['sourceOfTruth'] !== 'false' && node.metadata['isNonAuthoritative'] !== 'true'
  )
}

function exactCandidates(
  snapshot: EstateSnapshot,
  binding: NonNullable<ManifestIngestionRecord['envelope']['evidence'][number]['sourceBinding']>,
): GraphNode[] {
  return snapshot.nodes.filter(
    (node) =>
      authoritative(node) &&
      node.metadata['sourceConnectorId'] === binding.sourceConnectorId &&
      node.metadata['sourceTenantId'] === binding.sourceTenantId &&
      node.metadata['sourceObjectId'] === binding.sourceObjectId &&
      node.metadata['sourceEnvironment'] === binding.sourceEnvironment,
  )
}

function owningAgentIds(snapshot: EstateSnapshot, node: GraphNode): string[] {
  if (node.kind === 'agent') return [node.id]
  if (node.kind !== 'tool') return []
  return [
    ...new Set(
      snapshot.edges.flatMap((edge) => {
        if (edge.to !== node.id || edge.relationship !== 'CAN_CALL') return []
        const agent = snapshot.nodes.find(
          (candidate) => candidate.id === edge.from && candidate.kind === 'agent',
        )
        return agent !== undefined && authoritative(agent) ? [agent.id] : []
      }),
    ),
  ]
}

function claim(
  record: ManifestIngestionRecord,
  declaration: ManifestIngestionRecord['envelope']['evidence'][number],
  status: ManifestRuntimeClaimVerificationStatus,
  reason: VerificationClaim['reason'],
  matchedNodeId?: string,
  corroboratingEvidenceIds: string[] = [],
): VerificationClaim {
  return {
    manifestId: record.manifestId,
    evidenceId: stableId('manifest', `${record.manifestId}::evidence::${declaration.id}`),
    subjectId: declaration.subjectId,
    status,
    ...(matchedNodeId !== undefined ? { matchedNodeId } : {}),
    corroboratingEvidenceIds,
    reason,
  }
}

function verifyClaim(
  snapshot: EstateSnapshot,
  record: ManifestIngestionRecord,
  declaration: ManifestIngestionRecord['envelope']['evidence'][number],
  coverage: RuntimeQueryCoverage,
): VerificationClaim {
  const binding = declaration.sourceBinding
  if (binding === undefined) {
    return claim(record, declaration, 'not-correlatable', 'missing-source-binding')
  }
  if (declaration.subjectId !== binding.sourceObjectId) {
    return claim(record, declaration, 'not-correlatable', 'subject-binding-mismatch')
  }
  const candidates = exactCandidates(snapshot, binding)
  if (candidates.length === 0) {
    return claim(record, declaration, 'not-correlatable', 'no-exact-source-match')
  }
  if (candidates.length > 1) {
    return claim(record, declaration, 'ambiguous', 'multiple-exact-source-matches')
  }
  const node = candidates[0]!
  if (manifestSubjectKind(record, declaration.subjectId) !== node.kind) {
    return claim(record, declaration, 'not-correlatable', 'entity-kind-mismatch', node.id)
  }
  if (node.kind !== 'agent' && node.kind !== 'tool') {
    return claim(record, declaration, 'not-correlatable', 'unsupported-node-kind', node.id)
  }
  const owners = owningAgentIds(snapshot, node)
  if (owners.length === 0) {
    return claim(record, declaration, 'not-correlatable', 'no-owning-agent', node.id)
  }
  if (owners.length > 1) {
    return claim(record, declaration, 'ambiguous', 'ambiguous-owning-agent', node.id)
  }
  const ownerId = owners[0]!
  if (coverage.failedAgentIds.has(ownerId)) {
    return claim(record, declaration, 'unavailable', 'telemetry-query-failed', node.id)
  }
  if (coverage.projectionFailedAgentIds.has(ownerId)) {
    return claim(record, declaration, 'unavailable', 'telemetry-projection-failed', node.id)
  }
  if (!coverage.configured || !coverage.queriedAgentIds.has(ownerId)) {
    return claim(record, declaration, 'unavailable', 'telemetry-not-queried', node.id)
  }
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
  const corroboratingEvidenceIds = node.evidenceIds.filter((id) => {
    const evidence = evidenceById.get(id)
    return (
      evidence?.evidenceTypes.includes('observed_runtime') === true &&
      evidence.metadata?.['sourceConnector'] === 'azure-monitor-otel'
    )
  })
  return corroboratingEvidenceIds.length > 0
    ? claim(
        record,
        declaration,
        'verified',
        'non-synthetic-runtime-observation',
        node.id,
        corroboratingEvidenceIds,
      )
    : claim(record, declaration, 'no-observation', 'no-non-synthetic-runtime-observation', node.id)
}

export function verifyManifestRuntimeClaims(
  snapshot: EstateSnapshot,
  records: readonly ManifestIngestionRecord[],
  coverage: RuntimeQueryCoverage,
  checkedAt = new Date().toISOString(),
): ManifestRuntimeVerification {
  const claims = records.flatMap((record) =>
    record.envelope.evidence
      .filter((declaration) => declaration.evidenceType === 'runtime_observed')
      .map((declaration) => verifyClaim(snapshot, record, declaration, coverage)),
  )
  const counts = {
    verified: claims.filter((item) => item.status === 'verified').length,
    noObservation: claims.filter((item) => item.status === 'no-observation').length,
    ambiguous: claims.filter((item) => item.status === 'ambiguous').length,
    notCorrelatable: claims.filter((item) => item.status === 'not-correlatable').length,
    unavailable: claims.filter((item) => item.status === 'unavailable').length,
  }
  const unresolved = counts.ambiguous + counts.notCorrelatable + counts.unavailable
  const status =
    claims.length === 0
      ? 'no-claims'
      : counts.unavailable === claims.length
        ? 'unavailable'
        : unresolved > 0
          ? 'partial'
          : 'ready'
  return manifestRuntimeVerificationSchema.parse({
    status,
    checkedAt,
    counts,
    claims,
  })
}

function reconcileClaim(
  snapshot: EstateSnapshot,
  record: ManifestIngestionRecord,
  declaration: ManifestIngestionRecord['envelope']['evidence'][number],
): ReconciliationClaim {
  const unverifiedClaimKeys = Object.keys(declaration.claims).sort()
  const base = {
    manifestId: record.manifestId,
    evidenceId: stableId('manifest', `${record.manifestId}::evidence::${declaration.id}`),
    subjectId: declaration.subjectId,
    authoritativeEvidenceIds: [] as string[],
    comparisons: [] as ReconciliationComparison[],
    unverifiedClaimKeys,
  }
  const binding = declaration.sourceBinding
  if (binding === undefined) {
    return {
      ...base,
      status: 'not-correlatable',
      reason: 'missing-source-binding',
    }
  }
  if (declaration.subjectId !== binding.sourceObjectId) {
    return {
      ...base,
      status: 'not-correlatable',
      reason: 'subject-binding-mismatch',
    }
  }
  const candidates = exactCandidates(snapshot, binding)
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'not-correlatable',
      reason: 'no-exact-source-match',
    }
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: 'ambiguous',
      reason: 'multiple-exact-source-matches',
    }
  }
  const node = candidates[0]!
  const subject = manifestSubject(record, declaration.subjectId)
  if (subject?.kind !== node.kind) {
    return {
      ...base,
      status: 'not-correlatable',
      matchedNodeId: node.id,
      reason: 'entity-kind-mismatch',
    }
  }
  const evidenceById = new Map(snapshot.evidence.map((item) => [item.id, item]))
  const comparisons = compareConfigurationValues(subject, node)
  return {
    ...base,
    status: 'matched-authoritative-object',
    matchedNodeId: node.id,
    authoritativeEvidenceIds: node.evidenceIds.filter(
      (id) => evidenceById.get(id)?.evidenceTypes.includes('declared_configuration') === true,
    ),
    reason: 'exact-authoritative-object-match',
    comparisons,
  }
}

function comparableDeclarations(subject: ManifestSubject): ComparableDeclaration[] {
  const declarations: ComparableDeclaration[] = []
  const add = (
    field: ManifestConfigurationComparableField,
    manifestValue: ComparableValue | undefined,
    authoritativeMetadataKey: string,
    valueType: ComparableDeclaration['valueType'] = 'string',
  ): void => {
    if (manifestValue !== undefined)
      declarations.push({ field, manifestValue, authoritativeMetadataKey, valueType })
  }

  switch (subject.kind) {
    case 'agent':
      add('agent.platform', subject.value.platform, 'platform')
      add('agent.version', subject.value.version, 'version')
      add('agent.model', subject.value.model, 'modelDeployment')
      add('agent.approvalRequired', subject.value.approvalRequired, 'approvalRequired', 'boolean')
      break
    case 'tool':
      add('tool.toolType', subject.value.toolType, 'toolType')
      break
    case 'identity':
      add('identity.principalType', subject.value.principalType, 'principalType')
      break
    case 'data':
      if (subject.value.sensitivity !== undefined)
        declarations.push({
          field: 'data.sensitivity',
          manifestValue: subject.value.sensitivity,
          authoritativeNodeField: 'sensitivity',
          valueType: 'string',
        })
      add('data.classification', subject.value.classification, 'classification')
      break
    case 'mcp':
      add('mcp.endpointRef', subject.value.endpointRef, 'endpointRef')
      add('mcp.approved', subject.value.approved, 'approved', 'boolean')
      break
  }
  return declarations
}

function authoritativeValue(
  node: GraphNode,
  declaration: ComparableDeclaration,
):
  | { readonly status: 'available'; readonly value: ComparableValue }
  | { readonly status: 'unavailable'; readonly reason: ReconciliationComparison['reason'] } {
  const raw =
    declaration.authoritativeNodeField === 'sensitivity'
      ? node.sensitivity
      : declaration.authoritativeMetadataKey === undefined
        ? undefined
        : node.metadata[declaration.authoritativeMetadataKey]
  if (raw === undefined || raw === '') {
    return { status: 'unavailable', reason: 'authoritative-value-not-exposed' }
  }
  if (declaration.valueType === 'boolean') {
    if (raw === 'true') return { status: 'available', value: true }
    if (raw === 'false') return { status: 'available', value: false }
    return { status: 'unavailable', reason: 'invalid-authoritative-value' }
  }
  return { status: 'available', value: raw }
}

function compareConfigurationValues(
  subject: ManifestSubject,
  node: GraphNode,
): ReconciliationComparison[] {
  return comparableDeclarations(subject).map((declaration) => {
    const authoritative = authoritativeValue(node, declaration)
    if (authoritative.status === 'unavailable') {
      return {
        field: declaration.field,
        status: 'unavailable',
        manifestValue: declaration.manifestValue,
        reason: authoritative.reason,
      }
    }
    const matched = authoritative.value === declaration.manifestValue
    return {
      field: declaration.field,
      status: matched ? 'matched' : 'mismatched',
      manifestValue: declaration.manifestValue,
      authoritativeValue: authoritative.value,
      reason: matched ? 'exact-value-match' : 'value-mismatch',
    }
  })
}

export function reconcileManifestConfigurationEvidence(
  snapshot: EstateSnapshot,
  records: readonly ManifestIngestionRecord[],
  checkedAt = new Date().toISOString(),
): ManifestConfigurationReconciliation {
  const claims = records.flatMap((record) =>
    record.envelope.evidence
      .filter((declaration) => declaration.evidenceType === 'declared_configuration')
      .map((declaration) => reconcileClaim(snapshot, record, declaration)),
  )
  const counts = {
    matched: claims.filter((item) => item.status === 'matched-authoritative-object').length,
    ambiguous: claims.filter((item) => item.status === 'ambiguous').length,
    notCorrelatable: claims.filter((item) => item.status === 'not-correlatable').length,
    valueMatched: claims
      .flatMap((item) => item.comparisons)
      .filter((item) => item.status === 'matched').length,
    valueMismatched: claims
      .flatMap((item) => item.comparisons)
      .filter((item) => item.status === 'mismatched').length,
    valueUnavailable: claims
      .flatMap((item) => item.comparisons)
      .filter((item) => item.status === 'unavailable').length,
    freeFormUnverified: claims.reduce((count, item) => count + item.unverifiedClaimKeys.length, 0),
  }
  const unresolved =
    counts.ambiguous +
    counts.notCorrelatable +
    counts.valueMismatched +
    counts.valueUnavailable +
    counts.freeFormUnverified
  return manifestConfigurationReconciliationSchema.parse({
    status: claims.length === 0 ? 'no-claims' : unresolved > 0 ? 'partial' : 'ready',
    checkedAt,
    counts,
    claims,
  })
}
