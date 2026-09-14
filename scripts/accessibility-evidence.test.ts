import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  missingAccessibilityEvidence,
  normalizeAccessibilityArtifact,
  readAccessibilityArtifact,
} from './accessibility-evidence.js'

const scratchDirectories: string[] = []

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), '.accessibility-evidence-test-'))
  scratchDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('accessibility evidence normalizer', () => {
  it('keeps missing evidence explicitly blocked', () => {
    expect(missingAccessibilityEvidence()).toEqual({
      outcome: 'blocked',
      artifactSupplied: false,
      tool: null,
      observedAt: null,
      evidenceRefs: [],
      surfaces: [],
      summary:
        'No real Playwright or axe-style accessibility artifact was supplied; Accessibility remains blocked.',
    })
  })

  it('normalizes the committed passing axe fixture without retaining URLs', async () => {
    const evidence = await readAccessibilityArtifact(
      new URL('../release-evidence/v2/fixtures/accessibility-axe-pass.json', import.meta.url)
        .pathname,
      'accessibility-run',
    )

    expect(evidence).toMatchObject({
      outcome: 'pass',
      artifactSupplied: true,
      tool: 'axe-core',
      evidenceRefs: ['accessibility-run'],
    })
    expect(evidence.surfaces.map((surface) => surface.surfaceId)).toEqual([
      'agent-detail',
      'estate-overview',
    ])
    expect(JSON.stringify(evidence)).not.toContain('fixture.invalid')
  })

  it('normalizes unresolved rules, WCAG tags, node counts, and tool identity', async () => {
    const evidence = await readAccessibilityArtifact(
      new URL('../release-evidence/v2/fixtures/accessibility-axe-fail.json', import.meta.url)
        .pathname,
      'accessibility-run',
    )

    expect(evidence.outcome).toBe('fail')
    expect(evidence.tool).toBe('playwright-axe')
    expect(evidence.surfaces[0]).toMatchObject({
      outcome: 'fail',
      counts: { critical: 0, serious: 1, moderate: 0, minor: 0, unknown: 0 },
      unresolved: [
        {
          ruleId: 'button-name',
          impact: 'serious',
          wcagCriteria: ['wcag2a', 'wcag412'],
          affectedNodes: 2,
        },
      ],
    })
  })

  it('blocks a supplied artifact with no supported surfaces or timestamp', () => {
    const evidence = normalizeAccessibilityArtifact({ results: [] }, 'accessibility-run')

    expect(evidence.outcome).toBe('blocked')
    expect(evidence.artifactSupplied).toBe(true)
    expect(evidence.observedAt).toBeNull()
    expect(evidence.surfaces).toEqual([])
  })

  it('never treats an unsupported object as a passing surface, even with a timestamp override', () => {
    expect(() =>
      normalizeAccessibilityArtifact({}, 'accessibility-run', '2026-09-14T00:00:00.000Z'),
    ).toThrow()
  })

  it('rejects raw DOM details and accepts an explicit sanitized node count', () => {
    const artifact = {
      observedAt: '2026-09-14T00:00:00.000Z',
      results: [
        {
          surfaceId: 'estate',
          violations: [
            {
              id: 'button-name',
              impact: 'serious',
              tags: ['wcag412'],
              affectedNodes: 2,
            },
          ],
        },
      ],
    }
    expect(normalizeAccessibilityArtifact(artifact, 'accessibility-run').surfaces[0]).toMatchObject(
      {
        counts: { critical: 0, serious: 1, moderate: 0, minor: 0, unknown: 0 },
        unresolved: [{ ruleId: 'button-name', affectedNodes: 2 }],
      },
    )

    const rawDom = {
      ...artifact,
      results: [
        {
          ...artifact.results[0],
          violations: [
            {
              id: 'button-name',
              impact: 'serious',
              tags: ['wcag412'],
              nodes: [{ html: '<button>private</button>' }],
            },
          ],
        },
      ],
    }
    expect(() => normalizeAccessibilityArtifact(rawDom, 'accessibility-run')).toThrow(
      'sanitized empty placeholders',
    )
  })

  it('normalizes surface and violation ordering deterministically', () => {
    const surfaces = [
      {
        surfaceId: 'zeta',
        violations: [
          { id: 'z-rule', impact: 'minor', tags: [], affectedNodes: 1 },
          { id: 'a-rule', impact: 'serious', tags: [], affectedNodes: 1 },
        ],
      },
      { surfaceId: 'alpha', violations: [] },
    ]
    const first = normalizeAccessibilityArtifact(
      { observedAt: '2026-09-14T00:00:00.000Z', results: surfaces },
      'accessibility-run',
    )
    const second = normalizeAccessibilityArtifact(
      { observedAt: '2026-09-14T00:00:00.000Z', results: [...surfaces].reverse() },
      'accessibility-run',
    )

    expect(first).toEqual(second)
    expect(first.surfaces.map((surface) => surface.surfaceId)).toEqual(['alpha', 'zeta'])
    expect(first.surfaces[1]?.unresolved.map((issue) => issue.ruleId)).toEqual(['a-rule', 'z-rule'])
  })

  it('rejects conflicting timestamps and duplicate rule ids on one surface', () => {
    expect(() =>
      normalizeAccessibilityArtifact(
        {
          results: [
            {
              surfaceId: 'alpha',
              observedAt: '2026-09-14T00:00:00.000Z',
              violations: [],
            },
            {
              surfaceId: 'beta',
              observedAt: '2026-09-14T00:01:00.000Z',
              violations: [],
            },
          ],
        },
        'accessibility-run',
      ),
    ).toThrow('conflicting observation timestamps')

    expect(() =>
      normalizeAccessibilityArtifact(
        {
          observedAt: '2026-09-14T00:00:00.000Z',
          results: [
            {
              surfaceId: 'alpha',
              violations: [
                { id: 'button-name', impact: 'serious', tags: [], affectedNodes: 1 },
                { id: 'button-name', impact: 'serious', tags: [], affectedNodes: 2 },
              ],
            },
          ],
        },
        'accessibility-run',
      ),
    ).toThrow('accessibility rule ids must be unique')
  })

  it('rejects malformed or rewritten observation timestamps', () => {
    expect(() =>
      normalizeAccessibilityArtifact(
        {
          observedAt: 123,
          results: [{ surfaceId: 'alpha', violations: [] }],
        },
        'accessibility-run',
      ),
    ).toThrow('timestamps must be strings')

    expect(() =>
      normalizeAccessibilityArtifact(
        {
          observedAt: '2026-09-14T00:00:00.000Z',
          results: [{ surfaceId: 'alpha', violations: [] }],
        },
        'accessibility-run',
        '2026-09-14T00:01:00.000Z',
      ),
    ).toThrow('override conflicts')
  })

  it('normalizes punctuation-only identifiers to schema-safe fallbacks', () => {
    const evidence = normalizeAccessibilityArtifact(
      {
        observedAt: '2026-09-14T00:00:00.000Z',
        results: [{ surfaceId: '...', violations: [] }],
      },
      'accessibility-run',
    )

    expect(evidence.surfaces[0]?.surfaceId).toBe('surface')
  })

  it('creates deterministic unique IDs for duplicate and URL-only surfaces', () => {
    const evidence = normalizeAccessibilityArtifact(
      {
        observedAt: '2026-09-14T00:00:00.000Z',
        results: [
          { url: 'https://first.invalid/agents/replacement', violations: [] },
          { url: 'https://second.invalid/agents/replacement', violations: [] },
        ],
      },
      'accessibility-run',
    )

    expect(evidence.surfaces.map((surface) => surface.surfaceId)).toEqual([
      'agents-replacement',
      'agents-replacement-2',
    ])
    expect(JSON.stringify(evidence)).not.toContain('first.invalid')
    expect(JSON.stringify(evidence)).not.toContain('second.invalid')
  })

  it.each([
    ['duplicate keys', '{"observedAt":"2026-09-14T00:00:00.000Z","\\u006fbservedAt":"safe"}'],
    ['email address', '{"observedAt":"2026-09-14T00:00:00.000Z","title":"person@example.com"}'],
    ['tenant field', '{"observedAt":"2026-09-14T00:00:00.000Z","tenantId":"replacement"}'],
    ['raw payload field', '{"observedAt":"2026-09-14T00:00:00.000Z","rawPayload":"private"}'],
  ])('rejects unsafe %s before normalization', async (_, content) => {
    const directory = await scratchDirectory()
    const path = join(directory, 'artifact.json')
    await writeFile(path, content)

    await expect(readAccessibilityArtifact(path, 'accessibility-run')).rejects.toThrow()
  })
})
