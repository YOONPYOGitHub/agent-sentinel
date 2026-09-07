import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

import {
  buildReleaseEvidence,
  generateReleaseEvidenceJsonSchema,
  hashSafeConfiguration,
  releaseEvidenceManifestSchema,
  sanitizeReleaseEvidenceInput,
  type ReleaseEvidenceInput,
  type ReleaseEvidenceManifest,
} from './release-evidence-schema.js'

const cleanRepository = {
  commitSha: 'a'.repeat(40),
  dirty: false,
} as const
const generatedAt = '2026-09-04T00:00:00.000Z'
const imageDigest = `sha256:${'b'.repeat(64)}`
const sanitizedScope = {
  estateRef: 'replacement-estate',
  tenantRef: 'replacement-tenant',
  environmentRef: 'dev',
  sourceRef: 'aggregate-health',
} as const
const deploymentObservedAt = '2026-09-03T23:00:00.000Z'
const linkedReadinessInput = {
  deployedImages: {
    deploymentRef: 'deployment-candidate-a',
    classification: 'live',
    observedAt: deploymentObservedAt,
    source: 'sanitized-deployment-observation',
    scope: { ...sanitizedScope, sourceRef: 'container-apps' },
    evidenceRefs: ['deployment-observation'],
    web: { tag: cleanRepository.commitSha, digest: imageDigest },
    api: { tag: cleanRepository.commitSha, digest: imageDigest },
    jobs: { tag: cleanRepository.commitSha, digest: imageDigest },
  },
  liveValidations: [
    {
      id: 'replacement-readiness',
      deploymentRef: 'deployment-candidate-a',
      snapshotRef: 'snapshot-a',
      findingRefs: ['finding-a'],
      classification: 'live',
      outcome: 'pass',
      freshness: 'fresh',
      observedAt: generatedAt,
      source: 'sanitized-validation',
      scope: sanitizedScope,
      evidenceRefs: ['validation-summary'],
      summary: 'The deployed candidate passed validation.',
    },
  ],
  connectors: [
    {
      connectorId: 'foundry-primary',
      deploymentRef: 'deployment-candidate-a',
      snapshotRef: 'snapshot-a',
      findingRefs: ['finding-a'],
      classification: 'live',
      readiness: 'ready',
      freshness: 'fresh',
      observedAt: generatedAt,
      source: 'sanitized-validation',
      scope: { ...sanitizedScope, sourceRef: 'foundry-primary' },
      evidenceRefs: ['foundry-summary'],
      summary: 'Foundry discovery completed for the validated snapshot.',
    },
  ],
} satisfies ReleaseEvidenceInput

function omitProperty(value: object, property: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== property))
}

function omitDeployedImageProperty(manifest: ReleaseEvidenceManifest, property: string): unknown {
  return {
    ...manifest,
    images: {
      ...manifest.images,
      deployed: omitProperty(manifest.images.deployed, property),
    },
  }
}

function omitCheckProperty(manifest: ReleaseEvidenceManifest, property: string): unknown {
  return {
    ...manifest,
    checks: {
      ...manifest.checks,
      lint: omitProperty(manifest.checks.lint, property),
    },
  }
}

function omitLiveValidationProperty(manifest: ReleaseEvidenceManifest, property: string): unknown {
  return {
    ...manifest,
    liveValidations: [omitProperty(manifest.liveValidations[0]!, property)],
  }
}

function omitConnectorProperty(manifest: ReleaseEvidenceManifest, property: string): unknown {
  return {
    ...manifest,
    connectors: [omitProperty(manifest.connectors[0]!, property)],
  }
}

function omitOneRaiProperty(manifest: ReleaseEvidenceManifest, property: string): unknown {
  return {
    ...manifest,
    oneRai: omitProperty(manifest.oneRai, property),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function schemasDefiningProperty(schema: unknown, property: string): Record<string, unknown>[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item) => schemasDefiningProperty(item, property))
  }
  if (!isRecord(schema)) return []

  const matches =
    isRecord(schema.properties) && Object.hasOwn(schema.properties, property) ? [schema] : []
  return [
    ...matches,
    ...Object.values(schema).flatMap((item) => schemasDefiningProperty(item, property)),
  ]
}

describe('release evidence schema', () => {
  it('builds a strict repository-only manifest without turning missing evidence into pass', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, generatedAt)

    expect(manifest.schemaVersion).toBe('1.0.0')
    expect(manifest.release).toEqual({
      commitSha: cleanRepository.commitSha,
      dirty: false,
      generatedAt,
      freshnessWindowHours: 24,
    })
    expect(manifest.images.expected).toMatchObject({
      classification: 'tested',
      web: { tag: cleanRepository.commitSha, digest: null },
      api: { tag: cleanRepository.commitSha, digest: null },
      jobs: { tag: cleanRepository.commitSha, digest: null },
    })
    expect(manifest.images.deployed).toMatchObject({
      deploymentRef: null,
      classification: 'planned',
      observedAt: null,
      source: null,
      web: { tag: null, digest: null },
      api: { tag: null, digest: null },
      jobs: { tag: null, digest: null },
    })
    expect(manifest.configuration).toEqual({
      classification: 'planned',
      algorithm: 'sha256',
      hash: null,
      keys: [],
    })
    expect(manifest.checks.e2e).toMatchObject({
      classification: 'planned',
      outcome: 'not-run',
      command: null,
      completedAt: null,
    })
    expect(manifest.liveValidations).toEqual([])
    expect(manifest.connectors).toEqual([])
    expect(manifest.oneRai).toMatchObject({
      classification: 'planned',
      outcome: 'not-run',
      observedAt: null,
      source: null,
      syntheticOnly: null,
      automated: null,
      cases: null,
      defects: null,
      humanReviewRequired: null,
    })
    expect(releaseEvidenceManifestSchema.parse(manifest)).toEqual(manifest)
  })

  it('records dirty worktrees without changing other evidence semantics', () => {
    const manifest = buildReleaseEvidence({ ...cleanRepository, dirty: true }, {}, generatedAt)

    expect(manifest.release.dirty).toBe(true)
    expect(manifest.checks.test.outcome).toBe('not-run')
    expect(manifest.images.deployed.web.tag).toBeNull()
  })

  it('rejects unknown manifest properties', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, generatedAt)

    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...manifest,
        unrestrictedEnvironment: {},
      }),
    ).toThrow()
  })

  it('hashes safe configuration deterministically without retaining values', () => {
    const first = hashSafeConfiguration({
      AUTH_MODE: 'disabled',
      DATA_MODE: 'live',
      AGENT_SENTINEL_WRITE_ENABLED: false,
    })
    const second = hashSafeConfiguration({
      AGENT_SENTINEL_WRITE_ENABLED: false,
      DATA_MODE: 'live',
      AUTH_MODE: 'disabled',
    })

    expect(first).toEqual(second)
    expect(first).toEqual({
      algorithm: 'sha256',
      hash: '41678332ddd5ec684c316c9a7da110841e666c62d784c6ae7c5bfc4221788be5',
      keys: ['AGENT_SENTINEL_WRITE_ENABLED', 'AUTH_MODE', 'DATA_MODE'],
    })
    expect(JSON.stringify(first)).not.toContain('disabled')
    expect(JSON.stringify(first)).not.toContain('live')
  })

  it.each([
    {
      classification: 'tested',
      algorithm: 'sha256',
      hash: null,
      keys: ['AUTH_MODE'],
    },
    {
      classification: 'tested',
      algorithm: 'sha256',
      hash: 'c'.repeat(64),
      keys: [],
    },
    {
      classification: 'planned',
      algorithm: 'sha256',
      hash: 'c'.repeat(64),
      keys: [],
    },
    {
      classification: 'planned',
      algorithm: 'sha256',
      hash: null,
      keys: ['AUTH_MODE'],
    },
  ] as const)(
    'rejects adversarial externally-authored configuration evidence %#',
    (configuration) => {
      const manifest = buildReleaseEvidence(cleanRepository, {}, generatedAt)

      expect(
        releaseEvidenceManifestSchema.safeParse({
          ...manifest,
          configuration,
        }).success,
      ).toBe(false)
    },
  )

  it('rejects forbidden keys without echoing their values', () => {
    const value = 'never-print-this-secret'

    let error: Error | undefined
    try {
      sanitizeReleaseEvidenceInput({ accessToken: value })
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught : undefined
    }

    expect(error?.message).toContain('forbidden field at accessToken')
    expect(error?.message).not.toContain(value)
  })

  it.each(['modelOutput', 'systemPrompt', 'providerPayload', 'apiKey', 'processEnv'])(
    'rejects compound private field %s',
    (key) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          [key]: 'private material',
        }),
      ).toThrow(new RegExp(`forbidden field at ${key}`))
    },
  )

  const secretShapedValues = [
    ['bearer authorization', ['Bear', 'er ', 'abcdefghijklmnopqrstuvwxyz'].join('')],
    ['JWT', ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJ1c2VyIn0', 'signaturevalue'].join('.')],
    [
      'connection string',
      ['Endpoint=https://example.invalid/;', 'Shared', 'AccessKey=private-value'].join(''),
    ],
    [
      'telemetry connection string',
      [
        'Instrumentation',
        'Key=00000000-0000-0000-0000-000000000000;',
        'IngestionEndpoint=https://example.invalid/',
      ].join(''),
    ],
    ['credential URL', ['https://', 'user', ':', 'password', '@example.invalid/path'].join('')],
    [
      'signed URL',
      ['https://example.invalid/path?sv=2025-01-01&', 'sig', '=private-signature'].join(''),
    ],
    ['private key', ['-----BEGIN ', 'PRIVATE ', 'KEY-----', ' private material'].join('')],
    ['classic GitHub PAT', ['gh', 'p_', 'A'.repeat(36)].join('')],
    ['fine-grained GitHub token', ['github_', 'pat_', 'A'.repeat(24)].join('')],
    ['OAuth GitHub token', ['gh', 'o_', 'A'.repeat(36)].join('')],
    ['GitHub user token', ['gh', 'u_', 'A'.repeat(36)].join('')],
    ['GitHub server token', ['gh', 's_', 'A'.repeat(36)].join('')],
    ['GitHub refresh token', ['gh', 'r_', 'A'.repeat(36)].join('')],
    ['free-text credential assignment', ['access token', '=', 'A'.repeat(24)].join('')],
  ] as const

  it.each(secretShapedValues)(
    'rejects secret-shaped %s values without echoing them',
    (_, value) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          safeConfiguration: { AUTH_MODE: value },
        }),
      ).toThrow(/secret-shaped value at safeConfiguration.AUTH_MODE/)

      try {
        sanitizeReleaseEvidenceInput({
          safeConfiguration: { AUTH_MODE: value },
        })
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).not.toContain(value)
      }
    },
  )

  it('applies secret detection when the typed builder is called directly', () => {
    const value = ['gh', 'p_', 'A'.repeat(36)].join('')

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          safeConfiguration: { AUTH_MODE: value },
        },
        generatedAt,
      ),
    ).toThrow(/secret-shaped value at safeConfiguration.AUTH_MODE/)
  })

  it('bounds free-text summaries and sources', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        checks: {
          lint: {
            classification: 'planned',
            outcome: 'not-run',
            summary: 'a'.repeat(501),
          },
        },
      }),
    ).toThrow()
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            id: 'bounded-source',
            classification: 'planned',
            outcome: 'unknown',
            freshness: 'unknown',
            observedAt: null,
            source: 'a'.repeat(201),
            summary: 'No observation was supplied.',
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a passing check without a command and completion timestamp', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        checks: {
          lint: {
            classification: 'tested',
            outcome: 'pass',
            summary: 'Lint passed.',
          },
        },
      }),
    ).toThrow(/passing check requires command and completedAt/)
  })

  it.each([
    ['live', 'pass'],
    ['live', 'fail'],
    ['synthetic', 'pass'],
    ['synthetic', 'fail'],
    ['tested', 'pass'],
    ['tested', 'fail'],
    ['blocked', 'pass'],
    ['blocked', 'fail'],
    ['planned', 'pass'],
    ['planned', 'fail'],
  ] as const)(
    'rejects %s live-validation %s without complete attribution',
    (classification, outcome) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          liveValidations: [
            {
              id: 'replacement-readiness',
              classification,
              outcome,
              freshness: 'unknown',
              summary: 'An evaluated result cannot omit provenance.',
            },
          ],
        }),
      ).toThrow(
        /live or evaluated validation evidence requires source, observedAt, sanitized scope, and evidence references/,
      )
    },
  )

  it('rejects connector readiness that is not live and fresh', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        connectors: [
          {
            connectorId: 'foundry-primary',
            classification: 'synthetic',
            readiness: 'ready',
            freshness: 'fresh',
            observedAt: '2026-09-04T00:00:00.000Z',
            source: 'sanitized-validation',
            summary: 'Synthetic fixture was ready.',
          },
        ],
      }),
    ).toThrow(/ready connector evidence must be live and fresh/)
  })

  it('rejects blocked or planned classifications paired with pass', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            id: 'blocked-live-check',
            classification: 'blocked',
            outcome: 'pass',
            freshness: 'unknown',
            summary: 'Contradictory.',
          },
        ],
      }),
    ).toThrow(/blocked or planned evidence cannot pass/)
  })

  it.each([true, null] as const)(
    'rejects live OneRAI evidence with syntheticOnly %s',
    (syntheticOnly) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: {
            classification: 'live',
            outcome: 'pass',
            observedAt: '2026-09-04T00:00:00.000Z',
            source: 'sanitized-onerai-summary',
            scope: sanitizedScope,
            evidenceRefs: ['onerai-live-summary'],
            syntheticOnly,
            automated: true,
            cases: 10,
            defects: 0,
            humanReviewRequired: true,
            summary: 'Live provider evaluation passed.',
          },
        }),
      ).toThrow(/non-synthetic OneRAI classification requires syntheticOnly false/)
    },
  )

  it('accepts attributed live OneRAI evidence only when syntheticOnly is false', () => {
    expect(
      sanitizeReleaseEvidenceInput({
        oneRai: {
          classification: 'live',
          outcome: 'pass',
          observedAt: generatedAt,
          source: 'sanitized-onerai-summary',
          scope: sanitizedScope,
          evidenceRefs: ['onerai-live-summary'],
          syntheticOnly: false,
          automated: true,
          cases: 10,
          defects: 0,
          humanReviewRequired: true,
          summary: 'Live provider evaluation passed.',
        },
      }).oneRai,
    ).toMatchObject({ classification: 'live', syntheticOnly: false })
  })

  it.each([false, null] as const)(
    'rejects synthetic OneRAI classification with syntheticOnly %s',
    (syntheticOnly) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: {
            classification: 'synthetic',
            outcome: 'pass',
            observedAt: '2026-09-04T00:00:00.000Z',
            source: 'sanitized-onerai-summary',
            scope: sanitizedScope,
            evidenceRefs: ['onerai-synthetic-summary'],
            syntheticOnly,
            automated: true,
            cases: 10,
            defects: 0,
            humanReviewRequired: true,
            summary: 'Synthetic safety probes passed.',
          },
        }),
      ).toThrow(/synthetic OneRAI classification requires syntheticOnly true/)
    },
  )

  it.each(['observedAt', 'source', 'scope', 'evidenceRefs'] as const)(
    'rejects a tested live-validation pass with missing %s provenance',
    (field) => {
      const evaluated = {
        id: 'replacement-readiness',
        classification: 'tested' as const,
        outcome: 'pass' as const,
        freshness: 'fresh' as const,
        observedAt: '2026-09-04T00:00:00.000Z',
        source: 'sanitized-validation',
        scope: sanitizedScope,
        evidenceRefs: ['validation-summary-2026-09-04'],
        summary: 'Provider reads passed.',
      }
      const incomplete = {
        ...evaluated,
        [field]: field === 'evidenceRefs' ? [] : null,
      }

      expect(() =>
        sanitizeReleaseEvidenceInput({
          liveValidations: [incomplete],
        }),
      ).toThrow(
        /live or evaluated validation evidence requires source, observedAt, sanitized scope, and evidence references/,
      )
    },
  )

  it('requires sanitized scope and evidence references on live evidence', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            id: 'replacement-readiness',
            deploymentRef: 'deployment-candidate-a',
            snapshotRef: 'snapshot-a',
            findingRefs: ['finding-a'],
            classification: 'live',
            outcome: 'pass',
            freshness: 'fresh',
            observedAt: '2026-09-04T00:00:00.000Z',
            source: 'sanitized-validation',
            summary: 'Provider reads passed.',
          },
        ],
      }),
    ).toThrow(
      /live or evaluated validation evidence requires source, observedAt, sanitized scope, and evidence references/,
    )
  })

  it('accepts bounded sanitized live summaries without private payloads', () => {
    const input = sanitizeReleaseEvidenceInput({
      liveValidations: [
        {
          id: 'replacement-readiness',
          deploymentRef: 'deployment-candidate-a',
          snapshotRef: 'snapshot-a',
          findingRefs: ['finding-a'],
          classification: 'live',
          outcome: 'pass',
          freshness: 'fresh',
          observedAt: '2026-09-04T00:00:00.000Z',
          source: 'sanitized-validation',
          scope: sanitizedScope,
          evidenceRefs: ['validation-summary-2026-09-04'],
          summary: 'Seven bounded provider reads passed.',
        },
      ],
    })

    expect(input.liveValidations?.[0]?.scope).toEqual(sanitizedScope)
    expect(input.liveValidations?.[0]?.evidenceRefs).toEqual(['validation-summary-2026-09-04'])
  })

  it('retains fully attributed synthetic validation evidence without treating it as live', () => {
    const manifest = buildReleaseEvidence(
      cleanRepository,
      {
        liveValidations: [
          {
            id: 'synthetic-readiness-probe',
            deploymentRef: null,
            snapshotRef: null,
            findingRefs: [],
            classification: 'synthetic',
            outcome: 'pass',
            freshness: 'fresh',
            observedAt: generatedAt,
            source: 'sanitized-synthetic-validation',
            scope: sanitizedScope,
            evidenceRefs: ['synthetic-validation-summary'],
            summary: 'A bounded synthetic probe passed.',
          },
        ],
      },
      generatedAt,
    )

    expect(manifest.liveValidations[0]).toMatchObject({
      classification: 'synthetic',
      outcome: 'pass',
      scope: sanitizedScope,
    })
  })

  it('enforces full release SHA tags and immutable digests in manifest validation', () => {
    const common = {
      deploymentRef: 'deployment-candidate-a',
      classification: 'live' as const,
      observedAt: generatedAt,
      source: 'sanitized-deployment-observation',
      scope: { ...sanitizedScope, sourceRef: 'container-apps' },
      evidenceRefs: ['deployment-observation-2026-09-04'],
    }

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          deployedImages: {
            ...common,
            web: { tag: cleanRepository.commitSha, digest: imageDigest },
            api: { tag: 'b'.repeat(40), digest: imageDigest },
            jobs: { tag: cleanRepository.commitSha, digest: imageDigest },
          },
        },
        generatedAt,
      ),
    ).toThrow(/deployed component tags must identify one release/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          deployedImages: {
            ...common,
            web: { tag: cleanRepository.commitSha, digest: null },
            api: { tag: cleanRepository.commitSha, digest: null },
            jobs: { tag: cleanRepository.commitSha, digest: null },
          },
        },
        generatedAt,
      ),
    ).toThrow(/live deployment evidence requires full commit tags and image digests/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          deployedImages: {
            ...common,
            web: { tag: '7458b3e', digest: imageDigest },
            api: { tag: '7458b3e', digest: imageDigest },
            jobs: { tag: '7458b3e', digest: imageDigest },
          },
        },
        generatedAt,
      ),
    ).toThrow()

    const manifest = buildReleaseEvidence(
      cleanRepository,
      {
        deployedImages: {
          ...common,
          web: { tag: cleanRepository.commitSha, digest: imageDigest },
          api: { tag: cleanRepository.commitSha, digest: imageDigest },
          jobs: { tag: cleanRepository.commitSha, digest: imageDigest },
        },
      },
      generatedAt,
    )

    expect(manifest.images.deployed.web).toEqual({
      tag: cleanRepository.commitSha,
      digest: imageDigest,
    })
  })

  it('keeps commit and tag invariants in direct manifest validation', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, generatedAt)

    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...manifest,
        images: {
          ...manifest.images,
          expected: {
            ...manifest.images.expected,
            web: { tag: 'b'.repeat(40), digest: null },
          },
        },
      }),
    ).toThrow(/expected image tags must match release.commitSha/)

    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...manifest,
        images: {
          ...manifest.images,
          expected: {
            ...manifest.images.expected,
            web: { tag: 'aaaaaaa', digest: null },
          },
        },
      }),
    ).toThrow()
  })

  it('rejects duplicate validation, connector, and evidence identities', () => {
    const liveValidation = {
      id: 'replacement-readiness',
      deploymentRef: 'deployment-candidate-a',
      snapshotRef: 'snapshot-a',
      findingRefs: ['finding-a'],
      classification: 'live' as const,
      outcome: 'pass' as const,
      freshness: 'fresh' as const,
      observedAt: generatedAt,
      source: 'sanitized-validation',
      scope: sanitizedScope,
      evidenceRefs: ['validation-summary-2026-09-04'],
      summary: 'Provider reads passed.',
    }
    const connector = {
      connectorId: 'foundry-primary',
      deploymentRef: 'deployment-candidate-a',
      snapshotRef: 'snapshot-a',
      findingRefs: ['finding-a'],
      classification: 'live' as const,
      readiness: 'ready' as const,
      freshness: 'fresh' as const,
      observedAt: generatedAt,
      source: 'sanitized-validation',
      scope: { ...sanitizedScope, sourceRef: 'foundry-primary' },
      evidenceRefs: ['foundry-summary-2026-09-04'],
      summary: 'Foundry discovery completed.',
    }

    expect(() =>
      sanitizeReleaseEvidenceInput({ liveValidations: [liveValidation, liveValidation] }),
    ).toThrow(/live validation identities must be unique/)
    expect(() => sanitizeReleaseEvidenceInput({ connectors: [connector, connector] })).toThrow(
      /connector identities must be unique/,
    )
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            ...liveValidation,
            evidenceRefs: ['validation-summary-2026-09-04', 'validation-summary-2026-09-04'],
          },
        ],
      }),
    ).toThrow(/evidence references must be unique/)
  })

  it('enforces generatedAt-relative timestamps and the explicit freshness window', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, generatedAt)

    expect(manifest.release.freshnessWindowHours).toBe(24)
    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...manifest,
        release: { ...manifest.release, freshnessWindowHours: 48 },
      }),
    ).toThrow()
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          checks: {
            lint: {
              classification: 'tested',
              outcome: 'pass',
              command: 'pnpm lint',
              completedAt: '2026-09-04T00:00:00.001Z',
              summary: 'Lint passed.',
            },
          },
        },
        generatedAt,
      ),
    ).toThrow(/evidence timestamps cannot be later than release.generatedAt/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          liveValidations: [
            {
              id: 'stale-readiness',
              deploymentRef: 'deployment-candidate-a',
              snapshotRef: 'snapshot-a',
              findingRefs: ['finding-a'],
              classification: 'live',
              outcome: 'pass',
              freshness: 'fresh',
              observedAt: '2026-09-02T23:59:59.999Z',
              source: 'sanitized-validation',
              scope: sanitizedScope,
              evidenceRefs: ['stale-validation-summary'],
              summary: 'The observation is outside the freshness window.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/freshness must be stale/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          connectors: [
            {
              connectorId: 'fresh-connector',
              deploymentRef: null,
              snapshotRef: null,
              findingRefs: [],
              classification: 'live',
              readiness: 'degraded',
              freshness: 'stale',
              observedAt: generatedAt,
              source: 'sanitized-validation',
              scope: { ...sanitizedScope, sourceRef: 'fresh-connector' },
              evidenceRefs: ['fresh-connector-summary'],
              summary: 'The observation is within the freshness window.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/freshness must be fresh/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          liveValidations: [
            {
              id: 'missing-observation',
              deploymentRef: null,
              snapshotRef: null,
              findingRefs: [],
              classification: 'planned',
              outcome: 'unknown',
              freshness: 'fresh',
              observedAt: null,
              source: null,
              scope: null,
              evidenceRefs: [],
              summary: 'No observation was supplied.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/evidence without observedAt must use unknown freshness/)
  })

  it('rejects a stale live-validation pass even when declared freshness is accurate', () => {
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          liveValidations: [
            {
              id: 'stale-readiness',
              deploymentRef: 'deployment-candidate-a',
              snapshotRef: 'snapshot-a',
              findingRefs: ['finding-a'],
              classification: 'live',
              outcome: 'pass',
              freshness: 'stale',
              observedAt: '2026-09-02T23:59:59.999Z',
              source: 'sanitized-validation',
              scope: sanitizedScope,
              evidenceRefs: ['stale-validation-summary'],
              summary: 'The observation is stale.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/passing live validation must be fresh/)
  })

  it.each([
    ['live', false],
    ['tested', false],
    ['synthetic', true],
  ] as const)(
    'rejects stale passing %s OneRAI evidence after the 24-hour window',
    (classification, syntheticOnly) => {
      expect(() =>
        buildReleaseEvidence(
          cleanRepository,
          {
            oneRai: {
              classification,
              outcome: 'pass',
              observedAt: '2026-09-02T23:59:59.999Z',
              source: 'sanitized-onerai-summary',
              scope: sanitizedScope,
              evidenceRefs: ['onerai-summary'],
              syntheticOnly,
              automated: true,
              cases: 1,
              defects: 0,
              humanReviewRequired: true,
              summary: 'The passing evaluation is outside the freshness window.',
            },
          },
          generatedAt,
        ),
      ).toThrow(/passing OneRAI evidence must be fresh relative to release.generatedAt/)
    },
  )

  it('accepts passing OneRAI evidence at the exact 24-hour freshness boundary', () => {
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          oneRai: {
            classification: 'tested',
            outcome: 'pass',
            observedAt: '2026-09-03T00:00:00.000Z',
            source: 'sanitized-onerai-summary',
            scope: sanitizedScope,
            evidenceRefs: ['onerai-summary'],
            syntheticOnly: false,
            automated: true,
            cases: 1,
            defects: 0,
            humanReviewRequired: true,
            summary: 'The passing evaluation is exactly 24 hours old.',
          },
        },
        generatedAt,
      ),
    ).not.toThrow()
  })

  it('requires an exactly linked deployed candidate before live validation can pass', () => {
    expect(() =>
      buildReleaseEvidence(cleanRepository, linkedReadinessInput, generatedAt),
    ).not.toThrow()

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          liveValidations: linkedReadinessInput.liveValidations,
          connectors: linkedReadinessInput.connectors,
        },
        generatedAt,
      ),
    ).toThrow(/passing live validation requires a live deployed candidate/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          liveValidations: [
            {
              ...linkedReadinessInput.liveValidations[0]!,
              deploymentRef: 'deployment-candidate-b',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/validation deploymentRef must match the deployed candidate/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          liveValidations: [
            {
              ...linkedReadinessInput.liveValidations[0]!,
              observedAt: deploymentObservedAt,
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/validation observation must be after deployment/)
  })

  it('requires exact snapshot and finding linkage without connector contradictions', () => {
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              deploymentRef: 'deployment-candidate-b',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector deploymentRef must match the passing validation/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              snapshotRef: 'snapshot-b',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector snapshotRef must match the passing validation/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              findingRefs: ['finding-b'],
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector findingRefs must match the passing validation/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              readiness: 'degraded',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/passing live validation contradicts connector readiness/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [],
        },
        generatedAt,
      ),
    ).toThrow(/passing live validation requires linked connector evidence/)
  })

  it('requires deployment < connector <= passing validation observation timing', () => {
    expect(() =>
      buildReleaseEvidence(cleanRepository, linkedReadinessInput, generatedAt),
    ).not.toThrow()

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              observedAt: deploymentObservedAt,
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector observation must be after deployment/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              observedAt: '2026-09-03T22:59:59.999Z',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector observation must be after deployment/)

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          ...linkedReadinessInput,
          liveValidations: [
            {
              ...linkedReadinessInput.liveValidations[0]!,
              observedAt: '2026-09-03T23:30:00.000Z',
            },
          ],
          connectors: [
            {
              ...linkedReadinessInput.connectors[0]!,
              observedAt: '2026-09-03T23:30:00.001Z',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/connector observation cannot be after the passing validation/)
  })

  it('rejects stale passing checks and passing checks attached to a dirty release', () => {
    const freshCheck = {
      classification: 'tested' as const,
      outcome: 'pass' as const,
      command: 'pnpm lint',
      completedAt: generatedAt,
      summary: 'Lint passed.',
    }
    const cleanManifest = buildReleaseEvidence(
      cleanRepository,
      { checks: { lint: freshCheck } },
      generatedAt,
    )

    expect(cleanManifest.images.deployed.classification).toBe('planned')
    expect(cleanManifest.checks.typecheck.outcome).toBe('not-run')
    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...cleanManifest,
        release: { ...cleanManifest.release, dirty: true },
      }),
    ).toThrow(/passing checks cannot attest a dirty release/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          checks: {
            lint: {
              ...freshCheck,
              completedAt: '2026-09-02T23:59:59.999Z',
            },
          },
        },
        generatedAt,
      ),
    ).toThrow(/passing checks must be fresh relative to release.generatedAt/)
  })

  it('requires one estate, tenant, and environment while allowing distinct sources', () => {
    const scopedManifest = buildReleaseEvidence(
      cleanRepository,
      {
        deployedImages: {
          deploymentRef: 'deployment-candidate-a',
          classification: 'live',
          observedAt: deploymentObservedAt,
          source: 'sanitized-deployment-observation',
          scope: { ...sanitizedScope, sourceRef: 'container-apps' },
          evidenceRefs: ['deployment-observation'],
          web: { tag: cleanRepository.commitSha, digest: imageDigest },
          api: { tag: cleanRepository.commitSha, digest: imageDigest },
          jobs: { tag: cleanRepository.commitSha, digest: imageDigest },
        },
        liveValidations: [
          {
            id: 'replacement-readiness',
            deploymentRef: 'deployment-candidate-a',
            snapshotRef: 'snapshot-a',
            findingRefs: ['finding-a'],
            classification: 'live',
            outcome: 'pass',
            freshness: 'fresh',
            observedAt: generatedAt,
            source: 'sanitized-validation',
            scope: sanitizedScope,
            evidenceRefs: ['validation-summary'],
            summary: 'Provider reads passed.',
          },
        ],
        connectors: [
          {
            connectorId: 'foundry-primary',
            deploymentRef: 'deployment-candidate-a',
            snapshotRef: 'snapshot-a',
            findingRefs: ['finding-a'],
            classification: 'live',
            readiness: 'ready',
            freshness: 'fresh',
            observedAt: generatedAt,
            source: 'sanitized-validation',
            scope: { ...sanitizedScope, sourceRef: 'foundry-primary' },
            evidenceRefs: ['foundry-summary'],
            summary: 'Foundry discovery completed.',
          },
        ],
        oneRai: {
          classification: 'live',
          outcome: 'pass',
          observedAt: generatedAt,
          source: 'sanitized-onerai-summary',
          scope: { ...sanitizedScope, sourceRef: 'onerai' },
          evidenceRefs: ['onerai-summary'],
          syntheticOnly: false,
          automated: true,
          cases: 1,
          defects: 0,
          humanReviewRequired: true,
          summary: 'A live evaluation passed.',
        },
      },
      generatedAt,
    )

    expect(scopedManifest.images.deployed.scope?.sourceRef).toBe('container-apps')
    expect(scopedManifest.liveValidations[0]?.scope?.sourceRef).toBe('aggregate-health')
    expect(scopedManifest.connectors[0]?.scope?.sourceRef).toBe('foundry-primary')
    expect(scopedManifest.oneRai.scope?.sourceRef).toBe('onerai')

    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...scopedManifest,
        liveValidations: [
          {
            ...scopedManifest.liveValidations[0],
            scope: { ...sanitizedScope, estateRef: 'other-estate' },
          },
        ],
      }),
    ).toThrow(/all manifest evidence must use the same estateRef/)
    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...scopedManifest,
        connectors: [
          {
            ...scopedManifest.connectors[0],
            scope: { ...sanitizedScope, tenantRef: 'other-tenant' },
          },
        ],
      }),
    ).toThrow(/all manifest evidence must use the same tenantRef/)
    expect(() =>
      releaseEvidenceManifestSchema.parse({
        ...scopedManifest,
        oneRai: {
          ...scopedManifest.oneRai,
          scope: { ...sanitizedScope, environmentRef: 'other-environment' },
        },
      }),
    ).toThrow(/all manifest evidence must use the same environmentRef/)
  })

  it.each(['pass', 'fail'] as const)(
    'requires source and observedAt for a synthetic OneRAI %s',
    (outcome) => {
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: {
            classification: 'synthetic',
            outcome,
            scope: sanitizedScope,
            evidenceRefs: ['onerai-synthetic-summary'],
            syntheticOnly: true,
            automated: true,
            cases: 1,
            defects: outcome === 'pass' ? 0 : 1,
            humanReviewRequired: true,
            summary: 'A bounded synthetic safety probe completed.',
          },
        }),
      ).toThrow(
        /live, tested, or evaluated OneRAI evidence requires source, observedAt, sanitized scope, and evidence references/,
      )
    },
  )

  it.each(['pass', 'fail'] as const)(
    'requires scope and evidence references for a synthetic OneRAI %s',
    (outcome) => {
      const evaluatedSynthetic = {
        classification: 'synthetic' as const,
        outcome,
        observedAt: '2026-09-04T00:00:00.000Z',
        source: 'sanitized-onerai-summary',
        scope: sanitizedScope,
        evidenceRefs: ['onerai-synthetic-summary'],
        syntheticOnly: true,
        automated: true,
        cases: 1,
        defects: outcome === 'pass' ? 0 : 1,
        humanReviewRequired: true,
        summary: 'A bounded synthetic safety probe completed.',
      }

      expect(
        sanitizeReleaseEvidenceInput({
          oneRai: evaluatedSynthetic,
        }).oneRai,
      ).toMatchObject({
        scope: sanitizedScope,
        evidenceRefs: ['onerai-synthetic-summary'],
      })
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: { ...evaluatedSynthetic, scope: null },
        }),
      ).toThrow(
        /live, tested, or evaluated OneRAI evidence requires source, observedAt, sanitized scope, and evidence references/,
      )
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: { ...evaluatedSynthetic, evidenceRefs: [] },
        }),
      ).toThrow(
        /live, tested, or evaluated OneRAI evidence requires source, observedAt, sanitized scope, and evidence references/,
      )
    },
  )

  it.each([
    ['tested', 'unknown'],
    ['synthetic', 'pass'],
    ['synthetic', 'fail'],
  ] as const)(
    'requires complete attribution for OneRAI %s/%s evidence',
    (classification, outcome) => {
      const attributed = {
        classification,
        outcome,
        observedAt: generatedAt,
        source: 'sanitized-onerai-summary',
        scope: sanitizedScope,
        evidenceRefs: ['onerai-synthetic-summary'],
        syntheticOnly: classification === 'synthetic',
        automated: true,
        cases: outcome === 'unknown' ? null : 1,
        defects: outcome === 'pass' ? 0 : outcome === 'fail' ? 1 : null,
        humanReviewRequired: true,
        summary: 'A bounded OneRAI evaluation completed.',
      }

      expect(sanitizeReleaseEvidenceInput({ oneRai: attributed }).oneRai).toMatchObject({
        observedAt: generatedAt,
        source: 'sanitized-onerai-summary',
        scope: sanitizedScope,
        evidenceRefs: ['onerai-synthetic-summary'],
      })
      for (const field of ['observedAt', 'source', 'scope', 'evidenceRefs'] as const) {
        const incomplete = {
          ...attributed,
          [field]: field === 'evidenceRefs' ? [] : null,
        }
        expect(() => sanitizeReleaseEvidenceInput({ oneRai: incomplete })).toThrow(
          /live, tested, or evaluated OneRAI evidence requires source, observedAt, sanitized scope, and evidence references/,
        )
      }
    },
  )

  it('requires OneRAI classification and syntheticOnly to agree exactly', () => {
    const common = {
      outcome: 'fail' as const,
      observedAt: generatedAt,
      source: 'sanitized-onerai-summary',
      scope: sanitizedScope,
      evidenceRefs: ['onerai-summary'],
      automated: true,
      cases: 1,
      defects: 1,
      humanReviewRequired: true,
      summary: 'A bounded evaluation completed.',
    }

    expect(() =>
      sanitizeReleaseEvidenceInput({
        oneRai: {
          ...common,
          classification: 'synthetic',
          syntheticOnly: false,
        },
      }),
    ).toThrow(/synthetic OneRAI classification requires syntheticOnly true/)
    expect(() =>
      sanitizeReleaseEvidenceInput({
        oneRai: {
          ...common,
          classification: 'tested',
          syntheticOnly: true,
        },
      }),
    ).toThrow(/non-synthetic OneRAI classification requires syntheticOnly false/)
    expect(() =>
      sanitizeReleaseEvidenceInput({
        oneRai: {
          classification: 'planned',
          outcome: 'not-run',
          observedAt: null,
          source: null,
          scope: null,
          evidenceRefs: [],
          syntheticOnly: false,
          automated: null,
          cases: null,
          defects: null,
          humanReviewRequired: null,
          summary: 'No evaluation was supplied.',
        },
      }),
    ).toThrow(/planned or blocked OneRAI evidence requires syntheticOnly null/)
  })

  it.each([
    ['live', false],
    ['tested', false],
    ['synthetic', true],
  ] as const)(
    'accepts fully attributed %s OneRAI evidence with exact syntheticOnly state',
    (classification, syntheticOnly) => {
      const input = sanitizeReleaseEvidenceInput({
        oneRai: {
          classification,
          outcome: 'fail',
          observedAt: generatedAt,
          source: 'sanitized-onerai-summary',
          scope: sanitizedScope,
          evidenceRefs: ['onerai-summary'],
          syntheticOnly,
          automated: true,
          cases: 1,
          defects: 1,
          humanReviewRequired: true,
          summary: 'A bounded evaluation completed.',
        },
      })

      expect(input.oneRai).toMatchObject({ classification, syntheticOnly })
    },
  )

  it('rejects future deployment, connector, validation, and OneRAI observations', () => {
    const future = '2026-09-04T00:00:00.001Z'
    const commonLive = {
      classification: 'live' as const,
      observedAt: future,
      source: 'sanitized-validation',
      scope: sanitizedScope,
      evidenceRefs: ['future-evidence'],
    }

    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          deployedImages: {
            ...commonLive,
            deploymentRef: 'deployment-candidate-a',
            web: { tag: cleanRepository.commitSha, digest: imageDigest },
            api: { tag: cleanRepository.commitSha, digest: imageDigest },
            jobs: { tag: cleanRepository.commitSha, digest: imageDigest },
          },
        },
        generatedAt,
      ),
    ).toThrow(/evidence timestamps cannot be later than release.generatedAt/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          liveValidations: [
            {
              id: 'future-validation',
              ...commonLive,
              deploymentRef: 'deployment-candidate-a',
              snapshotRef: 'snapshot-a',
              findingRefs: ['finding-a'],
              outcome: 'pass',
              freshness: 'fresh',
              summary: 'Future evidence is invalid.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/evidence timestamps cannot be later than release.generatedAt/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          connectors: [
            {
              connectorId: 'future-connector',
              ...commonLive,
              deploymentRef: 'deployment-candidate-a',
              snapshotRef: 'snapshot-a',
              findingRefs: ['finding-a'],
              readiness: 'ready',
              freshness: 'fresh',
              summary: 'Future evidence is invalid.',
            },
          ],
        },
        generatedAt,
      ),
    ).toThrow(/evidence timestamps cannot be later than release.generatedAt/)
    expect(() =>
      buildReleaseEvidence(
        cleanRepository,
        {
          oneRai: {
            ...commonLive,
            outcome: 'pass',
            syntheticOnly: false,
            automated: true,
            cases: 1,
            defects: 0,
            humanReviewRequired: true,
            summary: 'Future evidence is invalid.',
          },
        },
        generatedAt,
      ),
    ).toThrow(/evidence timestamps cannot be later than release.generatedAt/)
  })

  it('keeps the committed JSON Schema synchronized with the runtime schema', async () => {
    const committed = JSON.parse(
      await readFile(new URL('../release-evidence/v1/schema.json', import.meta.url), 'utf8'),
    ) as unknown

    expect(committed).toEqual(generateReleaseEvidenceJsonSchema())
  })

  it('generates the typed release-readiness reference contract', () => {
    const structuralContract = JSON.stringify(generateReleaseEvidenceJsonSchema())

    expect(structuralContract).toContain('"deploymentRef"')
    expect(structuralContract).toContain('"snapshotRef"')
    expect(structuralContract).toContain('"findingRefs"')
  })

  it('defaults ergonomic input fields but requires every field in output manifests', () => {
    const defaultedInput = sanitizeReleaseEvidenceInput({
      deployedImages: {
        classification: 'planned',
        web: { tag: null, digest: null },
        api: { tag: null, digest: null },
        jobs: { tag: null, digest: null },
      },
      checks: {
        lint: {
          classification: 'planned',
          outcome: 'not-run',
          summary: 'No lint result was supplied.',
        },
      },
      liveValidations: [
        {
          id: 'planned-validation',
          classification: 'planned',
          outcome: 'not-run',
          freshness: 'unknown',
          summary: 'No validation evidence was supplied.',
        },
      ],
      connectors: [
        {
          connectorId: 'planned-connector',
          classification: 'planned',
          readiness: 'planned',
          freshness: 'unknown',
          summary: 'No connector evidence was supplied.',
        },
      ],
      oneRai: {
        classification: 'planned',
        outcome: 'not-run',
        syntheticOnly: null,
        automated: null,
        cases: null,
        defects: null,
        humanReviewRequired: null,
        summary: 'No OneRAI evidence was supplied.',
      },
    })

    expect(defaultedInput.deployedImages).toMatchObject({
      deploymentRef: null,
      observedAt: null,
      source: null,
      scope: null,
      evidenceRefs: [],
    })
    expect(defaultedInput.checks?.lint).toMatchObject({
      command: null,
      completedAt: null,
    })
    expect(defaultedInput.liveValidations?.[0]).toMatchObject({
      deploymentRef: null,
      snapshotRef: null,
      findingRefs: [],
      observedAt: null,
      source: null,
      scope: null,
      evidenceRefs: [],
    })
    expect(defaultedInput.connectors?.[0]).toMatchObject({
      deploymentRef: null,
      snapshotRef: null,
      findingRefs: [],
      observedAt: null,
      source: null,
      scope: null,
      evidenceRefs: [],
    })
    expect(defaultedInput.oneRai).toMatchObject({
      observedAt: null,
      source: null,
      scope: null,
      evidenceRefs: [],
    })

    const completeManifest = buildReleaseEvidence(
      cleanRepository,
      linkedReadinessInput,
      generatedAt,
    )
    const omissions: readonly [string, (manifest: ReleaseEvidenceManifest) => unknown][] = [
      [
        'images.deployed.deploymentRef',
        (manifest) => omitDeployedImageProperty(manifest, 'deploymentRef'),
      ],
      [
        'images.deployed.observedAt',
        (manifest) => omitDeployedImageProperty(manifest, 'observedAt'),
      ],
      ['images.deployed.source', (manifest) => omitDeployedImageProperty(manifest, 'source')],
      ['images.deployed.scope', (manifest) => omitDeployedImageProperty(manifest, 'scope')],
      [
        'images.deployed.evidenceRefs',
        (manifest) => omitDeployedImageProperty(manifest, 'evidenceRefs'),
      ],
      ['checks.lint.command', (manifest) => omitCheckProperty(manifest, 'command')],
      ['checks.lint.completedAt', (manifest) => omitCheckProperty(manifest, 'completedAt')],
      [
        'liveValidations[0].deploymentRef',
        (manifest) => omitLiveValidationProperty(manifest, 'deploymentRef'),
      ],
      [
        'liveValidations[0].snapshotRef',
        (manifest) => omitLiveValidationProperty(manifest, 'snapshotRef'),
      ],
      [
        'liveValidations[0].findingRefs',
        (manifest) => omitLiveValidationProperty(manifest, 'findingRefs'),
      ],
      [
        'liveValidations[0].observedAt',
        (manifest) => omitLiveValidationProperty(manifest, 'observedAt'),
      ],
      ['liveValidations[0].source', (manifest) => omitLiveValidationProperty(manifest, 'source')],
      ['liveValidations[0].scope', (manifest) => omitLiveValidationProperty(manifest, 'scope')],
      [
        'liveValidations[0].evidenceRefs',
        (manifest) => omitLiveValidationProperty(manifest, 'evidenceRefs'),
      ],
      [
        'connectors[0].deploymentRef',
        (manifest) => omitConnectorProperty(manifest, 'deploymentRef'),
      ],
      ['connectors[0].snapshotRef', (manifest) => omitConnectorProperty(manifest, 'snapshotRef')],
      ['connectors[0].findingRefs', (manifest) => omitConnectorProperty(manifest, 'findingRefs')],
      ['connectors[0].observedAt', (manifest) => omitConnectorProperty(manifest, 'observedAt')],
      ['connectors[0].source', (manifest) => omitConnectorProperty(manifest, 'source')],
      ['connectors[0].scope', (manifest) => omitConnectorProperty(manifest, 'scope')],
      ['connectors[0].evidenceRefs', (manifest) => omitConnectorProperty(manifest, 'evidenceRefs')],
      ['oneRai.observedAt', (manifest) => omitOneRaiProperty(manifest, 'observedAt')],
      ['oneRai.source', (manifest) => omitOneRaiProperty(manifest, 'source')],
      ['oneRai.scope', (manifest) => omitOneRaiProperty(manifest, 'scope')],
      ['oneRai.evidenceRefs', (manifest) => omitOneRaiProperty(manifest, 'evidenceRefs')],
    ]

    for (const [path, omitReference] of omissions) {
      expect(
        releaseEvidenceManifestSchema.safeParse(omitReference(completeManifest)),
        path,
      ).toMatchObject({ success: false })
    }

    const generatedSchema = generateReleaseEvidenceJsonSchema()
    for (const property of [
      'deploymentRef',
      'snapshotRef',
      'findingRefs',
      'command',
      'completedAt',
      'observedAt',
      'source',
      'scope',
      'evidenceRefs',
    ]) {
      const definitions = schemasDefiningProperty(generatedSchema, property)
      expect(definitions.length, property).toBeGreaterThan(0)
      for (const definition of definitions) {
        expect(definition.required, property).toContain(property)
      }
    }
    expect(JSON.stringify(generatedSchema)).not.toContain('"default"')
  })

  it('keeps the committed repository-only example valid and explicitly unknown', async () => {
    const example = releaseEvidenceManifestSchema.parse(
      JSON.parse(
        await readFile(
          new URL('../release-evidence/v1/examples/repository-only.json', import.meta.url),
          'utf8',
        ),
      ) as unknown,
    )

    expect(example.release.commitSha).toBe('ae531c2ce98afebc7933425091f3f2912edcd53e')
    expect(example.release.freshnessWindowHours).toBe(24)
    expect(example.images.expected.web.tag).toBe(example.release.commitSha)
    expect(Object.values(example.checks).every((check) => check.outcome !== 'pass')).toBe(true)
    expect(example.images.deployed.web.tag).toBeNull()
    expect(example.liveValidations).toEqual([])
    expect(example.connectors).toEqual([])
  })
})
