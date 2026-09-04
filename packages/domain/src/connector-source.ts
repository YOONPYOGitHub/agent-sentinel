import { z } from 'zod'

import { estateIdSchema } from './estate.js'

export const connectorSourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const connectorTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9-_.]*$/)

export const safeConnectorTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/)
  .refine((value) => !/(?:https?:\/\/|password\s*[:=]|client[_ -]?secret\s*[:=]|access[_ -]?token\s*[:=]|api[_ -]?key\s*[:=])/i.test(value), {
    message: 'Connector text values must not include URLs or raw credential material.',
  })

export const connectorSourceOriginSchema = z.enum(['deployment', 'user'])
export type ConnectorSourceOrigin = z.infer<typeof connectorSourceOriginSchema>

export const connectorSourceActorTypeSchema = z.enum(['user', 'service', 'deployment'])
export type ConnectorSourceActorType = z.infer<typeof connectorSourceActorTypeSchema>

export const connectorSourceActorSchema = z
  .object({
    type: connectorSourceActorTypeSchema,
    id: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .refine((actor) => {
    if (actor.type === 'deployment') {
      return actor.id.length > 0
    }
    return true
  })
export type ConnectorSourceActor = z.infer<typeof connectorSourceActorSchema>

export const connectorSourceStatusSchema = z.enum([
  'draft',
  'ready',
  'degraded',
  'disabled',
  'invalid',
  'not-tested',
])
export type ConnectorSourceStatus = z.infer<typeof connectorSourceStatusSchema>

export const connectorSourceEvidenceSchema = z.enum(['none', 'synthetic', 'live'])
export type ConnectorSourceEvidence = z.infer<typeof connectorSourceEvidenceSchema>

export const connectorSourceTestStatusSchema = z.enum([
  'not-run',
  'passed',
  'failed',
  'degraded',
  'authorization-required',
])
export type ConnectorSourceTestStatus = z.infer<typeof connectorSourceTestStatusSchema>

export const connectorSourceTestResultSchema = z
  .object({
    status: connectorSourceTestStatusSchema,
    checkedAt: z.iso.datetime(),
    evidence: connectorSourceEvidenceSchema,
    reasonCode: z.enum([
      'not-run',
      'success',
      'failed',
      'degraded',
      'authorization-required',
      'invalid-config',
    ]),
    message: z.string().trim().min(1).max(200),
  })
  .strict()
export type ConnectorSourceTestResult = z.infer<typeof connectorSourceTestResultSchema>

export const connectorSourceConfigSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('generic'),
        environment: safeConnectorTextSchema.optional(),
        scope: safeConnectorTextSchema.optional(),
        tags: z.array(safeConnectorTextSchema).max(10).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('azure-resource-graph'),
        subscriptionId: safeConnectorTextSchema.optional(),
        resourceGroup: safeConnectorTextSchema.optional(),
        tags: z.array(safeConnectorTextSchema).max(10).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('foundry'),
        projectName: safeConnectorTextSchema.optional(),
        deploymentName: safeConnectorTextSchema.optional(),
        modelName: safeConnectorTextSchema.optional(),
        tags: z.array(safeConnectorTextSchema).max(10).optional(),
      })
      .strict(),
  ])
export type ConnectorSourceConfig = z.infer<typeof connectorSourceConfigSchema>

export const connectorCredentialModeSchema = z.enum([
  'none',
  'managed-identity',
  'workload-identity',
  'key-vault-reference',
])
export type ConnectorCredentialMode = z.infer<typeof connectorCredentialModeSchema>

export const connectorCredentialMetadataSchema = z
  .discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('none'),
      })
      .strict(),
    z
      .object({
        mode: z.literal('managed-identity'),
        identityName: safeConnectorTextSchema.optional(),
        systemAssigned: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal('workload-identity'),
        federatedCredentialName: safeConnectorTextSchema,
        audience: safeConnectorTextSchema.optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal('key-vault-reference'),
        vaultName: safeConnectorTextSchema,
        secretName: safeConnectorTextSchema,
        secretVersion: safeConnectorTextSchema.optional(),
      })
      .strict(),
  ])
export type ConnectorCredentialMetadata = z.infer<typeof connectorCredentialMetadataSchema>

export const connectorSourceAuditActionSchema = z.enum([
  'create',
  'update',
  'enable',
  'disable',
  'delete',
  'test',
])
export type ConnectorSourceAuditAction = z.infer<typeof connectorSourceAuditActionSchema>

export const connectorSourceAuditTransitionSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    sourceId: connectorSourceIdSchema,
    action: connectorSourceAuditActionSchema,
    fromStatus: connectorSourceStatusSchema.nullable(),
    toStatus: connectorSourceStatusSchema,
    actor: connectorSourceActorSchema,
    timestamp: z.iso.datetime(),
    version: z.number().int().min(1),
    idempotencyKey: z.string().trim().min(1).max(128),
    summary: z.string().trim().min(1).max(200),
  })
  .strict()
export type ConnectorSourceAuditTransition = z.infer<typeof connectorSourceAuditTransitionSchema>

export const connectorSourceDefinitionSchema = z
  .object({
    id: connectorSourceIdSchema,
    estateId: estateIdSchema,
    tenantId: z.string().trim().min(1).max(128),
    environment: z.string().trim().min(1).max(128),
    connectorType: connectorTypeSchema,
    displayName: z.string().trim().min(1).max(128).refine(
      (value) => !/(?:https?:\/\/|password\s*[:=]|client[_ -]?secret\s*[:=]|access[_ -]?token\s*[:=]|api[_ -]?key\s*[:=])/i.test(value),
      {
        message: 'Connector display names cannot use URLs or raw credential material.',
      },
    ),
    enabled: z.boolean(),
    origin: connectorSourceOriginSchema,
    config: connectorSourceConfigSchema,
    credential: connectorCredentialMetadataSchema,
    version: z.number().int().min(1),
    etag: z.string().trim().min(1).max(128),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    actor: connectorSourceActorSchema,
    status: connectorSourceStatusSchema,
    lastTest: connectorSourceTestResultSchema.optional(),
    auditHistory: z.array(connectorSourceAuditTransitionSchema).default([]),
    idempotencyKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((source, context) => {
    if (new Date(source.updatedAt).getTime() < new Date(source.createdAt).getTime()) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'Connector update time must not precede creation time.',
      })
    }
    if (source.status === 'ready') {
      const evidence = source.lastTest
      if (!evidence || evidence.status !== 'passed' || evidence.evidence !== 'live') {
        context.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'Connector ready status requires a passing live test result.',
        })
      }
    }
    if (source.origin === 'deployment' && source.actor.type !== 'deployment') {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'type'],
        message: 'Deployment-origin sources must be created by a deployment actor.',
      })
    }
    if (source.enabled && source.status === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'A source cannot be enabled while marked disabled.',
      })
    }
  })
export type ConnectorSourceDefinition = z.infer<typeof connectorSourceDefinitionSchema>

export function redactConnectorSourceForApi(
  source: ConnectorSourceDefinition,
): ConnectorSourceDefinition {
  const sanitized = structuredClone(source)
  const scrub = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null) return value
    if (Array.isArray(value)) return value.map((item) => scrub(item))
    const next: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      if (
        /(?:password|clientSecret|accessToken|apiKey|secretValue|tokenValue|authorizationToken)/i.test(key) ||
        /^url$/i.test(key)
      ) {
        continue
      }
      next[key] = scrub(nestedValue)
    }
    return next
  }
  return connectorSourceDefinitionSchema.parse(scrub(sanitized))
}
