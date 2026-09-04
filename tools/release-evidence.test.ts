import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ReleaseEvidenceManifestSchema,
  assertSanitizedEvidence,
  generateReleaseEvidence,
  loadSanitizedLiveResultFile,
  projectAllowListedConfiguration,
  sha256Json,
} from './release-evidence.js'

const generatedAt = '2026-09-04T00:00:00.000Z'
const repository = {
  commitSha: '7c8a1367f8b28afa019452acd723899fc5116d12',
  branch: 'copilot/implement-versioned-release-evidence-tooling',
  dirty: false,
  dirtyFiles: [],
}

describe('release evidence manifest tooling', () => {
  it('validates a repository-only manifest with explicit unknown semantics', () => {
    const manifest = generateReleaseEvidence({ repository, generatedAt })

    expect(ReleaseEvidenceManifestSchema.parse(manifest).schemaVersion).toBe('release-evidence.v1')
    expect(manifest.checks.unit).toMatchObject({
      status: 'unknown',
      classification: 'unknown',
      summary: 'No sanitized result file was supplied; this is not a pass.',
    })
    expect(manifest.evidenceFreshness).toMatchObject({
      status: 'not-supplied',
      oldestAcceptedEvidenceAt: null,
      maxAgeHours: null,
    })
  })

  it('hashes allow-listed configuration deterministically', () => {
    const left = projectAllowListedConfiguration({ b: 2, a: { z: true, y: null } }, ['b', 'a'])
    const right = projectAllowListedConfiguration({ a: { y: null, z: true }, b: 2 }, ['a', 'b'])

    expect(left.hash).toBe(right.hash)
    expect(left.hash).toBe(sha256Json({ a: { y: null, z: true }, b: 2 }))
  })

  it('rejects unsafe configuration keys and secret-shaped values', () => {
    expect(() => projectAllowListedConfiguration({ token: 'redacted' }, ['token'])).toThrow(/not safe/iu)
    expect(() => assertSanitizedEvidence({ safe: 'AccountKey=abc123' })).toThrow(/Sensitive value/iu)
  })

  it('preserves dirty worktree evidence instead of normalizing it away', () => {
    const manifest = generateReleaseEvidence({
      repository: { ...repository, dirty: true, dirtyFiles: ['tools/release-evidence.ts'] },
      generatedAt,
    })

    expect(manifest.repository.dirty).toBe(true)
    expect(manifest.repository.dirtyFiles).toEqual(['tools/release-evidence.ts'])
  })

  it('does not convert missing evidence into a passing check', () => {
    const manifest = generateReleaseEvidence({ repository, generatedAt })

    expect(Object.values(manifest.checks).every((check) => check.status !== 'pass')).toBe(true)
  })

  it('rejects missing sanitized live result files', async () => {
    await expect(loadSanitizedLiveResultFile('/tmp/agent-sentinel-missing-live-result.json')).rejects.toThrow()
  })

  it('rejects sanitized live result files containing forbidden fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-evidence-'))
    const path = join(directory, 'live.json')
    await writeFile(path, JSON.stringify({ liveValidations: [], accessToken: 'redacted' }), 'utf8')

    await expect(loadSanitizedLiveResultFile(path)).rejects.toThrow(/Sensitive or unrestricted field/iu)
    await rm(directory, { recursive: true, force: true })
  })

  it('rejects contradictory classifications for the same subject', () => {
    expect(() =>
      generateReleaseEvidence({
        repository,
        generatedAt,
        liveResultFiles: [
          {
            claimClassifications: [
              { subject: 'auth deployment', classification: 'live', summary: 'JWT validated.' },
              { subject: 'auth deployment', classification: 'blocked', summary: 'Auth disabled.' },
            ],
          },
        ],
      }),
    ).toThrow(/Contradictory classifications/iu)
  })

  it('rejects a pass result with an unknown classification', () => {
    expect(() =>
      generateReleaseEvidence({
        repository,
        generatedAt,
        liveResultFiles: [
          {
            checks: {
              unit: {
                status: 'pass',
                classification: 'unknown',
                command: 'pnpm test',
                summary: 'Invalid pass.',
              },
            },
          },
        ],
      }),
    ).toThrow(/Passing check results/iu)
  })
})
