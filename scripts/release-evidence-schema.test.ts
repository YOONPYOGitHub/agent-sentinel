import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

import {
  buildReleaseEvidence,
  generateReleaseEvidenceJsonSchema,
  hashSafeConfiguration,
  releaseEvidenceManifestSchema,
  sanitizeReleaseEvidenceInput,
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

  it('rejects a live pass without a source and observation timestamp', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            id: 'replacement-readiness',
            classification: 'live',
            outcome: 'pass',
            freshness: 'fresh',
            summary: 'Provider reads passed.',
          },
        ],
      }),
    ).toThrow(/live evidence requires source and observedAt/)
  })

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

  it('rejects OneRAI evidence classified live when the evaluation is synthetic', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        oneRai: {
          classification: 'live',
          outcome: 'pass',
          observedAt: '2026-09-04T00:00:00.000Z',
          source: 'sanitized-onerai-summary',
          syntheticOnly: true,
          automated: true,
          cases: 10,
          defects: 0,
          humanReviewRequired: true,
          summary: 'Synthetic safety probes passed.',
        },
      }),
    ).toThrow(/synthetic OneRAI evidence must use the synthetic classification/)
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

  it('requires sanitized scope and evidence references on live evidence', () => {
    expect(() =>
      sanitizeReleaseEvidenceInput({
        liveValidations: [
          {
            id: 'replacement-readiness',
            classification: 'live',
            outcome: 'pass',
            freshness: 'fresh',
            observedAt: '2026-09-04T00:00:00.000Z',
            source: 'sanitized-validation',
            summary: 'Provider reads passed.',
          },
        ],
      }),
    ).toThrow(/live evidence requires sanitized scope and evidence references/)
  })

  it('accepts bounded sanitized live summaries without private payloads', () => {
    const input = sanitizeReleaseEvidenceInput({
      liveValidations: [
        {
          id: 'replacement-readiness',
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

  it('enforces full release SHA tags and immutable digests in manifest validation', () => {
    const common = {
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
      buildReleaseEvidence(
        cleanRepository,
        { liveValidations: [liveValidation, liveValidation] },
        generatedAt,
      ),
    ).toThrow(/live validation identities must be unique/)
    expect(() =>
      buildReleaseEvidence(cleanRepository, { connectors: [connector, connector] }, generatedAt),
    ).toThrow(/connector identities must be unique/)
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
      ).toThrow(/synthetic OneRAI pass or fail requires source and observedAt/)
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
      ).toThrow(/evaluated OneRAI evidence requires sanitized scope and evidence references/)
      expect(() =>
        sanitizeReleaseEvidenceInput({
          oneRai: { ...evaluatedSynthetic, evidenceRefs: [] },
        }),
      ).toThrow(/evaluated OneRAI evidence requires sanitized scope and evidence references/)
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
