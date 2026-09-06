import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  generateReleaseEvidence,
  parseGenerateArgs,
  readRepositoryState,
  runValidateCommand,
  validateReleaseEvidenceFile,
  type ExecFileImplementation,
} from './release-evidence-cli.js'
import { releaseEvidenceManifestSchema } from './release-evidence-schema.js'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-sentinel-release-evidence-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('release evidence CLI', () => {
  it('parses a repository-only generation command', () => {
    expect(
      parseGenerateArgs([
        '--output',
        'release-evidence/generated/local.json',
        '--timestamp',
        '2026-09-04T00:00:00.000Z',
      ]),
    ).toEqual({
      outputPath: 'release-evidence/generated/local.json',
      generatedAt: '2026-09-04T00:00:00.000Z',
    })
  })

  it('rejects duplicate and unknown command options', () => {
    expect(() => parseGenerateArgs(['--output', 'one.json', '--output', 'two.json'])).toThrow(
      '--output may be provided only once',
    )
    expect(() =>
      parseGenerateArgs(['--output', 'one.json', '--environment-dump', 'env.txt']),
    ).toThrow('Unknown option --environment-dump')
  })

  it('reads commit and dirty state using argument-safe git commands', async () => {
    const run = vi.fn<ExecFileImplementation>()
    run
      .mockResolvedValueOnce({ stdout: `${'a'.repeat(40)}\n`, stderr: '' })
      .mockResolvedValueOnce({ stdout: ' M docs/current-status.md\n', stderr: '' })

    await expect(readRepositoryState(run)).resolves.toEqual({
      commitSha: 'a'.repeat(40),
      dirty: true,
    })
    expect(run).toHaveBeenNthCalledWith(1, 'git', ['rev-parse', 'HEAD'])
    expect(run).toHaveBeenNthCalledWith(2, 'git', [
      'status',
      '--porcelain',
      '--untracked-files=normal',
    ])
  })

  it('fails when an explicitly supplied input file is missing without writing output', async () => {
    const directory = await temporaryDirectory()
    const missingInput = join(directory, 'private-live-results.json')
    const output = join(directory, 'manifest.json')

    await expect(
      generateReleaseEvidence(
        {
          inputPath: missingInput,
          outputPath: output,
          generatedAt: '2026-09-04T00:00:00.000Z',
        },
        {
          readRepositoryState: () => Promise.resolve({ commitSha: 'a'.repeat(40), dirty: false }),
        },
      ),
    ).rejects.toThrow(`Could not read input file ${basename(missingInput)}.`)

    await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('generates and validates repository-only evidence', async () => {
    const directory = await temporaryDirectory()
    const output = join(directory, 'manifest.json')

    await generateReleaseEvidence(
      {
        outputPath: output,
        generatedAt: '2026-09-04T00:00:00.000Z',
      },
      {
        readRepositoryState: () => Promise.resolve({ commitSha: 'b'.repeat(40), dirty: false }),
      },
    )

    const raw = JSON.parse(await readFile(output, 'utf8')) as unknown
    const manifest = releaseEvidenceManifestSchema.parse(raw)
    expect(manifest.release.commitSha).toBe('b'.repeat(40))
    expect(manifest.release.freshnessWindowHours).toBe(24)
    expect(manifest.images.expected.web.tag).toBe('b'.repeat(40))
    expect(manifest.checks.lint.outcome).toBe('not-run')
    expect(manifest.images.deployed.web.tag).toBeNull()
    expect(await readFile(output, 'utf8')).toMatch(/\n$/)
    await expect(validateReleaseEvidenceFile(output)).resolves.toBeUndefined()
  })

  it('resolves root-script paths from the invoking directory and accepts pnpm separators', async () => {
    const directory = await temporaryDirectory()

    await generateReleaseEvidence(
      {
        outputPath: 'generated/manifest.json',
        generatedAt: '2026-09-04T00:00:00.000Z',
      },
      {
        baseDirectory: directory,
        readRepositoryState: () => Promise.resolve({ commitSha: 'd'.repeat(40), dirty: false }),
      },
    )

    await expect(stat(join(directory, 'generated/manifest.json'))).resolves.toBeDefined()
    await expect(runValidateCommand(['--', 'generated/manifest.json'], directory)).resolves.toBe(0)
  })

  it('validates an explicitly supplied sanitized input file', async () => {
    const directory = await temporaryDirectory()
    const input = join(directory, 'sanitized.json')
    const output = join(directory, 'manifest.json')
    await writeFile(
      input,
      `${JSON.stringify({
        safeConfiguration: {
          AUTH_MODE: 'disabled',
          AGENT_SENTINEL_WRITE_ENABLED: false,
        },
      })}\n`,
    )

    await generateReleaseEvidence(
      {
        inputPath: input,
        outputPath: output,
        generatedAt: '2026-09-04T00:00:00.000Z',
      },
      {
        readRepositoryState: () => Promise.resolve({ commitSha: 'c'.repeat(40), dirty: true }),
      },
    )

    const manifest = releaseEvidenceManifestSchema.parse(
      JSON.parse(await readFile(output, 'utf8')) as unknown,
    )
    expect(manifest.release.dirty).toBe(true)
    expect(manifest.configuration.classification).toBe('tested')
    expect(manifest.configuration.keys).toEqual(['AGENT_SENTINEL_WRITE_ENABLED', 'AUTH_MODE'])
  })

  it('rejects secret-shaped content when validating an existing manifest', async () => {
    const directory = await temporaryDirectory()
    const output = join(directory, 'manifest.json')
    const manifest = releaseEvidenceManifestSchema.parse({
      schemaVersion: '1.0.0',
      release: {
        commitSha: 'e'.repeat(40),
        dirty: false,
        generatedAt: '2026-09-04T00:00:00.000Z',
        freshnessWindowHours: 24,
      },
      images: {
        expected: {
          classification: 'tested',
          web: { tag: 'e'.repeat(40), digest: null },
          api: { tag: 'e'.repeat(40), digest: null },
          jobs: { tag: 'e'.repeat(40), digest: null },
        },
        deployed: {
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
      configuration: {
        classification: 'planned',
        algorithm: 'sha256',
        hash: null,
        keys: [],
      },
      checks: Object.fromEntries(
        ['lint', 'typecheck', 'test', 'build', 'e2e', 'bicep'].map((name) => [
          name,
          {
            classification: 'planned',
            outcome: 'not-run',
            command: null,
            completedAt: null,
            summary: 'No sanitized result was supplied.',
          },
        ]),
      ),
      liveValidations: [],
      connectors: [],
      oneRai: {
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
        summary: ['Bear', 'er ', 'private-validation-material'].join(''),
      },
    })
    await writeFile(output, `${JSON.stringify(manifest)}\n`)

    await expect(validateReleaseEvidenceFile(output)).rejects.toThrow(
      /secret-shaped value at oneRai.summary/,
    )
  })

  it.each(['input', 'release evidence'] as const)(
    'rejects nested duplicate keys in a %s file before sensitive-content scanning',
    async (fileKind) => {
      const directory = await temporaryDirectory()
      const input = join(directory, 'duplicated.json')
      const output = join(directory, 'manifest.json')
      const secretShapedValue = ['Bear', 'er ', 'A'.repeat(32)].join('')
      await writeFile(input, `{"outer":{"summary":"${secretShapedValue}","\\u0073ummary":"safe"}}`)

      const operation =
        fileKind === 'input'
          ? generateReleaseEvidence(
              {
                inputPath: input,
                outputPath: output,
                generatedAt: '2026-09-04T00:00:00.000Z',
              },
              {
                readRepositoryState: () =>
                  Promise.resolve({ commitSha: 'f'.repeat(40), dirty: false }),
              },
            )
          : validateReleaseEvidenceFile(input)

      let error: Error | undefined
      try {
        await operation
      } catch (caught: unknown) {
        if (caught instanceof Error) error = caught
      }
      expect(error?.message).toBe(
        `${fileKind} file ${basename(input)} contains duplicate JSON object keys.`,
      )
      expect(error?.message).not.toContain('secret-shaped value')
    },
  )
})
