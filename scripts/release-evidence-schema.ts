import { createHash } from 'node:crypto'

import { z } from 'zod'

export const RELEASE_EVIDENCE_SCHEMA_VERSION = '1.0.0' as const

export const evidenceClassificationSchema = z.enum([
  'live',
  'synthetic',
  'tested',
  'blocked',
  'planned',
])

export const evidenceOutcomeSchema = z.enum(['pass', 'fail', 'unknown', 'blocked', 'not-run'])
export const evidenceFreshnessSchema = z.enum(['fresh', 'stale', 'unknown'])
export const connectorReadinessSchema = z.enum([
  'ready',
  'degraded',
  'authorization-required',
  'insufficient-data',
  'unknown',
  'blocked',
  'planned',
])

const isoTimestampSchema = z.iso.datetime({ offset: true })
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/)
const imageTagSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const boundedIdSchema = z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/)
const boundedTextSchema = z.string().trim().min(1).max(500)
const boundedSourceSchema = z.string().trim().min(1).max(200)

const imageComponentSchema = z.strictObject({
  tag: imageTagSchema.nullable(),
  digest: imageDigestSchema.nullable(),
})

const expectedImageEvidenceSchema = z.strictObject({
  classification: z.literal('tested'),
  web: imageComponentSchema,
  api: imageComponentSchema,
  jobs: imageComponentSchema,
})

const deployedImageEvidenceSchema = z
  .strictObject({
    classification: evidenceClassificationSchema,
    observedAt: isoTimestampSchema.nullable().default(null),
    source: boundedSourceSchema.nullable().default(null),
    web: imageComponentSchema,
    api: imageComponentSchema,
    jobs: imageComponentSchema,
  })
  .superRefine((value, context) => {
    if (
      value.classification === 'live' &&
      (value.observedAt === null || value.source === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires source and observedAt',
      })
    }
    for (const component of ['web', 'api', 'jobs'] as const) {
      if (value[component].digest !== null && value[component].tag === null) {
        context.addIssue({
          code: 'custom',
          path: [component],
          message: 'an image digest requires a corresponding tag',
        })
      }
    }
  })

const imageSetInputSchema = z.strictObject({
  web: imageComponentSchema,
  api: imageComponentSchema,
  jobs: imageComponentSchema,
})

const deployedImageInputSchema = deployedImageEvidenceSchema

export const SAFE_CONFIGURATION_KEYS = [
  'AGENT365_CONNECTOR_ENABLED',
  'AGENT_SENTINEL_WRITE_ENABLED',
  'AUTH_MODE',
  'AZURE_MONITOR_OTEL_CONNECTOR_ENABLED',
  'AZURE_RESOURCE_GRAPH_CONNECTOR_ENABLED',
  'DATA_MODE',
  'DEFENDER_CLOUD_APPS_CONNECTOR_ENABLED',
  'ENTRA_CONNECTOR_ENABLED',
  'FOUNDRY_CONNECTOR_ENABLED',
  'MANIFEST_CONNECTOR_ENABLED',
  'NODE_ENV',
  'POWER_PLATFORM_CONNECTOR_ENABLED',
  'PURVIEW_CONNECTOR_ENABLED',
  'TEAMS_DISTRIBUTION_CONNECTOR_ENABLED',
] as const

const safeConfigurationValueSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

const safeConfigurationShape = Object.fromEntries(
  SAFE_CONFIGURATION_KEYS.map((key) => [key, safeConfigurationValueSchema.optional()]),
) as Record<(typeof SAFE_CONFIGURATION_KEYS)[number], z.ZodOptional<typeof safeConfigurationValueSchema>>

export const safeConfigurationSchema = z
  .strictObject(safeConfigurationShape)
  .refine((value) => Object.keys(value).length > 0, 'safeConfiguration must not be empty')

const configurationEvidenceSchema = z.strictObject({
  classification: z.enum(['tested', 'planned']),
  algorithm: z.literal('sha256'),
  hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  keys: z.array(z.enum(SAFE_CONFIGURATION_KEYS)).max(SAFE_CONFIGURATION_KEYS.length),
})

const checkEvidenceSchema = z
  .strictObject({
    classification: evidenceClassificationSchema,
    outcome: evidenceOutcomeSchema,
    command: z.string().trim().min(1).max(300).nullable().default(null),
    completedAt: isoTimestampSchema.nullable().default(null),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (
      value.outcome === 'pass' &&
      (value.command === null || value.completedAt === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'passing check requires command and completedAt',
      })
    }
    if (
      (value.classification === 'blocked' || value.classification === 'planned') &&
      value.outcome === 'pass'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'blocked or planned evidence cannot pass',
      })
    }
    if (value.outcome === 'pass' || value.outcome === 'fail') {
      if (value.classification !== 'tested') {
        context.addIssue({
          code: 'custom',
          message: 'local check pass or fail requires the tested classification',
        })
      }
    }
    if (value.outcome === 'blocked' && value.classification !== 'blocked') {
      context.addIssue({
        code: 'custom',
        message: 'blocked check outcome requires the blocked classification',
      })
    }
  })

const checkEvidenceSetSchema = z.strictObject({
  lint: checkEvidenceSchema,
  typecheck: checkEvidenceSchema,
  test: checkEvidenceSchema,
  build: checkEvidenceSchema,
  e2e: checkEvidenceSchema,
  bicep: checkEvidenceSchema,
})

const checkInputSetSchema = z.strictObject({
  lint: checkEvidenceSchema.optional(),
  typecheck: checkEvidenceSchema.optional(),
  test: checkEvidenceSchema.optional(),
  build: checkEvidenceSchema.optional(),
  e2e: checkEvidenceSchema.optional(),
  bicep: checkEvidenceSchema.optional(),
})

const liveValidationEvidenceSchema = z
  .strictObject({
    id: boundedIdSchema,
    classification: evidenceClassificationSchema,
    outcome: evidenceOutcomeSchema,
    freshness: evidenceFreshnessSchema,
    observedAt: isoTimestampSchema.nullable().default(null),
    source: boundedSourceSchema.nullable().default(null),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (
      value.classification === 'live' &&
      (value.observedAt === null || value.source === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires source and observedAt',
      })
    }
    if (
      (value.classification === 'blocked' || value.classification === 'planned') &&
      value.outcome === 'pass'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'blocked or planned evidence cannot pass',
      })
    }
  })

const connectorEvidenceSchema = z
  .strictObject({
    connectorId: boundedIdSchema,
    classification: evidenceClassificationSchema,
    readiness: connectorReadinessSchema,
    freshness: evidenceFreshnessSchema,
    observedAt: isoTimestampSchema.nullable().default(null),
    source: boundedSourceSchema.nullable().default(null),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (
      value.classification === 'live' &&
      (value.observedAt === null || value.source === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires source and observedAt',
      })
    }
    if (
      value.readiness === 'ready' &&
      (value.classification !== 'live' || value.freshness !== 'fresh')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'ready connector evidence must be live and fresh',
      })
    }
    if (value.classification === 'blocked' && value.readiness !== 'blocked') {
      context.addIssue({
        code: 'custom',
        message: 'blocked connector evidence must use blocked readiness',
      })
    }
    if (value.classification === 'planned' && value.readiness !== 'planned') {
      context.addIssue({
        code: 'custom',
        message: 'planned connector evidence must use planned readiness',
      })
    }
  })

const oneRaiEvidenceSchema = z
  .strictObject({
    classification: evidenceClassificationSchema,
    outcome: evidenceOutcomeSchema,
    observedAt: isoTimestampSchema.nullable().default(null),
    source: boundedSourceSchema.nullable().default(null),
    syntheticOnly: z.boolean().nullable(),
    automated: z.boolean().nullable(),
    cases: z.number().int().min(0).nullable(),
    defects: z.number().int().min(0).nullable(),
    humanReviewRequired: z.boolean().nullable(),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (
      value.classification === 'live' &&
      (value.observedAt === null || value.source === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires source and observedAt',
      })
    }
    if (value.syntheticOnly === true && value.classification !== 'synthetic') {
      context.addIssue({
        code: 'custom',
        message: 'synthetic OneRAI evidence must use the synthetic classification',
      })
    }
    if (
      (value.classification === 'blocked' || value.classification === 'planned') &&
      value.outcome === 'pass'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'blocked or planned evidence cannot pass',
      })
    }
    if (value.outcome === 'pass' && (value.cases === null || value.cases === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'passing OneRAI evidence requires at least one evaluated case',
      })
    }
    if (
      value.cases !== null &&
      value.defects !== null &&
      value.defects > value.cases
    ) {
      context.addIssue({
        code: 'custom',
        message: 'OneRAI defects cannot exceed evaluated cases',
      })
    }
  })

const releaseMetadataSchema = z.strictObject({
  commitSha: shaSchema,
  dirty: z.boolean(),
  generatedAt: isoTimestampSchema,
})

const imageEvidenceSchema = z.strictObject({
  expected: expectedImageEvidenceSchema,
  deployed: deployedImageEvidenceSchema,
})

export const releaseEvidenceInputSchema = z.strictObject({
  expectedImages: imageSetInputSchema.optional(),
  deployedImages: deployedImageInputSchema.optional(),
  safeConfiguration: safeConfigurationSchema.optional(),
  checks: checkInputSetSchema.optional(),
  liveValidations: z.array(liveValidationEvidenceSchema).max(50).optional(),
  connectors: z.array(connectorEvidenceSchema).max(100).optional(),
  oneRai: oneRaiEvidenceSchema.optional(),
})

export const releaseEvidenceManifestSchema = z.strictObject({
  schemaVersion: z.literal(RELEASE_EVIDENCE_SCHEMA_VERSION),
  release: releaseMetadataSchema,
  images: imageEvidenceSchema,
  configuration: configurationEvidenceSchema,
  checks: checkEvidenceSetSchema,
  liveValidations: z.array(liveValidationEvidenceSchema).max(50),
  connectors: z.array(connectorEvidenceSchema).max(100),
  oneRai: oneRaiEvidenceSchema,
})

export type EvidenceClassification = z.infer<typeof evidenceClassificationSchema>
export type EvidenceOutcome = z.infer<typeof evidenceOutcomeSchema>
export type SafeConfiguration = z.infer<typeof safeConfigurationSchema>
export type ReleaseEvidenceInput = z.infer<typeof releaseEvidenceInputSchema>
export type ReleaseEvidenceManifest = z.infer<typeof releaseEvidenceManifestSchema>

export interface RepositoryState {
  readonly commitSha: string
  readonly dirty: boolean
}

const forbiddenKeys = new Set([
  'accesstoken',
  'authorization',
  'connectionstring',
  'credential',
  'credentials',
  'env',
  'environment',
  'environmentdump',
  'environmentvariables',
  'idtoken',
  'output',
  'password',
  'passwd',
  'payload',
  'privatekey',
  'prompt',
  'refreshtoken',
  'secret',
  'secrets',
  'token',
  'tokens',
])

const secretValuePatterns = [
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /(?:AccountKey|SharedAccessKey|ClientSecret|Password)=/i,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /[?&](?:sig|signature|token|code)=[^&\s]+/i,
]

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase()
}

function inspectForSensitiveContent(value: unknown, path: readonly string[] = []): void {
  if (typeof value === 'string') {
    if (secretValuePatterns.some((pattern) => pattern.test(value))) {
      throw new Error(`Release evidence contains a secret-shaped value at ${path.join('.')}.`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      inspectForSensitiveContent(item, [...path, String(index)])
    })
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key]
    if (forbiddenKeys.has(normalizedKey(key))) {
      throw new Error(`Release evidence contains a forbidden field at ${childPath.join('.')}.`)
    }
    inspectForSensitiveContent(child, childPath)
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function hashSafeConfiguration(configuration: SafeConfiguration): {
  readonly algorithm: 'sha256'
  readonly hash: string
  readonly keys: (typeof SAFE_CONFIGURATION_KEYS)[number][]
} {
  const parsed = safeConfigurationSchema.parse(configuration)
  const keys = Object.keys(parsed).sort() as (typeof SAFE_CONFIGURATION_KEYS)[number][]
  return {
    algorithm: 'sha256',
    hash: createHash('sha256').update(canonicalJson(parsed)).digest('hex'),
    keys,
  }
}

export function sanitizeReleaseEvidenceInput(raw: unknown): ReleaseEvidenceInput {
  inspectForSensitiveContent(raw)
  return releaseEvidenceInputSchema.parse(raw)
}

const checkNames = ['lint', 'typecheck', 'test', 'build', 'e2e', 'bicep'] as const

function missingCheck() {
  return {
    classification: 'planned' as const,
    outcome: 'not-run' as const,
    command: null,
    completedAt: null,
    summary: 'No sanitized result was supplied.',
  }
}

function defaultImages(tag: string) {
  return {
    web: { tag, digest: null },
    api: { tag, digest: null },
    jobs: { tag, digest: null },
  }
}

export function buildReleaseEvidence(
  repository: RepositoryState,
  input: ReleaseEvidenceInput,
  generatedAt: string,
): ReleaseEvidenceManifest {
  const parsedRepository = z
    .strictObject({ commitSha: shaSchema, dirty: z.boolean() })
    .parse(repository)
  const parsedInput = releaseEvidenceInputSchema.parse(input)
  const checks = Object.fromEntries(
    checkNames.map((name) => [name, parsedInput.checks?.[name] ?? missingCheck()]),
  )
  const expected = parsedInput.expectedImages ?? defaultImages(parsedRepository.commitSha.slice(0, 7))
  const configuration =
    parsedInput.safeConfiguration === undefined
      ? {
          classification: 'planned' as const,
          algorithm: 'sha256' as const,
          hash: null,
          keys: [],
        }
      : {
          classification: 'tested' as const,
          ...hashSafeConfiguration(parsedInput.safeConfiguration),
        }

  return releaseEvidenceManifestSchema.parse({
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    release: {
      ...parsedRepository,
      generatedAt,
    },
    images: {
      expected: {
        classification: 'tested',
        ...expected,
      },
      deployed: parsedInput.deployedImages ?? {
        classification: 'planned',
        observedAt: null,
        source: null,
        web: { tag: null, digest: null },
        api: { tag: null, digest: null },
        jobs: { tag: null, digest: null },
      },
    },
    configuration,
    checks,
    liveValidations: parsedInput.liveValidations ?? [],
    connectors: parsedInput.connectors ?? [],
    oneRai: parsedInput.oneRai ?? {
      classification: 'planned',
      outcome: 'not-run',
      observedAt: null,
      source: null,
      syntheticOnly: null,
      automated: null,
      cases: null,
      defects: null,
      humanReviewRequired: null,
      summary: 'No sanitized OneRAI summary was supplied.',
    },
  })
}
