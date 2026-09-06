import { createHash } from 'node:crypto'

import { z } from 'zod'

export const RELEASE_EVIDENCE_SCHEMA_VERSION = '1.0.0' as const
export const RELEASE_EVIDENCE_FRESHNESS_WINDOW_HOURS = 24 as const

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
const imageTagSchema = shaSchema
const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const boundedIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/)
const boundedTextSchema = z.string().trim().min(1).max(500)
const boundedSourceSchema = z.string().trim().min(1).max(200)
const sanitizedScopeSchema = z.strictObject({
  estateRef: boundedIdSchema,
  tenantRef: boundedIdSchema,
  environmentRef: boundedIdSchema,
  sourceRef: boundedIdSchema,
})
const evidenceReferencesSchema = z
  .array(boundedIdSchema)
  .max(20)
  .superRefine((value, context) => {
    const seen = new Set<string>()
    value.forEach((reference, index) => {
      if (seen.has(reference)) {
        context.addIssue({
          code: 'custom',
          path: [index],
          message: 'evidence references must be unique',
        })
      }
      seen.add(reference)
    })
  })

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
    scope: sanitizedScopeSchema.nullable().default(null),
    evidenceRefs: evidenceReferencesSchema.default([]),
    web: imageComponentSchema,
    api: imageComponentSchema,
    jobs: imageComponentSchema,
  })
  .superRefine((value, context) => {
    if (
      value.classification === 'live' &&
      (value.observedAt === null ||
        value.source === null ||
        value.scope === null ||
        value.evidenceRefs.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires sanitized scope and evidence references',
      })
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
) as Record<
  (typeof SAFE_CONFIGURATION_KEYS)[number],
  z.ZodOptional<typeof safeConfigurationValueSchema>
>

export const safeConfigurationSchema = z
  .strictObject(safeConfigurationShape)
  .refine((value) => Object.keys(value).length > 0, 'safeConfiguration must not be empty')

const configurationHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const configurationKeysSchema = z
  .array(z.enum(SAFE_CONFIGURATION_KEYS))
  .max(SAFE_CONFIGURATION_KEYS.length)

const configurationEvidenceSchema = z.discriminatedUnion('classification', [
  z.strictObject({
    classification: z.literal('tested'),
    algorithm: z.literal('sha256'),
    hash: configurationHashSchema,
    keys: configurationKeysSchema.min(1),
  }),
  z.strictObject({
    classification: z.literal('planned'),
    algorithm: z.literal('sha256'),
    hash: z.null(),
    keys: configurationKeysSchema.length(0),
  }),
])

const checkEvidenceSchema = z
  .strictObject({
    classification: evidenceClassificationSchema,
    outcome: evidenceOutcomeSchema,
    command: z.string().trim().min(1).max(300).nullable().default(null),
    completedAt: isoTimestampSchema.nullable().default(null),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (value.outcome === 'pass' && (value.command === null || value.completedAt === null)) {
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
    scope: sanitizedScopeSchema.nullable().default(null),
    evidenceRefs: evidenceReferencesSchema.default([]),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    const evaluated = value.outcome === 'pass' || value.outcome === 'fail'
    if (
      (value.classification === 'live' || evaluated) &&
      (value.observedAt === null ||
        value.source === null ||
        value.scope === null ||
        value.evidenceRefs.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'live or evaluated validation evidence requires source, observedAt, sanitized scope, and evidence references',
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
    scope: sanitizedScopeSchema.nullable().default(null),
    evidenceRefs: evidenceReferencesSchema.default([]),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    if (value.classification === 'live' && (value.observedAt === null || value.source === null)) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires source and observedAt',
      })
    }
    if (
      value.classification === 'live' &&
      (value.scope === null || value.evidenceRefs.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'live evidence requires sanitized scope and evidence references',
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
    scope: sanitizedScopeSchema.nullable().default(null),
    evidenceRefs: evidenceReferencesSchema.default([]),
    syntheticOnly: z.boolean().nullable(),
    automated: z.boolean().nullable(),
    cases: z.number().int().min(0).nullable(),
    defects: z.number().int().min(0).nullable(),
    humanReviewRequired: z.boolean().nullable(),
    summary: boundedTextSchema,
  })
  .superRefine((value, context) => {
    const requiresAttribution =
      value.classification === 'live' ||
      value.classification === 'tested' ||
      value.outcome === 'pass' ||
      value.outcome === 'fail'
    if (
      requiresAttribution &&
      (value.observedAt === null ||
        value.source === null ||
        value.scope === null ||
        value.evidenceRefs.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'live, tested, or evaluated OneRAI evidence requires source, observedAt, sanitized scope, and evidence references',
      })
    }
    if (value.syntheticOnly === true && value.classification !== 'synthetic') {
      context.addIssue({
        code: 'custom',
        message: 'synthetic OneRAI evidence must use the synthetic classification',
      })
    }
    if (value.classification === 'synthetic' && value.syntheticOnly !== true) {
      context.addIssue({
        code: 'custom',
        message: 'synthetic OneRAI classification requires syntheticOnly true',
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
    if (value.cases !== null && value.defects !== null && value.defects > value.cases) {
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
  freshnessWindowHours: z.literal(RELEASE_EVIDENCE_FRESHNESS_WINDOW_HOURS),
})

const imageEvidenceSchema = z.strictObject({
  expected: expectedImageEvidenceSchema,
  deployed: deployedImageEvidenceSchema,
})

const liveValidationEvidenceSetSchema = z
  .array(liveValidationEvidenceSchema)
  .max(50)
  .superRefine((values, context) => {
    addDuplicateIdentityIssues(
      values.map((validation) => validation.id),
      'id',
      'live validation',
      context,
    )
  })

const connectorEvidenceSetSchema = z
  .array(connectorEvidenceSchema)
  .max(100)
  .superRefine((values, context) => {
    addDuplicateIdentityIssues(
      values.map((connector) => connector.connectorId),
      'connectorId',
      'connector',
      context,
    )
  })

export const releaseEvidenceInputSchema = z.strictObject({
  expectedImages: imageSetInputSchema.optional(),
  deployedImages: deployedImageInputSchema.optional(),
  safeConfiguration: safeConfigurationSchema.optional(),
  checks: checkInputSetSchema.optional(),
  liveValidations: liveValidationEvidenceSetSchema.optional(),
  connectors: connectorEvidenceSetSchema.optional(),
  oneRai: oneRaiEvidenceSchema.optional(),
})

const releaseEvidenceManifestObjectSchema = z.strictObject({
  schemaVersion: z.literal(RELEASE_EVIDENCE_SCHEMA_VERSION),
  release: releaseMetadataSchema,
  images: imageEvidenceSchema,
  configuration: configurationEvidenceSchema,
  checks: checkEvidenceSetSchema,
  liveValidations: liveValidationEvidenceSetSchema,
  connectors: connectorEvidenceSetSchema,
  oneRai: oneRaiEvidenceSchema,
})

const imageComponents = ['web', 'api', 'jobs'] as const

function addDuplicateIdentityIssues(
  values: readonly string[],
  identityField: 'id' | 'connectorId',
  label: 'live validation' | 'connector',
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>()
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        path: [index, identityField],
        message: `${label} identities must be unique`,
      })
    }
    seen.add(value)
  })
}

function addTimestampIssue(
  timestamp: string | null,
  generatedAt: number,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): number | null {
  if (timestamp === null) return null
  const observedAt = Date.parse(timestamp)
  if (observedAt > generatedAt) {
    context.addIssue({
      code: 'custom',
      path: [...path],
      message: 'evidence timestamps cannot be later than release.generatedAt',
    })
    return null
  }
  return observedAt
}

function addFreshnessIssues(
  value: {
    readonly freshness: z.infer<typeof evidenceFreshnessSchema>
    readonly observedAt: string | null
  },
  generatedAt: number,
  freshnessWindowHours: number,
  path: readonly (string | number)[],
  context: z.RefinementCtx,
): void {
  const observedAt = addTimestampIssue(
    value.observedAt,
    generatedAt,
    [...path, 'observedAt'],
    context,
  )
  if (observedAt === null) {
    if (value.observedAt === null && value.freshness !== 'unknown') {
      context.addIssue({
        code: 'custom',
        path: [...path, 'freshness'],
        message: 'evidence without observedAt must use unknown freshness',
      })
    }
    return
  }
  const ageHours = (generatedAt - observedAt) / (60 * 60 * 1000)
  const expectedFreshness = ageHours <= freshnessWindowHours ? 'fresh' : 'stale'
  if (value.freshness !== expectedFreshness) {
    context.addIssue({
      code: 'custom',
      path: [...path, 'freshness'],
      message: `freshness must be ${expectedFreshness} relative to release.generatedAt and freshnessWindowHours`,
    })
  }
}

export const releaseEvidenceManifestSchema = releaseEvidenceManifestObjectSchema.superRefine(
  (value, context) => {
    const commitSha = value.release.commitSha
    const expectedImages = value.images.expected
    for (const component of imageComponents) {
      if (expectedImages[component].tag !== commitSha) {
        context.addIssue({
          code: 'custom',
          path: ['images', 'expected', component, 'tag'],
          message: 'expected image tags must match release.commitSha',
        })
      }
    }

    const deployedImages = value.images.deployed
    const deployedTags = imageComponents
      .map((component) => deployedImages[component].tag)
      .filter((tag): tag is string => tag !== null)
    if (new Set(deployedTags).size > 1) {
      context.addIssue({
        code: 'custom',
        path: ['images', 'deployed'],
        message: 'deployed component tags must identify one release',
      })
    }
    for (const component of imageComponents) {
      const deployed = deployedImages[component]
      if (deployed.digest !== null && deployed.tag === null) {
        context.addIssue({
          code: 'custom',
          path: ['images', 'deployed', component],
          message: 'an image digest requires a corresponding tag',
        })
      }
      if (deployed.tag !== null && deployed.tag !== commitSha) {
        context.addIssue({
          code: 'custom',
          path: ['images', 'deployed', component, 'tag'],
          message: 'deployed image tags must match release.commitSha',
        })
      }
      const expectedDigest = expectedImages[component].digest
      if (
        expectedDigest !== null &&
        deployed.digest !== null &&
        expectedDigest !== deployed.digest
      ) {
        context.addIssue({
          code: 'custom',
          path: ['images', 'deployed', component, 'digest'],
          message: 'deployed image digests must match expected image digests',
        })
      }
    }
    if (
      deployedImages.classification === 'live' &&
      imageComponents.some(
        (component) =>
          deployedImages[component].tag === null || deployedImages[component].digest === null,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['images', 'deployed'],
        message: 'live deployment evidence requires full commit tags and image digests',
      })
    }

    const generatedAt = Date.parse(value.release.generatedAt)
    addTimestampIssue(
      deployedImages.observedAt,
      generatedAt,
      ['images', 'deployed', 'observedAt'],
      context,
    )
    for (const [name, check] of Object.entries(value.checks)) {
      addTimestampIssue(check.completedAt, generatedAt, ['checks', name, 'completedAt'], context)
    }
    value.liveValidations.forEach((validation, index) => {
      addFreshnessIssues(
        validation,
        generatedAt,
        value.release.freshnessWindowHours,
        ['liveValidations', index],
        context,
      )
    })
    value.connectors.forEach((connector, index) => {
      addFreshnessIssues(
        connector,
        generatedAt,
        value.release.freshnessWindowHours,
        ['connectors', index],
        context,
      )
    })
    addTimestampIssue(value.oneRai.observedAt, generatedAt, ['oneRai', 'observedAt'], context)
  },
)

export type EvidenceClassification = z.infer<typeof evidenceClassificationSchema>
export type EvidenceOutcome = z.infer<typeof evidenceOutcomeSchema>
export type SafeConfiguration = z.infer<typeof safeConfigurationSchema>
export type ReleaseEvidenceInput = z.infer<typeof releaseEvidenceInputSchema>
export type ReleaseEvidenceManifest = z.infer<typeof releaseEvidenceManifestSchema>

export function generateReleaseEvidenceJsonSchema() {
  return {
    $id: 'https://agent-sentinel.example/schemas/release-evidence/v1/schema.json',
    title: 'Agent Sentinel sanitized release evidence manifest',
    description:
      'Strict versioned release evidence. The repository validator additionally enforces cross-field contradictions.',
    ...z.toJSONSchema(releaseEvidenceManifestSchema, {
      target: 'draft-2020-12',
      reused: 'ref',
    }),
  }
}

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
const forbiddenKeyFragments = [
  'apikey',
  'authorization',
  'connectionstring',
  'credential',
  'modeloutput',
  'password',
  'payload',
  'privatekey',
  'prompt',
  'secret',
  'systemoutput',
  'token',
] as const

const secretValuePatterns = [
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|passwd|secret|token)\s*[:=]\s*["']?[^\s"',;]{8,}/i,
  /(?:AccountKey|SharedAccessKey|ClientSecret|InstrumentationKey|Password)=/i,
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
    const normalized = normalizedKey(key)
    if (
      forbiddenKeys.has(normalized) ||
      forbiddenKeyFragments.some((fragment) => normalized.includes(fragment)) ||
      normalized === 'processenv'
    ) {
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
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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
  assertReleaseEvidenceContainsNoSensitiveContent(raw)
  return releaseEvidenceInputSchema.parse(raw)
}

export function assertReleaseEvidenceContainsNoSensitiveContent(raw: unknown): void {
  inspectForSensitiveContent(raw)
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
  assertReleaseEvidenceContainsNoSensitiveContent(input)
  const parsedRepository = z
    .strictObject({ commitSha: shaSchema, dirty: z.boolean() })
    .parse(repository)
  const parsedInput = releaseEvidenceInputSchema.parse(input)
  const checks = Object.fromEntries(
    checkNames.map((name) => [name, parsedInput.checks?.[name] ?? missingCheck()]),
  )
  const expectedTag = parsedRepository.commitSha
  const expected = parsedInput.expectedImages ?? defaultImages(expectedTag)
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
      freshnessWindowHours: RELEASE_EVIDENCE_FRESHNESS_WINDOW_HOURS,
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
        scope: null,
        evidenceRefs: [],
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
      scope: null,
      evidenceRefs: [],
      syntheticOnly: null,
      automated: null,
      cases: null,
      defects: null,
      humanReviewRequired: null,
      summary: 'No sanitized OneRAI summary was supplied.',
    },
  })
}
