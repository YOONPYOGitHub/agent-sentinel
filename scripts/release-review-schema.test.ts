import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  missingAccessibilityEvidence,
  normalizeAccessibilityArtifact,
} from './accessibility-evidence.js'
import { oneRaiHarms } from './onerai-safety-report.js'
import { canonicalJson } from './release-evidence-schema.js'
import {
  assertReleaseReviewContainsNoSensitiveContent,
  buildReleaseReviewBundle,
  deterministicOneRaiEvaluationRef,
  generateReleaseReviewBundleJsonSchema,
  generateReleaseReviewInputJsonSchema,
  releaseReviewBundleSchema,
  releaseReviewInputSchema,
  THREAT_CONTROL_CATALOG,
  type AccessibilityEvidence,
  type ReleaseReviewBundle,
} from './release-review-schema.js'

const repository = { commitSha: 'a'.repeat(40), dirty: false } as const
const generatedAt = '2026-09-14T01:00:00.000Z'

function accessibilityPass(): AccessibilityEvidence {
  return normalizeAccessibilityArtifact(
    {
      observedAt: '2026-09-14T00:00:00.000Z',
      results: [{ surfaceId: 'estate-overview', violations: [] }],
    },
    'accessibility-run',
  )
}

function rehash(bundle: ReleaseReviewBundle): ReleaseReviewBundle {
  const unsigned = { ...bundle, canonicalHash: undefined }
  delete (unsigned as { canonicalHash?: unknown }).canonicalHash
  return {
    ...bundle,
    canonicalHash: {
      ...bundle.canonicalHash,
      value: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
    },
  }
}

function failingOneRaiInput() {
  return {
    classification: 'tested' as const,
    observedAt: '2026-09-14T00:30:00.000Z',
    deterministic: true,
    scenarioResults: oneRaiHarms
      .map((harm, index) => ({
        scenarioId: `scenario-${String(index + 1).padStart(2, '0')}`,
        harm,
        outcome: index === 0 ? ('fail' as const) : ('pass' as const),
        trials: 1,
        defects: index === 0 ? 1 : 0,
        evidenceRefs: [`onerai-scenario-${index + 1}`],
      }))
      .reverse(),
    evidenceRefs: ['onerai-evaluation'],
    summary: 'Deterministic sanitized OneRAI evaluation contains one defect.',
  }
}

describe('release review bundle schema', () => {
  it('builds a strict offline bundle with every missing gate blocked', () => {
    const bundle = buildReleaseReviewBundle(
      repository,
      {},
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(bundle).toMatchObject({
      schemaVersion: '2.0.0',
      bundleType: 'sanitized-release-review-evidence',
      workflow: {
        mode: 'dry-run-no-submit',
        externalSubmission: false,
        deploymentPerformed: false,
      },
      readinessGate: { status: 'blocked' },
    })
    expect(
      Object.values(bundle.humanDecisions).every((decision) => decision.status === 'pending'),
    ).toBe(true)
    expect(bundle.gateChecks.source.status).toBe('ready')
    expect(bundle.gateChecks.declaredBlockers.status).toBe('ready')
    expect(
      Object.entries(bundle.gateChecks)
        .filter(([name]) => !['source', 'declaredBlockers'].includes(name))
        .every(([, gate]) => gate.status === 'blocked'),
    ).toBe(true)
    expect(releaseReviewBundleSchema.parse(bundle)).toEqual(bundle)
  })

  it('produces a canonical hash independent of input property order', () => {
    const first = buildReleaseReviewBundle(
      repository,
      { knownIssues: [], blockers: [], evidenceIndex: [] },
      missingAccessibilityEvidence(),
      generatedAt,
    )
    const second = buildReleaseReviewBundle(
      repository,
      { evidenceIndex: [], blockers: [], knownIssues: [] },
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(first.canonicalHash).toEqual(second.canonicalHash)
  })

  it('normalizes set-like review inventories before canonical hashing', () => {
    const issue = (id: string) => ({
      id,
      category: 'known-issue' as const,
      severity: 'low' as const,
      status: 'open' as const,
      summary: `Sanitized ${id}.`,
      evidenceRefs: [],
    })
    const first = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'z-evidence', kind: 'known-issue', label: 'Z evidence' },
          { id: 'a-evidence', kind: 'known-issue', label: 'A evidence' },
        ],
        knownIssues: [issue('z-issue'), issue('a-issue')],
      },
      missingAccessibilityEvidence(),
      generatedAt,
    )
    const second = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'a-evidence', kind: 'known-issue', label: 'A evidence' },
          { id: 'z-evidence', kind: 'known-issue', label: 'Z evidence' },
        ],
        knownIssues: [issue('a-issue'), issue('z-issue')],
      },
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(first).toEqual(second)
  })

  it('rejects a rehashed bundle whose canonical review inventory order was changed', () => {
    const original = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'z-evidence', kind: 'known-issue', label: 'Z evidence' },
          { id: 'a-evidence', kind: 'known-issue', label: 'A evidence' },
        ],
      },
      missingAccessibilityEvidence(),
      generatedAt,
    )
    const changed = rehash({ ...original, evidenceIndex: [...original.evidenceIndex].reverse() })

    expect(releaseReviewBundleSchema.safeParse(changed).success).toBe(false)
  })

  it.each([
    [
      'gate status',
      (bundle: ReleaseReviewBundle) => ({
        ...bundle,
        gateChecks: { ...bundle.gateChecks, security: { status: 'ready' as const, reasons: [] } },
      }),
    ],
    [
      'readiness',
      (bundle: ReleaseReviewBundle) => ({
        ...bundle,
        readinessGate: { status: 'ready' as const, reasons: [] },
      }),
    ],
    [
      'connector state',
      (bundle: ReleaseReviewBundle) => ({
        ...bundle,
        connectors: [
          {
            connectorId: 'fabricated',
            state: 'live' as const,
            evidenceRefs: [],
            summary: 'Fabricated connector.',
          },
        ],
      }),
    ],
  ])('rejects rehashed fabricated %s', (_, mutate) => {
    const original = buildReleaseReviewBundle(
      repository,
      {},
      missingAccessibilityEvidence(),
      generatedAt,
    )
    const changed = rehash(mutate(original))

    expect(releaseReviewBundleSchema.safeParse(changed).success).toBe(false)
  })

  it('maps every versioned threat to its exact control and blocks missing evidence', () => {
    const bundle = buildReleaseReviewBundle(
      repository,
      {},
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(
      bundle.threatControls.map(({ threatId, controlId }) => ({ threatId, controlId })),
    ).toEqual(THREAT_CONTROL_CATALOG)
    expect(bundle.threatControls.every((control) => control.state === 'unknown')).toBe(true)
    expect(bundle.gateChecks.security.reasons).toHaveLength(THREAT_CONTROL_CATALOG.length + 1)
    expect(new Set(bundle.threatControls.map((control) => control.threatId))).toEqual(
      new Set([
        'spoofing',
        'tampering',
        'repudiation',
        'information-disclosure',
        'denial-of-service',
        'elevation-of-privilege',
        'cross-tenant-correlation',
        'unsafe-ai-output',
      ]),
    )
  })

  it('rejects duplicate or mismatched threat-control input', () => {
    const control = {
      ...THREAT_CONTROL_CATALOG[0],
      state: 'implemented' as const,
      evidenceRefs: ['security-review'],
      summary: 'The control was reviewed.',
    }

    expect(releaseReviewInputSchema.safeParse({ threatControls: [control, control] }).success).toBe(
      false,
    )
    expect(
      releaseReviewInputSchema.safeParse({
        threatControls: [{ ...control, threatId: 'tampering' }],
      }).success,
    ).toBe(false)
  })

  it('rejects duplicate review item ids and overlapping known issue/blocker ids', () => {
    const finding = {
      id: 'finding-1',
      severity: 'high' as const,
      status: 'open' as const,
      summary: 'A sanitized finding.',
      evidenceRefs: [],
    }
    expect(
      releaseReviewInputSchema.safeParse({
        securityReview: {
          outcome: 'fail',
          reviewedAt: generatedAt,
          evidenceRefs: ['security-review'],
          findings: [finding, finding],
          summary: 'A sanitized review.',
        },
      }).success,
    ).toBe(false)

    const blocker = {
      id: 'shared-id',
      category: 'quality' as const,
      severity: 'high' as const,
      status: 'open' as const,
      summary: 'A sanitized issue.',
      evidenceRefs: [],
    }
    expect(
      releaseReviewInputSchema.safeParse({
        knownIssues: [blocker],
        blockers: [blocker],
      }).success,
    ).toBe(false)
  })

  it('requires OneRAI scenario outcomes to match their defect counts', () => {
    const base = {
      scenarioId: 'scenario-1',
      harm: oneRaiHarms[0],
      trials: 1,
      evidenceRefs: ['scenario-evidence'],
    }
    const input = {
      classification: 'tested' as const,
      observedAt: generatedAt,
      deterministic: true,
      evidenceRefs: ['onerai-evaluation'],
      summary: 'A deterministic evaluation.',
    }

    expect(
      releaseReviewInputSchema.safeParse({
        oneRaiSafety: {
          ...input,
          scenarioResults: [{ ...base, outcome: 'fail', defects: 0 }],
        },
      }).success,
    ).toBe(false)
    expect(
      releaseReviewInputSchema.safeParse({
        oneRaiSafety: {
          ...input,
          scenarioResults: [{ ...base, outcome: 'blocked', defects: 1 }],
        },
      }).success,
    ).toBe(false)
    expect(
      releaseReviewInputSchema.safeParse({
        oneRaiSafety: {
          ...input,
          deterministic: false,
          scenarioResults: [{ ...base, outcome: 'pass', defects: 0 }],
        },
      }).success,
    ).toBe(false)
    expect(
      releaseReviewInputSchema.safeParse({
        oneRaiSafety: {
          ...input,
          scenarioResults: [],
        },
      }).success,
    ).toBe(false)
  })

  it('derives a stable OneRAI evaluation reference and sorted scenario inventory', () => {
    const oneRaiSafety = failingOneRaiInput()
    const evidenceIndex = [
      { id: 'onerai-evaluation', kind: 'onerai-safety' as const, label: 'Evaluation summary' },
      ...oneRaiSafety.scenarioResults.map((scenario) => ({
        id: scenario.evidenceRefs[0]!,
        kind: 'onerai-safety' as const,
        label: `Scenario ${scenario.scenarioId}`,
      })),
    ]
    const bundle = buildReleaseReviewBundle(
      repository,
      { evidenceIndex, oneRaiSafety },
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(bundle.oneRaiSafety.outcome).toBe('fail')
    expect(bundle.oneRaiSafety.scenarioIds).toEqual([...bundle.oneRaiSafety.scenarioIds].sort())
    expect(bundle.oneRaiSafety.evaluationRef).toBe(deterministicOneRaiEvaluationRef(oneRaiSafety))
    expect(bundle.oneRaiSafety.evaluationRef).toMatch(/^onerai-sha256:[a-f0-9]{64}$/)
  })

  it('preserves a deterministic OneRAI failure even when harm coverage is incomplete', () => {
    const oneRaiSafety = {
      classification: 'tested' as const,
      observedAt: '2026-09-14T00:30:00.000Z',
      deterministic: true as const,
      scenarioResults: [
        {
          scenarioId: 'failing-scenario',
          harm: oneRaiHarms[0],
          outcome: 'fail' as const,
          trials: 1,
          defects: 1,
          evidenceRefs: ['onerai-scenario'],
        },
      ],
      evidenceRefs: ['onerai-evaluation'],
      summary: 'A deterministic sanitized OneRAI failure.',
    }
    const bundle = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'onerai-evaluation', kind: 'onerai-safety', label: 'Evaluation summary' },
          { id: 'onerai-scenario', kind: 'onerai-safety', label: 'Scenario result' },
        ],
        oneRaiSafety,
      },
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(bundle.oneRaiSafety.outcome).toBe('fail')
    const changed = rehash({
      ...bundle,
      oneRaiSafety: { ...bundle.oneRaiSafety, outcome: 'blocked' },
    })
    expect(releaseReviewBundleSchema.safeParse(changed).success).toBe(false)
  })

  it('rejects duplicate OneRAI scenario IDs and a tampered deterministic reference', () => {
    const oneRaiSafety = failingOneRaiInput()
    oneRaiSafety.scenarioResults[1]!.scenarioId = oneRaiSafety.scenarioResults[0]!.scenarioId
    expect(releaseReviewInputSchema.safeParse({ oneRaiSafety }).success).toBe(false)

    const bundle = buildReleaseReviewBundle(
      repository,
      {},
      missingAccessibilityEvidence(),
      generatedAt,
    )
    const changed = rehash({
      ...bundle,
      oneRaiSafety: {
        ...bundle.oneRaiSafety,
        evaluationRef: `onerai-sha256:${'b'.repeat(64)}`,
      },
    })
    expect(releaseReviewBundleSchema.safeParse(changed).success).toBe(false)
  })

  it('requires declared decision evidence and refuses approval over blocked evidence', () => {
    expect(() =>
      buildReleaseReviewBundle(
        repository,
        {
          humanDecisions: {
            accessibility: {
              status: 'approved',
              decidedAt: '2026-09-14T00:30:00.000Z',
              decisionRef: 'accessibility-approval',
              summary: 'Accessibility was approved.',
            },
          },
        },
        missingAccessibilityEvidence(),
        generatedAt,
      ),
    ).toThrow(/evidence reference accessibility-approval is not declared/)

    expect(() =>
      buildReleaseReviewBundle(
        repository,
        {
          evidenceIndex: [
            { id: 'accessibility-approval', kind: 'decision', label: 'Accessibility decision' },
          ],
          humanDecisions: {
            accessibility: {
              status: 'approved',
              decidedAt: '2026-09-14T00:30:00.000Z',
              decisionRef: 'accessibility-approval',
              summary: 'Accessibility was approved.',
            },
          },
        },
        missingAccessibilityEvidence(),
        generatedAt,
      ),
    ).toThrow(/Accessibility cannot be approved/)
  })

  it('requires evidence references to use the gate-specific kind', () => {
    expect(() =>
      buildReleaseReviewBundle(
        repository,
        {
          evidenceIndex: [
            { id: 'accessibility-run', kind: 'command-result', label: 'Wrong evidence kind' },
          ],
        },
        accessibilityPass(),
        generatedAt,
      ),
    ).toThrow(/must use kind accessibility/)
  })

  it('accepts a scoped human approval only after its evidence passes', () => {
    const bundle = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'accessibility-run', kind: 'accessibility', label: 'Sanitized axe result' },
          { id: 'accessibility-approval', kind: 'decision', label: 'Accessibility decision' },
        ],
        humanDecisions: {
          accessibility: {
            status: 'approved',
            decidedAt: '2026-09-14T00:30:00.000Z',
            decisionRef: 'accessibility-approval',
            summary: 'Accessibility evidence was reviewed.',
          },
        },
      },
      accessibilityPass(),
      generatedAt,
    )

    expect(bundle.gateChecks.accessibility.status).toBe('ready')
    expect(bundle.humanDecisions.accessibility.status).toBe('approved')
    expect(bundle.readinessGate.status).toBe('blocked')
  })

  it('maps open blockers to their gate and prevents an affected specialist approval', () => {
    const blocker = {
      id: 'accessibility-review-blocker',
      category: 'accessibility' as const,
      severity: 'high' as const,
      status: 'open' as const,
      summary: 'Accessibility review remains blocked.',
      evidenceRefs: [],
    }
    const bundle = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'accessibility-run', kind: 'accessibility', label: 'Sanitized axe result' },
        ],
        blockers: [blocker],
      },
      accessibilityPass(),
      generatedAt,
    )
    expect(bundle.gateChecks.accessibility).toEqual({
      status: 'blocked',
      reasons: ['Open accessibility blocker accessibility-review-blocker.'],
    })
    expect(() =>
      buildReleaseReviewBundle(
        repository,
        {
          evidenceIndex: [
            { id: 'accessibility-run', kind: 'accessibility', label: 'Sanitized axe result' },
            { id: 'accessibility-approval', kind: 'decision', label: 'Accessibility decision' },
          ],
          blockers: [blocker],
          humanDecisions: {
            accessibility: {
              status: 'approved',
              decidedAt: '2026-09-14T00:30:00.000Z',
              decisionRef: 'accessibility-approval',
              summary: 'Accessibility evidence was reviewed.',
            },
          },
        },
        accessibilityPass(),
        generatedAt,
      ),
    ).toThrow(/Accessibility cannot be approved/)
  })

  it('rejects a rehashed accessibility outcome that was not derived from its surfaces', () => {
    const original = buildReleaseReviewBundle(
      repository,
      {
        evidenceIndex: [
          { id: 'accessibility-run', kind: 'accessibility', label: 'Sanitized axe result' },
        ],
      },
      accessibilityPass(),
      generatedAt,
    )
    const changed = rehash({
      ...original,
      accessibility: { ...original.accessibility, outcome: 'blocked' },
    })

    expect(releaseReviewBundleSchema.safeParse(changed).success).toBe(false)
  })

  it.each([
    ['email', { summary: 'Contact person@example.com' }],
    ['tenant UUID', { summary: 'Tenant 11111111-1111-4111-8111-111111111111' }],
    ['UUID-shaped identifier', { summary: 'Tenant 11111111-1111-0111-0111-111111111111' }],
    ['subscription path', { summary: '/subscriptions/replacement/resourceGroups/example' }],
    ['Unix path', { summary: '/home/person/private.json' }],
    ['Windows path', { summary: 'C:\\Users\\Person\\private.json' }],
    ['tenant field', { tenantId: 'replacement-tenant' }],
    ['raw payload', { rawPayload: { safe: true } }],
    ['secret', { summary: `Bearer ${'a'.repeat(32)}` }],
  ])('rejects %s without echoing the identifying value', (_, value) => {
    let error: Error | undefined
    try {
      assertReleaseReviewContainsNoSensitiveContent(value)
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught : undefined
    }

    expect(error).toBeDefined()
    expect(error?.message).not.toContain(JSON.stringify(value))
  })

  it('does not echo an identifying object key in sanitization errors', () => {
    const identifyingKey = 'person@example.com'
    let error: Error | undefined
    try {
      assertReleaseReviewContainsNoSensitiveContent({ [identifyingKey]: 'sanitized' })
    } catch (caught: unknown) {
      error = caught instanceof Error ? caught : undefined
    }

    expect(error).toBeDefined()
    expect(error?.message).not.toContain(identifyingKey)
  })

  it('supports the maximum declared blocker inventory without overflowing derived gates', () => {
    const blockers = Array.from({ length: 100 }, (_, index) => ({
      id: `blocker-${String(index + 1).padStart(3, '0')}`,
      category: 'quality' as const,
      severity: 'low' as const,
      status: 'open' as const,
      summary: `Sanitized blocker ${index + 1}.`,
      evidenceRefs: [],
    }))

    const bundle = buildReleaseReviewBundle(
      repository,
      { blockers },
      missingAccessibilityEvidence(),
      generatedAt,
    )

    expect(bundle.gateChecks.declaredBlockers.reasons).toHaveLength(100)
    expect(bundle.readinessGate.status).toBe('blocked')
    expect(bundle.readinessGate.reasons.length).toBeGreaterThan(100)
  })

  it('keeps committed schemas, template, fixtures, and blocked example synchronized', async () => {
    const [inputSchema, bundleSchema, template, example] = await Promise.all([
      readFile(new URL('../release-evidence/v2/input.schema.json', import.meta.url), 'utf8'),
      readFile(new URL('../release-evidence/v2/bundle.schema.json', import.meta.url), 'utf8'),
      readFile(
        new URL('../release-evidence/v2/templates/sanitized-input.template.json', import.meta.url),
        'utf8',
      ),
      readFile(
        new URL('../release-evidence/v2/examples/blocked-dry-run.json', import.meta.url),
        'utf8',
      ),
    ])

    expect(JSON.parse(inputSchema)).toEqual(generateReleaseReviewInputJsonSchema())
    expect(JSON.parse(bundleSchema)).toEqual(generateReleaseReviewBundleJsonSchema())
    expect(releaseReviewInputSchema.parse(JSON.parse(template))).toBeDefined()
    expect(releaseReviewBundleSchema.parse(JSON.parse(example)).readinessGate.status).toBe(
      'blocked',
    )
  })
})
