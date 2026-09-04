import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { z } from 'zod'

const execFileAsync = promisify(execFile)

export const RELEASE_EVIDENCE_SCHEMA_VERSION = 'release-evidence.v1' as const

const IsoDateTimeSchema = z.string().datetime({ offset: true })
const ShaSchema = z.string().regex(/^[0-9a-f]{7,40}$/u)
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u)
const ClassificationSchema = z.enum(['live', 'synthetic', 'tested', 'blocked', 'planned', 'unknown'])
const ResultStatusSchema = z.enum(['pass', 'fail', 'unknown', 'blocked', 'not-run'])
const FreshnessStatusSchema = z.enum(['fresh', 'stale', 'unknown', 'not-supplied'])
const ConnectorReadinessSchema = z.enum([
  'ready',
  'degraded',
  'blocked',
  'unknown',
  'not-configured',
  'insufficient-data',
  'authorization-required',
  'licensing-blocked',
])

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
)
const JsonObjectSchema = z.record(z.string(), JsonValueSchema)

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

export const ImageEvidenceSchema = z
  .object({
    name: z.string().min(1),
    tag: z.string().min(1),
    digest: DigestSchema.optional(),
    classification: ClassificationSchema,
    evidenceRef: z.string().min(1).optional(),
  })
  .strict()

export const CheckResultSchema = z
  .object({
    status: ResultStatusSchema,
    classification: ClassificationSchema,
    command: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    summary: z.string().min(1),
    completedAt: IsoDateTimeSchema.optional(),
    evidenceRef: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === 'pass' && !['live', 'tested'].includes(value.classification)) {
      context.addIssue({
        code: 'custom',
        path: ['classification'],
        message: 'Passing check results must be classified as live or tested evidence.',
      })
    }
  })

export const LiveValidationSummarySchema = z
  .object({
    name: z.string().min(1),
    status: ResultStatusSchema,
    classification: ClassificationSchema,
    summary: z.string().min(1),
    observedAt: IsoDateTimeSchema.optional(),
    evidenceRef: z.string().min(1).optional(),
    freshness: FreshnessStatusSchema.optional(),
  })
  .strict()

export const ConnectorReadinessSummarySchema = z
  .object({
    connector: z.string().min(1),
    implementation: z.string().min(1),
    readiness: ConnectorReadinessSchema,
    classification: ClassificationSchema,
    summary: z.string().min(1),
    observedAt: IsoDateTimeSchema.optional(),
    evidenceRef: z.string().min(1).optional(),
  })
  .strict()

export const EvidenceFreshnessSchema = z
  .object({
    status: FreshnessStatusSchema,
    generatedAt: IsoDateTimeSchema,
    oldestAcceptedEvidenceAt: IsoDateTimeSchema.nullable(),
    maxAgeHours: z.number().nonnegative().nullable(),
    staleEvidenceCount: z.number().int().nonnegative(),
    summary: z.string().min(1),
  })
  .strict()

export const OneRaiSummarySchema = z
  .object({
    status: ResultStatusSchema,
    classification: ClassificationSchema,
    summary: z.string().min(1),
    observedAt: IsoDateTimeSchema.optional(),
    evidenceRef: z.string().min(1).optional(),
  })
  .strict()

export const ExplicitClassificationSchema = z
  .object({
    subject: z.string().min(1),
    classification: ClassificationSchema,
    summary: z.string().min(1),
    evidenceRef: z.string().min(1).optional(),
  })
  .strict()

export const ReleaseEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(RELEASE_EVIDENCE_SCHEMA_VERSION),
    generatedAt: IsoDateTimeSchema,
    repository: z
      .object({
        commitSha: ShaSchema,
        branch: z.string().min(1),
        dirty: z.boolean(),
        dirtyFiles: z.array(z.string().min(1)),
      })
      .strict(),
    images: z
      .object({
        expected: z.array(ImageEvidenceSchema),
        deployed: z.array(ImageEvidenceSchema),
      })
      .strict(),
    configuration: z
      .object({
        source: z.enum(['not-supplied', 'allow-listed-files', 'inline']),
        hashAlgorithm: z.literal('sha256'),
        hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
        projected: JsonObjectSchema,
      })
      .strict(),
    checks: z
      .object({
        unit: CheckResultSchema,
        typecheck: CheckResultSchema,
        lint: CheckResultSchema,
        build: CheckResultSchema,
        e2e: CheckResultSchema,
        bicep: CheckResultSchema,
      })
      .strict(),
    liveValidations: z.array(LiveValidationSummarySchema),
    connectorReadiness: z.array(ConnectorReadinessSummarySchema),
    evidenceFreshness: EvidenceFreshnessSchema,
    oneRai: OneRaiSummarySchema,
    claimClassifications: z.array(ExplicitClassificationSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Map<string, z.infer<typeof ClassificationSchema>>()
    for (let index = 0; index < value.claimClassifications.length; index += 1) {
      const claim = value.claimClassifications[index]
      if (claim === undefined) continue
      const existing = seen.get(claim.subject)
      if (existing !== undefined && existing !== claim.classification) {
        context.addIssue({
          code: 'custom',
          path: ['claimClassifications', index, 'classification'],
          message: `Contradictory classifications for ${claim.subject}: ${existing} and ${claim.classification}.`,
        })
      }
      seen.set(claim.subject, claim.classification)
    }
  })

export type ReleaseEvidenceManifest = z.infer<typeof ReleaseEvidenceManifestSchema>
export type CheckResult = z.infer<typeof CheckResultSchema>
export type SanitizedLiveResultFile = z.infer<typeof SanitizedLiveResultFileSchema>

export interface RepositoryState {
  readonly commitSha: string
  readonly branch: string
  readonly dirty: boolean
  readonly dirtyFiles: readonly string[]
}

export interface GenerateReleaseEvidenceOptions {
  readonly repository: RepositoryState
  readonly generatedAt: string
  readonly expectedImages?: readonly z.infer<typeof ImageEvidenceSchema>[]
  readonly deployedImages?: readonly z.infer<typeof ImageEvidenceSchema>[]
  readonly configuration?: ReleaseEvidenceManifest['configuration']
  readonly liveResultFiles?: readonly SanitizedLiveResultFile[]
}

export const SanitizedLiveResultFileSchema = z
  .object({
    images: z
      .object({
        expected: z.array(ImageEvidenceSchema).optional(),
        deployed: z.array(ImageEvidenceSchema).optional(),
      })
      .strict()
      .optional(),
    checks: z
      .object({
        unit: CheckResultSchema.optional(),
        typecheck: CheckResultSchema.optional(),
        lint: CheckResultSchema.optional(),
        build: CheckResultSchema.optional(),
        e2e: CheckResultSchema.optional(),
        bicep: CheckResultSchema.optional(),
      })
      .strict()
      .optional(),
    liveValidations: z.array(LiveValidationSummarySchema).optional(),
    connectorReadiness: z.array(ConnectorReadinessSummarySchema).optional(),
    evidenceFreshness: EvidenceFreshnessSchema.optional(),
    oneRai: OneRaiSummarySchema.optional(),
    claimClassifications: z.array(ExplicitClassificationSchema).optional(),
  })
  .strict()

const forbiddenKeyPattern = /^(accessToken|authToken|bearerToken|clientSecret|connectionString|credential|credentials|env|environment|environmentVariables|output|outputs|password|privatePayload|prompt|prompts|rawClaims|rawPayload|refreshToken|secret|secrets|token|tokens)$/iu
const forbiddenValuePattern =
  /(AccountKey=|SharedAccessKey=|SharedAccessSignature=|Bearer\s+[A-Za-z0-9._~+/-]+=*|-----BEGIN [A-Z ]+PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9_]{20,})/u

export function stableStringify(value: JsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (isJsonArray(value)) {
    const items: readonly JsonValue[] = value
    return `[${items.map((item) => stableStringify(item)).join(',')}]`
  }
  const record = asJsonObject(value)
  const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(',')}}`
}

export function sha256Json(value: JsonValue): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function asJsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>
}

export function assertSanitizedEvidence(value: JsonValue, path = '$'): void {
  if (typeof value === 'string') {
    if (forbiddenValuePattern.test(value)) throw new Error(`Sensitive value is not allowed at ${path}.`)
    return
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return
  if (isJsonArray(value)) {
    const items: readonly JsonValue[] = value
    items.forEach((item, index) => assertSanitizedEvidence(item, `${path}[${String(index)}]`))
    return
  }
  const record = asJsonObject(value)
  for (const [key, nested] of Object.entries(record)) {
    if (forbiddenKeyPattern.test(key)) throw new Error(`Sensitive or unrestricted field ${path}.${key} is not allowed.`)
    assertSanitizedEvidence(nested, `${path}.${key}`)
  }
}

export function projectAllowListedConfiguration(raw: JsonObject, keys: readonly string[]): ReleaseEvidenceManifest['configuration'] {
  if (keys.length === 0) throw new Error('At least one allow-listed configuration key is required when a config file is supplied.')
  const projected: Record<string, JsonValue> = {}
  for (const key of keys) {
    if (forbiddenKeyPattern.test(key)) throw new Error(`Configuration key ${key} is not safe to include.`)
    if (!Object.hasOwn(raw, key)) throw new Error(`Configuration key ${key} is missing from supplied file.`)
    const value = raw[key]
    if (value === undefined) throw new Error(`Configuration key ${key} is missing from supplied file.`)
    assertSanitizedEvidence({ [key]: value })
    projected[key] = value
  }
  return {
    source: 'allow-listed-files',
    hashAlgorithm: 'sha256',
    hash: sha256Json(projected),
    projected,
  }
}

export async function loadSanitizedJsonFile(path: string): Promise<JsonObject> {
  const raw = await readFile(path, 'utf8')
  const parsed = JsonObjectSchema.parse(JSON.parse(raw))
  assertSanitizedEvidence(parsed)
  return parsed
}

export async function loadSanitizedLiveResultFile(path: string): Promise<SanitizedLiveResultFile> {
  const parsed = await loadSanitizedJsonFile(path)
  return SanitizedLiveResultFileSchema.parse(parsed)
}

export async function readRepositoryState(repoRoot: string): Promise<RepositoryState> {
  const [commit, branch, status] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
    execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot }),
    execFileAsync('git', ['status', '--porcelain'], { cwd: repoRoot }),
  ])
  const dirtyFiles = status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0)
  return {
    commitSha: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  }
}

function unknownCheck(command: string): CheckResult {
  return {
    status: 'unknown',
    classification: 'unknown',
    command,
    summary: 'No sanitized result file was supplied; this is not a pass.',
  }
}

function buildDefaultClaimClassifications(): ReleaseEvidenceManifest['claimClassifications'] {
  return [
    {
      subject: 'repository-only generation',
      classification: 'tested',
      summary: 'Generated from local repository metadata without cloud calls.',
    },
    {
      subject: 'live validation',
      classification: 'unknown',
      summary: 'No live validation is assumed unless a sanitized result file supplies it.',
    },
    {
      subject: 'synthetic validation',
      classification: 'synthetic',
      summary: 'Synthetic evidence must remain explicitly labeled when supplied.',
    },
    {
      subject: 'blocked capabilities',
      classification: 'blocked',
      summary: 'Blocked states remain blocked until evidence changes.',
    },
    {
      subject: 'planned capabilities',
      classification: 'planned',
      summary: 'Planned work is not treated as implemented or deployed evidence.',
    },
  ]
}

export function generateReleaseEvidence(options: GenerateReleaseEvidenceOptions): ReleaseEvidenceManifest {
  const liveFiles = options.liveResultFiles ?? []
  const checksFromFiles = liveFiles.map((file) => file.checks).filter((checks) => checks !== undefined)
  const latestChecks = checksFromFiles.at(-1)
  const configuration = options.configuration ?? {
    source: 'not-supplied' as const,
    hashAlgorithm: 'sha256' as const,
    hash: sha256Json({}),
    projected: {},
  }
  const manifest: ReleaseEvidenceManifest = {
    schemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    repository: {
      commitSha: options.repository.commitSha,
      branch: options.repository.branch,
      dirty: options.repository.dirty,
      dirtyFiles: [...options.repository.dirtyFiles],
    },
    images: {
      expected: [
        ...(options.expectedImages ?? []),
        ...liveFiles.flatMap((file) => file.images?.expected ?? []),
      ],
      deployed: [
        ...(options.deployedImages ?? []),
        ...liveFiles.flatMap((file) => file.images?.deployed ?? []),
      ],
    },
    configuration,
    checks: {
      unit: latestChecks?.unit ?? unknownCheck('pnpm test'),
      typecheck: latestChecks?.typecheck ?? unknownCheck('pnpm typecheck'),
      lint: latestChecks?.lint ?? unknownCheck('pnpm lint'),
      build: latestChecks?.build ?? unknownCheck('pnpm build'),
      e2e: latestChecks?.e2e ?? unknownCheck('pnpm test:e2e'),
      bicep: latestChecks?.bicep ?? unknownCheck('az bicep build -f infra/platform.bicep'),
    },
    liveValidations: liveFiles.flatMap((file) => file.liveValidations ?? []),
    connectorReadiness: liveFiles.flatMap((file) => file.connectorReadiness ?? []),
    evidenceFreshness: liveFiles.findLast((file) => file.evidenceFreshness !== undefined)?.evidenceFreshness ?? {
      status: 'not-supplied',
      generatedAt: options.generatedAt,
      oldestAcceptedEvidenceAt: null,
      maxAgeHours: null,
      staleEvidenceCount: 0,
      summary: 'No sanitized live evidence freshness summary was supplied.',
    },
    oneRai: liveFiles.findLast((file) => file.oneRai !== undefined)?.oneRai ?? {
      status: 'unknown',
      classification: 'unknown',
      summary: 'No sanitized OneRAI evidence was supplied.',
    },
    claimClassifications: [
      ...buildDefaultClaimClassifications(),
      ...liveFiles.flatMap((file) => file.claimClassifications ?? []),
    ],
  }
  return ReleaseEvidenceManifestSchema.parse(manifest)
}
