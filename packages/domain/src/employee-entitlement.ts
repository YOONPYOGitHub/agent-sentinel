import { z } from 'zod'

import { estateContextSchema, type EstateContext } from './estate.js'
import type { EstateSnapshot, GraphNode } from './index.js'

const entraObjectIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  .transform((value) => value.toLowerCase())

const exactIdentifierSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) => value === value.trim(),
      'Identifiers must not contain surrounding whitespace.',
    )

export const employeeEntitlementAuthoritySchema = z.enum([
  'microsoft-agent-365',
  'publishing-platform',
])

export type EmployeeEntitlementAuthority = z.infer<typeof employeeEntitlementAuthoritySchema>

export const employeeEntitlementSubjectSchema = z.strictObject({
  kind: z.literal('microsoft-entra-object-id'),
  tenantId: entraObjectIdSchema,
  objectId: entraObjectIdSchema,
})

export type EmployeeEntitlementSubject = z.infer<typeof employeeEntitlementSubjectSchema>

export const employeeAgentReferenceSchema = z.strictObject({
  authority: employeeEntitlementAuthoritySchema,
  sourceConnectorId: exactIdentifierSchema(200),
  sourceTenantId: entraObjectIdSchema,
  sourceEnvironment: exactIdentifierSchema(128),
  providerPackageId: exactIdentifierSchema(512),
})

export type EmployeeAgentReference = z.infer<typeof employeeAgentReferenceSchema>

export const employeeEntitlementDecisionSchema = z.strictObject({
  agent: employeeAgentReferenceSchema,
  decision: z.enum(['allowed', 'denied']),
})

export type EmployeeEntitlementDecision = z.infer<typeof employeeEntitlementDecisionSchema>

const employeeEntitlementSourceSchema = z
  .strictObject({
    provider: employeeEntitlementAuthoritySchema,
    authoritative: z.boolean(),
    synthetic: z.boolean(),
    coverage: z.enum(['complete', 'partial', 'unknown']),
    observedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .superRefine((source, context) => {
    if (Date.parse(source.expiresAt) <= Date.parse(source.observedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'Entitlement evidence must expire after it was observed.',
      })
    }
  })

export const employeeEntitlementEvidenceSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    estate: estateContextSchema,
    subject: employeeEntitlementSubjectSchema,
    source: employeeEntitlementSourceSchema,
    decisions: z.array(employeeEntitlementDecisionSchema).max(5_000),
  }),
  z.strictObject({
    status: z.literal('unavailable'),
    estate: estateContextSchema,
    subject: employeeEntitlementSubjectSchema,
    reason: z.string().trim().min(1).max(500),
  }),
  z.strictObject({
    status: z.literal('unsupported'),
    estate: estateContextSchema,
    subject: employeeEntitlementSubjectSchema,
    reason: z.string().trim().min(1).max(500),
  }),
])

export type EmployeeEntitlementEvidence = z.infer<typeof employeeEntitlementEvidenceSchema>

export const employeeAgentCatalogEntrySchema = z.strictObject({
  id: z.string().min(1).max(512),
  name: z.string().min(1).max(512),
  description: z.string().min(1).max(4_096),
  platform: z.string().min(1).max(512).optional(),
  version: z.string().min(1).max(128).optional(),
})

export type EmployeeAgentCatalogEntry = z.infer<typeof employeeAgentCatalogEntrySchema>

export const employeeAgentCatalogReasonSchema = z.enum([
  'principal-identifier-unavailable',
  'evidence-source-unconfigured',
  'evidence-source-unavailable',
  'unsupported-evidence',
  'invalid-evidence',
  'boundary-mismatch',
  'non-authoritative-evidence',
  'synthetic-evidence',
  'stale-evidence',
  'incomplete-evidence',
  'ambiguous-evidence',
  'inventory-evidence-unavailable',
])

export type EmployeeAgentCatalogReason = z.infer<typeof employeeAgentCatalogReasonSchema>

const unavailableCatalogResponseSchema = z.strictObject({
  status: z.enum(['unavailable', 'unknown']),
  reason: employeeAgentCatalogReasonSchema,
  agents: z.array(employeeAgentCatalogEntrySchema).length(0),
})

export const employeeAgentCatalogResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    authority: employeeEntitlementAuthoritySchema,
    observedAt: z.iso.datetime(),
    agents: z.array(employeeAgentCatalogEntrySchema).min(1).max(5_000),
  }),
  z.strictObject({
    status: z.literal('denied'),
    authority: employeeEntitlementAuthoritySchema,
    observedAt: z.iso.datetime(),
    agents: z.array(employeeAgentCatalogEntrySchema).length(0),
  }),
  z.strictObject({
    status: z.literal('mock'),
    synthetic: z.literal(true),
    agents: z.array(employeeAgentCatalogEntrySchema).max(5_000),
  }),
  unavailableCatalogResponseSchema,
])

export type EmployeeAgentCatalogResponse = z.infer<typeof employeeAgentCatalogResponseSchema>

export interface AuthoritativeAgent365CatalogBinding extends EmployeeAgentReference {
  observedAt: string
}

function sameTenant(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase()
}

function hasSyntheticMarker(metadata: Readonly<Record<string, string>>): boolean {
  return Object.entries(metadata).some(([key, value]) => {
    const normalized = value.trim().toLowerCase()
    return (
      (/(synthetic|test|fixture|mock|demo|sample)/i.test(key) &&
        ['true', '1', 'yes', 'synthetic', 'test', 'fixture', 'mock', 'demo', 'sample'].includes(
          normalized,
        )) ||
      (/(mode|classification)$/i.test(key) &&
        ['synthetic', 'test', 'fixture', 'mock', 'demo', 'sample'].includes(normalized))
    )
  })
}

export function authoritativeAgent365CatalogBinding(
  snapshot: Pick<EstateSnapshot, 'tenantId' | 'environment' | 'evidence'>,
  agent: GraphNode,
  estate: EstateContext,
): AuthoritativeAgent365CatalogBinding | undefined {
  const metadata = agent.metadata
  if (
    agent.kind !== 'agent' ||
    !sameTenant(snapshot.tenantId, estate.tenantId) ||
    snapshot.environment !== estate.environment ||
    metadata['sourceConnector'] !== 'agent365-package-catalog' ||
    metadata['sourceOfTruth'] !== 'true' ||
    metadata['isNonAuthoritative'] === 'true' ||
    metadata['inventoryEntityType'] !== 'agent-package' ||
    metadata['isBlocked'] === 'true' ||
    hasSyntheticMarker(metadata)
  ) {
    return undefined
  }

  const sourceConnectorId = metadata['sourceConnectorId']
  const sourceTenantId = metadata['sourceTenantId']
  const sourceEnvironment = metadata['sourceEnvironment']
  const providerPackageId = metadata['providerPackageId']
  if (
    sourceConnectorId === undefined ||
    sourceTenantId === undefined ||
    sourceEnvironment === undefined ||
    providerPackageId === undefined ||
    metadata['sourceProviderObjectId'] !== providerPackageId ||
    !sameTenant(sourceTenantId, estate.tenantId) ||
    sourceEnvironment !== estate.environment ||
    agent.environment !== sourceEnvironment ||
    (metadata['estateTenantId'] !== undefined &&
      !sameTenant(metadata['estateTenantId'], estate.tenantId)) ||
    (metadata['estateEnvironment'] !== undefined &&
      metadata['estateEnvironment'] !== estate.environment)
  ) {
    return undefined
  }

  const exactEvidence = agent.evidenceIds.flatMap((evidenceId) => {
    const matches = snapshot.evidence.filter((evidence) => evidence.id === evidenceId)
    if (matches.length !== 1) return []
    const evidence = matches[0]
    const evidenceMetadata = evidence?.metadata ?? {}
    return evidence !== undefined &&
      evidence.source.startsWith('Microsoft Graph v1.0 Agent 365 package catalog · ') &&
      evidence.freshness === 'live' &&
      evidence.confidence === 1 &&
      evidence.evidenceTypes.length === 1 &&
      evidence.evidenceTypes[0] === 'declared_configuration' &&
      evidence.sourceObjectId === `${sourceConnectorId}:${providerPackageId}` &&
      evidenceMetadata['sourceConnector'] === 'agent365-package-catalog' &&
      evidenceMetadata['sourceConnectorId'] === sourceConnectorId &&
      sameTenant(evidenceMetadata['sourceTenantId'], sourceTenantId) &&
      evidenceMetadata['sourceEnvironment'] === sourceEnvironment &&
      evidenceMetadata['providerPackageId'] === providerPackageId &&
      evidenceMetadata['sourceProviderObjectId'] === providerPackageId &&
      evidenceMetadata['inventoryEntityType'] === 'agent-package' &&
      evidenceMetadata['sourceOfTruth'] !== 'false' &&
      evidenceMetadata['isNonAuthoritative'] !== 'true' &&
      !hasSyntheticMarker(evidenceMetadata) &&
      (evidenceMetadata['estateTenantId'] === undefined ||
        sameTenant(evidenceMetadata['estateTenantId'], estate.tenantId)) &&
      (evidenceMetadata['estateEnvironment'] === undefined ||
        evidenceMetadata['estateEnvironment'] === estate.environment)
      ? [evidence]
      : []
  })

  return exactEvidence.length === 1
    ? {
        authority: 'microsoft-agent-365',
        sourceConnectorId,
        sourceTenantId,
        sourceEnvironment,
        providerPackageId,
        observedAt: exactEvidence[0]!.observedAt,
      }
    : undefined
}
