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

describe('release evidence schema', () => {
  it('builds a strict repository-only manifest without turning missing evidence into pass', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, '2026-09-04T00:00:00.000Z')

    expect(manifest.schemaVersion).toBe('1.0.0')
    expect(manifest.release).toEqual({
      commitSha: cleanRepository.commitSha,
      dirty: false,
      generatedAt: '2026-09-04T00:00:00.000Z',
    })
    expect(manifest.images.expected).toMatchObject({
      classification: 'tested',
      web: { tag: 'aaaaaaa', digest: null },
      api: { tag: 'aaaaaaa', digest: null },
      jobs: { tag: 'aaaaaaa', digest: null },
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
    const manifest = buildReleaseEvidence(
      { ...cleanRepository, dirty: true },
      {},
      '2026-09-04T00:00:00.000Z',
    )

    expect(manifest.release.dirty).toBe(true)
    expect(manifest.checks.test.outcome).toBe('not-run')
    expect(manifest.images.deployed.web.tag).toBeNull()
  })

  it('rejects unknown manifest properties', () => {
    const manifest = buildReleaseEvidence(cleanRepository, {}, '2026-09-04T00:00:00.000Z')

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
    ['credential URL', ['https://', 'user', ':', 'password', '@example.invalid/path'].join('')],
    [
      'signed URL',
      ['https://example.invalid/path?sv=2025-01-01&', 'sig', '=private-signature'].join(''),
    ],
    ['private key', ['-----BEGIN ', 'PRIVATE ', 'KEY-----', ' private material'].join('')],
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
          scope: {
            estateRef: 'replacement-estate',
            tenantRef: 'replacement-tenant',
            environmentRef: 'dev',
            sourceRef: 'aggregate-health',
          },
          evidenceRefs: ['validation-summary-2026-09-04'],
          summary: 'Seven bounded provider reads passed.',
        },
      ],
    })

    expect(input.liveValidations?.[0]?.scope).toEqual({
      estateRef: 'replacement-estate',
      tenantRef: 'replacement-tenant',
      environmentRef: 'dev',
      sourceRef: 'aggregate-health',
    })
    expect(input.liveValidations?.[0]?.evidenceRefs).toEqual(['validation-summary-2026-09-04'])
  })

  it('rejects contradictory deployed image observations', () => {
    const common = {
      classification: 'live' as const,
      observedAt: '2026-09-04T00:00:00.000Z',
      source: 'sanitized-deployment-observation',
      scope: {
        estateRef: 'replacement-estate',
        tenantRef: 'replacement-tenant',
        environmentRef: 'dev',
        sourceRef: 'container-apps',
      },
      evidenceRefs: ['deployment-observation-2026-09-04'],
    }

    expect(() =>
      sanitizeReleaseEvidenceInput({
        deployedImages: {
          ...common,
          web: { tag: '7458b3e', digest: null },
          api: { tag: 'different', digest: null },
          jobs: { tag: '7458b3e', digest: null },
        },
      }),
    ).toThrow(/deployed component tags must identify one release/)

    expect(() =>
      sanitizeReleaseEvidenceInput({
        deployedImages: {
          ...common,
          web: { tag: null, digest: null },
          api: { tag: null, digest: null },
          jobs: { tag: null, digest: null },
        },
      }),
    ).toThrow(/live deployment evidence requires all deployed tags/)
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
    expect(Object.values(example.checks).every((check) => check.outcome !== 'pass')).toBe(true)
    expect(example.images.deployed.web.tag).toBeNull()
    expect(example.liveValidations).toEqual([])
    expect(example.connectors).toEqual([])
  })
})
