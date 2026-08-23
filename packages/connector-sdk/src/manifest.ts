import { createHash } from 'node:crypto'

import { relationshipSchema, type Relationship } from '@agent-sentinel/domain'
import { z } from 'zod'

// ─── Schema version ──────────────────────────────────────────────────────────

/** Schema version emitted by the current adapter contract. */
export const MANIFEST_SCHEMA_VERSION = '1.0'

/** Every manifest schema version this build can normalize. */
export const SUPPORTED_MANIFEST_VERSIONS = ['1.0'] as const

export const manifestSchemaVersionSchema = z.enum(SUPPORTED_MANIFEST_VERSIONS)
export type ManifestSchemaVersion = z.infer<typeof manifestSchemaVersionSchema>

/** Compatibility check for an untrusted `schemaVersion` value. */
export function isSupportedManifestVersion(value: unknown): value is ManifestSchemaVersion {
  return typeof value === 'string' && manifestSchemaVersionSchema.safeParse(value).success
}

export class UnsupportedManifestVersionError extends Error {
  override readonly name = 'UnsupportedManifestVersionError'
  constructor(readonly received: unknown) {
    super(
      `Unsupported manifest schemaVersion ${JSON.stringify(received)}. Supported versions: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}.`,
    )
  }
}

// ─── Adapter trust posture ───────────────────────────────────────────────────

/** How far an adapter is permitted to act. Execution is never permitted. */
export const actionDepthSchema = z.enum(['none', 'simulate', 'propose', 'execute'])
export type ActionDepth = z.infer<typeof actionDepthSchema>

/** Adapters default to observation only. */
export const DEFAULT_ACTION_DEPTH: ActionDepth = 'none'

/** Action depths that are rejected before normalization, without exception. */
export const PROHIBITED_ACTION_DEPTHS: readonly ActionDepth[] = ['execute']

export function isProhibitedActionDepth(depth: ActionDepth): boolean {
  return PROHIBITED_ACTION_DEPTHS.includes(depth)
}

/** Default confidence for any claim an adapter supplies. Lower than first-party evidence. */
export const ADAPTER_DEFAULT_CONFIDENCE = 0.4

/** Hard ceiling for adapter claims that are not runtime-observed. */
export const ADAPTER_MAX_DECLARED_CONFIDENCE = 0.7

/** Bounded input limits. Every one of these is enforced by `validateManifest`. */
export const MANIFEST_LIMITS = {
  maxMetadataKeys: 20,
  maxMetadataValueLength: 256,
  maxClaimKeys: 50,
  maxClaimValueLength: 512,
  maxEntitiesPerType: 500,
  maxEdges: 2000,
  maxEvidenceRecords: 2000,
  maxPermissions: 50,
  maxSourceObjectIds: 200,
  maxIdLength: 200,
  maxNameLength: 200,
  maxTextLength: 1024,
} as const

// ─── Stable identifiers ──────────────────────────────────────────────────────

/** Prefix applied to every identifier that originates from an operator manifest. */
export const STABLE_ID_PREFIX = 'manifest'

/**
 * Build a namespaced identifier of the form `manifest::<source>::<localId>`.
 * Passing the prefix itself as `source` does not duplicate the prefix, so
 * `stableId('manifest', 'x::y')` and `stableId('x', 'y')` agree.
 */
export function stableId(source: string, localId: string): string {
  const scope = source === STABLE_ID_PREFIX ? '' : `${source}::`
  return `${STABLE_ID_PREFIX}::${scope}${localId}`
}

// ─── Shared field schemas ────────────────────────────────────────────────────

const localIdSchema = z.string().min(1).max(MANIFEST_LIMITS.maxIdLength)
const displayNameSchema = z.string().min(1).max(MANIFEST_LIMITS.maxNameLength)
const textSchema = z.string().min(1).max(MANIFEST_LIMITS.maxTextLength)
const isoTimestampSchema = z.iso.datetime({ offset: true })
const trustSchema = z.enum(['trusted', 'conditional', 'untrusted'])
const sensitivitySchema = z.enum(['public', 'internal', 'confidential', 'highly-confidential'])

/** No manifest field may smuggle a URL; the adapter never dereferences anything. */
export const NO_SCHEME_PATTERN = /^(?!\/\/)(?!.*:\/\/).*$/
const opaqueRefSchema = z
  .string()
  .min(1)
  .max(MANIFEST_LIMITS.maxNameLength)
  .regex(NO_SCHEME_PATTERN, 'Value must not contain a URL scheme or protocol-relative prefix.')

/** ISO 8601 duration, for example `PT15M` or `P1DT6H`. */
export const ISO_DURATION_PATTERN =
  /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(?:\.\d+)?S)?)?$/

function boundedRecord(maxKeys: number, maxValueLength: number, label: string) {
  return z
    .record(z.string().min(1).max(128), z.string())
    .refine((record) => Object.keys(record).length <= maxKeys, {
      message: `${label} supports at most ${maxKeys} keys.`,
    })
    .refine((record) => Object.values(record).every((value) => value.length <= maxValueLength), {
      message: `${label} values must be at most ${maxValueLength} characters.`,
    })
}

// ─── Producer and provenance ─────────────────────────────────────────────────

export const manifestProducerSchema = z.strictObject({
  name: displayNameSchema,
  version: z.string().min(1).max(64).optional(),
  contact: opaqueRefSchema.optional(),
})
export type ManifestProducer = z.infer<typeof manifestProducerSchema>

/**
 * Provenance descriptor attached to everything an adapter supplies.
 * `isNonAuthoritative` and `sourceOfTruth` are literals: an adapter can never
 * declare itself authoritative.
 */
export const sourceProvenanceSchema = z.strictObject({
  producer: manifestProducerSchema,
  sourceObjectIds: z
    .array(z.string().min(1).max(MANIFEST_LIMITS.maxIdLength))
    .max(MANIFEST_LIMITS.maxSourceObjectIds),
  observedAt: isoTimestampSchema,
  confidence: z.number().min(0).max(1),
  freshness: z
    .string()
    .regex(ISO_DURATION_PATTERN, 'freshness must be an ISO 8601 duration such as PT15M.'),
  isNonAuthoritative: z.literal(true),
  sourceOfTruth: z.literal(false),
})
export type SourceProvenance = z.infer<typeof sourceProvenanceSchema>

// ─── Capability declaration ──────────────────────────────────────────────────

export const adapterCapabilityDeclarationSchema = z.strictObject({
  supportsDiscovery: z.boolean(),
  evidenceDepth: z.enum(['shallow', 'deep']),
  supportsRuntimeTelemetry: z.boolean(),
  supportsActions: actionDepthSchema.default(DEFAULT_ACTION_DEPTH),
})
export type AdapterCapabilityDeclaration = z.infer<typeof adapterCapabilityDeclarationSchema>

// ─── Entity declarations ─────────────────────────────────────────────────────

const declarationBase = {
  id: localIdSchema,
  displayName: displayNameSchema,
  description: textSchema.optional(),
  environment: z.string().min(1).max(128).optional(),
  owner: displayNameSchema.optional(),
  trust: trustSchema.optional(),
  observedAt: isoTimestampSchema.optional(),
}

export const agentDeclarationSchema = z.strictObject({
  ...declarationBase,
  platform: displayNameSchema.optional(),
  version: z.string().min(1).max(64).optional(),
  model: displayNameSchema.optional(),
})
export type AgentDeclaration = z.infer<typeof agentDeclarationSchema>

export const toolDeclarationSchema = z.strictObject({
  ...declarationBase,
  toolType: z.enum(['function', 'retrieval', 'action', 'unknown']).optional(),
})
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>

export const identityDeclarationSchema = z.strictObject({
  ...declarationBase,
  principalType: z
    .enum(['service-principal', 'managed-identity', 'user', 'workload', 'unknown'])
    .optional(),
  permissions: z
    .array(z.string().min(1).max(MANIFEST_LIMITS.maxNameLength))
    .max(MANIFEST_LIMITS.maxPermissions)
    .optional(),
})
export type IdentityDeclaration = z.infer<typeof identityDeclarationSchema>

export const dataSourceDeclarationSchema = z.strictObject({
  ...declarationBase,
  sensitivity: sensitivitySchema.optional(),
  classification: displayNameSchema.optional(),
})
export type DataSourceDeclaration = z.infer<typeof dataSourceDeclarationSchema>

export const mcpDependencyDeclarationSchema = z.strictObject({
  ...declarationBase,
  /** Opaque endpoint label. URLs are rejected; nothing is ever dereferenced. */
  endpointRef: opaqueRefSchema.optional(),
  approved: z.boolean().optional(),
})
export type MCPDependencyDeclaration = z.infer<typeof mcpDependencyDeclarationSchema>

// ─── Edges ───────────────────────────────────────────────────────────────────

export const manifestEntityKindSchema = z.enum(['agent', 'tool', 'identity', 'dataSources', 'mcp'])
export type ManifestEntityKind = z.infer<typeof manifestEntityKindSchema>

export const edgeEndpointSchema = z.strictObject({
  kind: manifestEntityKindSchema,
  id: localIdSchema,
})
export type EdgeEndpoint = z.infer<typeof edgeEndpointSchema>

export const edgeDeclarationSchema = z.strictObject({
  from: edgeEndpointSchema,
  to: edgeEndpointSchema,
  relationship: relationshipSchema,
  observedAt: isoTimestampSchema.optional(),
})
export type EdgeDeclaration = z.infer<typeof edgeDeclarationSchema>

/** Relationship vocabulary accepted from a manifest, taken from the domain model. */
export const SUPPORTED_MANIFEST_RELATIONSHIPS: readonly Relationship[] = relationshipSchema.options

/** Accept only the canonical domain relationship vocabulary, or fail closed. */
export function normalizeManifestRelationship(value: string): Relationship | undefined {
  const parsed = relationshipSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

// ─── Evidence ────────────────────────────────────────────────────────────────

export const manifestEvidenceTypeSchema = z.enum(['declared_configuration', 'runtime_observed'])
export type ManifestEvidenceType = z.infer<typeof manifestEvidenceTypeSchema>

export const evidenceDeclarationSchema = z.strictObject({
  id: localIdSchema,
  subjectId: localIdSchema,
  evidenceType: manifestEvidenceTypeSchema,
  confidence: z.number().min(0).max(1).default(ADAPTER_DEFAULT_CONFIDENCE),
  observedAt: isoTimestampSchema,
  claims: boundedRecord(
    MANIFEST_LIMITS.maxClaimKeys,
    MANIFEST_LIMITS.maxClaimValueLength,
    'claims',
  ).default({}),
})
export type EvidenceDeclaration = z.infer<typeof evidenceDeclarationSchema>

// ─── Envelope ────────────────────────────────────────────────────────────────

const envelopeShape = z.strictObject({
  schemaVersion: manifestSchemaVersionSchema,
  manifestId: localIdSchema,
  tenantId: z.string().min(1).max(MANIFEST_LIMITS.maxIdLength),
  environmentId: z.string().min(1).max(MANIFEST_LIMITS.maxIdLength).optional(),
  producedAt: isoTimestampSchema,
  producer: manifestProducerSchema,
  capabilities: adapterCapabilityDeclarationSchema,
  agents: z.array(agentDeclarationSchema).max(MANIFEST_LIMITS.maxEntitiesPerType),
  tools: z.array(toolDeclarationSchema).max(MANIFEST_LIMITS.maxEntitiesPerType),
  identities: z.array(identityDeclarationSchema).max(MANIFEST_LIMITS.maxEntitiesPerType),
  dataSources: z.array(dataSourceDeclarationSchema).max(MANIFEST_LIMITS.maxEntitiesPerType),
  mcpDependencies: z
    .array(mcpDependencyDeclarationSchema)
    .max(MANIFEST_LIMITS.maxEntitiesPerType)
    .optional(),
  edges: z.array(edgeDeclarationSchema).max(MANIFEST_LIMITS.maxEdges),
  evidence: z.array(evidenceDeclarationSchema).max(MANIFEST_LIMITS.maxEvidenceRecords),
  metadata: boundedRecord(
    MANIFEST_LIMITS.maxMetadataKeys,
    MANIFEST_LIMITS.maxMetadataValueLength,
    'metadata',
  ).optional(),
})

type EnvelopeShape = z.infer<typeof envelopeShape>

function entityIndex(envelope: EnvelopeShape): Map<string, ManifestEntityKind> {
  const index = new Map<string, ManifestEntityKind>()
  const groups: readonly (readonly [ManifestEntityKind, readonly { id: string }[]])[] = [
    ['agent', envelope.agents],
    ['tool', envelope.tools],
    ['identity', envelope.identities],
    ['dataSources', envelope.dataSources],
    ['mcp', envelope.mcpDependencies ?? []],
  ]
  for (const [kind, entities] of groups) {
    for (const entity of entities) if (!index.has(entity.id)) index.set(entity.id, kind)
  }
  return index
}

/** Cross-reference rules. Every rule fails the whole manifest rather than dropping a record. */
export const manifestEnvelopeSchema = envelopeShape.superRefine((envelope, context) => {
  // Rule: `execute` action depth is never accepted.
  if (isProhibitedActionDepth(envelope.capabilities.supportsActions)) {
    context.addIssue({
      code: 'custom',
      message: 'Adapter action depth "execute" is never permitted.',
      path: ['capabilities', 'supportsActions'],
    })
  }

  const groups: readonly (readonly [ManifestEntityKind, string, readonly { id: string }[]])[] = [
    ['agent', 'agents', envelope.agents],
    ['tool', 'tools', envelope.tools],
    ['identity', 'identities', envelope.identities],
    ['dataSources', 'dataSources', envelope.dataSources],
    ['mcp', 'mcpDependencies', envelope.mcpDependencies ?? []],
  ]

  const seenGlobally = new Map<string, ManifestEntityKind>()
  for (const [kind, field, entities] of groups) {
    const seenInType = new Set<string>()
    for (const [index, entity] of entities.entries()) {
      // Rule: identifiers are unique within their own declaration type.
      if (seenInType.has(entity.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate ${kind} id ${entity.id}.`,
          path: [field, index, 'id'],
        })
      }
      seenInType.add(entity.id)

      // Rule: identifiers do not collide across declaration types.
      const existing = seenGlobally.get(entity.id)
      if (existing !== undefined && existing !== kind) {
        context.addIssue({
          code: 'custom',
          message: `Id ${entity.id} collides with a declared ${existing}; ids must be unique across all types.`,
          path: [field, index, 'id'],
        })
      }
      seenGlobally.set(entity.id, kind)
    }
  }

  const declared = entityIndex(envelope)
  for (const [index, edge] of envelope.edges.entries()) {
    for (const side of ['from', 'to'] as const) {
      const endpoint = edge[side]
      const kind = declared.get(endpoint.id)
      // Rule: edge endpoints reference a declared entity.
      if (kind === undefined) {
        context.addIssue({
          code: 'custom',
          message: `Edge ${side} references undeclared entity ${endpoint.id}.`,
          path: ['edges', index, side, 'id'],
        })
        continue
      }
      // Rule: edge endpoint kind matches the declared entity kind.
      if (kind !== endpoint.kind) {
        context.addIssue({
          code: 'custom',
          message: `Edge ${side} declares kind ${endpoint.kind} but ${endpoint.id} is a ${kind}.`,
          path: ['edges', index, side, 'kind'],
        })
      }
    }
    // Rule: relationship maps onto the deterministic domain vocabulary.
    if (normalizeManifestRelationship(edge.relationship) === undefined) {
      context.addIssue({
        code: 'custom',
        message: `Unsupported relationship ${edge.relationship}. Supported: ${SUPPORTED_MANIFEST_RELATIONSHIPS.join(', ')}.`,
        path: ['edges', index, 'relationship'],
      })
    }
  }

  const seenEvidence = new Set<string>()
  for (const [index, evidence] of envelope.evidence.entries()) {
    // Rule: evidence identifiers are unique.
    if (seenEvidence.has(evidence.id)) {
      context.addIssue({
        code: 'custom',
        message: `Duplicate evidence id ${evidence.id}.`,
        path: ['evidence', index, 'id'],
      })
    }
    seenEvidence.add(evidence.id)

    // Rule: evidence subjects reference a declared entity.
    if (!declared.has(evidence.subjectId)) {
      context.addIssue({
        code: 'custom',
        message: `Evidence ${evidence.id} references undeclared subject ${evidence.subjectId}.`,
        path: ['evidence', index, 'subjectId'],
      })
    }

    if (evidence.evidenceType === 'runtime_observed') {
      // Rule: runtime evidence requires a declared runtime-telemetry capability.
      if (!envelope.capabilities.supportsRuntimeTelemetry) {
        context.addIssue({
          code: 'custom',
          message: `Evidence ${evidence.id} claims runtime observation, but capabilities.supportsRuntimeTelemetry is false.`,
          path: ['evidence', index, 'evidenceType'],
        })
      }
    } else if (evidence.confidence > ADAPTER_MAX_DECLARED_CONFIDENCE) {
      // Rule: declared-configuration confidence is capped.
      context.addIssue({
        code: 'custom',
        message: `Declared-configuration evidence ${evidence.id} may not exceed confidence ${ADAPTER_MAX_DECLARED_CONFIDENCE}.`,
        path: ['evidence', index, 'confidence'],
      })
    }
  }
})

export type ManifestEnvelope = z.infer<typeof manifestEnvelopeSchema>

// ─── Validation result ───────────────────────────────────────────────────────

export interface ManifestValidationIssue {
  readonly path: string
  readonly message: string
}

export type ManifestValidationResult =
  | { readonly ok: true; readonly envelope: ManifestEnvelope }
  | { readonly ok: false; readonly errors: readonly ManifestValidationIssue[] }

function issue(path: string, message: string): ManifestValidationIssue {
  return { path, message }
}

/**
 * Strict, fail-closed manifest validation. Nothing is normalized until every
 * structural, referential, and trust rule holds.
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [issue('', 'Manifest must be a JSON object.')] }
  }

  const version = (raw as Record<string, unknown>)['schemaVersion']
  if (!isSupportedManifestVersion(version)) {
    return {
      ok: false,
      errors: [issue('schemaVersion', new UnsupportedManifestVersionError(version).message)],
    }
  }

  const parsed = manifestEnvelopeSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((detail) =>
        issue(detail.path.map(String).join('.'), detail.message),
      ),
    }
  }
  return { ok: true, envelope: parsed.data }
}

// ─── Deterministic hashing ───────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** SHA-256 over a key-sorted canonical rendering. Stable across key ordering. */
export function computeManifestHash(envelope: ManifestEnvelope): string {
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex')
}

/** Provenance descriptor derived from a validated envelope. Never authoritative. */
export function manifestProvenance(
  envelope: ManifestEnvelope,
  freshness = 'PT24H',
): SourceProvenance {
  return sourceProvenanceSchema.parse({
    producer: envelope.producer,
    sourceObjectIds: [envelope.manifestId],
    observedAt: new Date(envelope.producedAt).toISOString(),
    confidence: ADAPTER_DEFAULT_CONFIDENCE,
    freshness,
    isNonAuthoritative: true,
    sourceOfTruth: false,
  })
}
