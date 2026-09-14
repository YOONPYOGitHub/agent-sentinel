import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { missingAccessibilityEvidence } from './accessibility-evidence.js'
import {
  generateReleaseReviewBundle,
  parseReleaseReviewArgs,
  releaseReviewGeneratedAt,
  renderReleaseReviewMarkdown,
  runGenerateReleaseReviewCommand,
  runValidateReleaseReviewCommand,
  validateReleaseReviewBundle,
} from './release-review-cli.js'
import { buildReleaseReviewBundle } from './release-review-schema.js'

const sha = 'a'.repeat(40)
const timestamp = '2026-09-14T01:00:00.000Z'
const scratchDirectories: string[] = []

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), '.release-review-cli-test-'))
  scratchDirectories.push(directory)
  return directory
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('release review dry-run CLI', () => {
  it('requires a deterministic timestamp source', () => {
    expect(releaseReviewGeneratedAt(timestamp, undefined)).toBe(timestamp)
    expect(releaseReviewGeneratedAt(undefined, '1789347600')).toBe('2026-09-14T01:00:00.000Z')
    expect(() => releaseReviewGeneratedAt(undefined, undefined)).toThrow(
      '--timestamp or a valid SOURCE_DATE_EPOCH is required',
    )
    expect(() => releaseReviewGeneratedAt(undefined, 'not-a-number')).toThrow(
      '--timestamp or a valid SOURCE_DATE_EPOCH is required',
    )
  })

  it('requires an explicit dry-run, exact SHA, sanitized input, and output directory', () => {
    expect(
      parseReleaseReviewArgs([
        '--dry-run',
        '--sha',
        sha,
        '--input',
        'input.json',
        '--output',
        'generated',
      ]),
    ).toEqual({
      dryRun: true,
      sha,
      inputPath: 'input.json',
      outputDirectory: 'generated',
      accessibilityRef: 'accessibility-artifact',
    })

    expect(() =>
      parseReleaseReviewArgs(['--sha', sha, '--input', 'input.json', '--output', 'generated']),
    ).toThrow('--dry-run is required')
    expect(() =>
      parseReleaseReviewArgs([
        '--dry-run',
        '--sha',
        'short',
        '--input',
        'input.json',
        '--output',
        'generated',
      ]),
    ).toThrow('exact lowercase 40-character commit SHA')
    expect(() =>
      parseReleaseReviewArgs([
        '--dry-run',
        '--sha',
        sha,
        '--input',
        'input.json',
        '--output',
        'generated',
        '--accessibility-observed-at',
        timestamp,
      ]),
    ).toThrow('--accessibility-observed-at requires --accessibility')
  })

  it('generates only local sanitized JSON and Markdown for the checked-out SHA', async () => {
    const directory = await scratchDirectory()
    await writeFile(join(directory, 'input.json'), '{}\n')

    const result = await generateReleaseReviewBundle(
      {
        dryRun: true,
        sha,
        inputPath: 'input.json',
        outputDirectory: 'generated',
        accessibilityRef: 'accessibility-artifact',
        generatedAt: timestamp,
      },
      {
        baseDirectory: directory,
        readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
      },
    )

    expect(result.jsonPath).toBe(join(directory, 'generated', `release-review-v2-${sha}.json`))
    expect(result.markdownPath).toBe(join(directory, 'generated', `release-review-v2-${sha}.md`))
    expect(result.bundle.workflow).toEqual({
      mode: 'dry-run-no-submit',
      externalSubmission: false,
      deploymentPerformed: false,
    })
    expect((await stat(result.jsonPath)).mode & 0o777).toBe(0o600)
    expect((await stat(result.markdownPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(result.markdownPath, 'utf8')).toContain(
      'does not submit, approve, deploy, contact reviewers, access providers',
    )
    await expect(validateReleaseReviewBundle(result.jsonPath)).resolves.toEqual(result.bundle)
  })

  it('refuses a requested SHA that differs from checked-out HEAD before writing artifacts', async () => {
    const directory = await scratchDirectory()
    await writeFile(join(directory, 'input.json'), '{}\n')

    await expect(
      generateReleaseReviewBundle(
        {
          dryRun: true,
          sha,
          inputPath: 'input.json',
          outputDirectory: 'generated',
          accessibilityRef: 'accessibility-artifact',
        },
        {
          baseDirectory: directory,
          readRepositoryState: () => Promise.resolve({ commitSha: 'b'.repeat(40), dirty: false }),
        },
      ),
    ).rejects.toThrow('does not match checked-out HEAD')
    await expect(stat(join(directory, 'generated'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects duplicate input keys, undeclared accessibility references, and bad bundle hashes', async () => {
    const directory = await scratchDirectory()
    await writeFile(join(directory, 'duplicate.json'), '{"blockers":[],"\\u0062lockers":[]}')
    await expect(
      generateReleaseReviewBundle(
        {
          dryRun: true,
          sha,
          inputPath: 'duplicate.json',
          outputDirectory: 'generated',
          accessibilityRef: 'accessibility-artifact',
        },
        {
          baseDirectory: directory,
          readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
        },
      ),
    ).rejects.toThrow('duplicate JSON object keys')

    await writeFile(join(directory, 'input.json'), '{}\n')
    await writeFile(
      join(directory, 'accessibility.json'),
      JSON.stringify({ observedAt: timestamp, results: [{ surfaceId: 'estate', violations: [] }] }),
    )
    await expect(
      generateReleaseReviewBundle(
        {
          dryRun: true,
          sha,
          inputPath: 'input.json',
          outputDirectory: 'generated',
          accessibilityPath: 'accessibility.json',
          accessibilityRef: 'accessibility-artifact',
          generatedAt: timestamp,
        },
        {
          baseDirectory: directory,
          readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
        },
      ),
    ).rejects.toThrow('evidence reference accessibility-artifact is not declared')

    const result = await generateReleaseReviewBundle(
      {
        dryRun: true,
        sha,
        inputPath: 'input.json',
        outputDirectory: 'generated',
        accessibilityRef: 'accessibility-artifact',
        generatedAt: timestamp,
      },
      {
        baseDirectory: directory,
        readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
      },
    )
    const tampered = JSON.parse(await readFile(result.jsonPath, 'utf8')) as {
      release: { dirty: boolean }
    }
    tampered.release.dirty = true
    await writeFile(result.jsonPath, JSON.stringify(tampered))
    await expect(validateReleaseReviewBundle(result.jsonPath)).rejects.toThrow()
  })

  it('renders only sanitized identifiers and pending human gates', async () => {
    const directory = await scratchDirectory()
    await writeFile(join(directory, 'input.json'), '{}\n')
    const result = await generateReleaseReviewBundle(
      {
        dryRun: true,
        sha,
        inputPath: 'input.json',
        outputDirectory: 'generated',
        accessibilityRef: 'accessibility-artifact',
        generatedAt: timestamp,
      },
      {
        baseDirectory: directory,
        readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
      },
    )
    const markdown = renderReleaseReviewMarkdown(result.bundle)

    expect(markdown).toContain(`Exact SHA: \`${sha}\``)
    expect(markdown).toContain('| security | pending |')
    expect(markdown).not.toContain(directory)
  })

  it('renders supplied summaries as plain Markdown text', () => {
    const bundle = buildReleaseReviewBundle(
      { commitSha: sha, dirty: false },
      {
        humanDecisions: {
          security: {
            status: 'pending',
            decidedAt: null,
            decisionRef: null,
            summary: '<script>*review*</script> [link](https://fixture.invalid)',
          },
        },
      },
      missingAccessibilityEvidence(),
      timestamp,
    )

    const markdown = renderReleaseReviewMarkdown(bundle)
    expect(markdown).toContain('\\<script\\>\\*review\\*\\</script\\>')
    expect(markdown).toContain('\\[link\\](https://fixture.invalid)')
    expect(markdown).not.toContain('<script>')
  })

  it('validates against an explicitly requested exact SHA', async () => {
    const directory = await scratchDirectory()
    await writeFile(join(directory, 'input.json'), '{}\n')
    const result = await generateReleaseReviewBundle(
      {
        dryRun: true,
        sha,
        inputPath: 'input.json',
        outputDirectory: 'generated',
        accessibilityRef: 'accessibility-artifact',
        generatedAt: timestamp,
      },
      {
        baseDirectory: directory,
        readRepositoryState: () => Promise.resolve({ commitSha: sha, dirty: false }),
      },
    )

    await expect(
      runValidateReleaseReviewCommand(
        ['--sha', sha, join('generated', `release-review-v2-${sha}.json`)],
        directory,
      ),
    ).resolves.toBe(0)
    await expect(
      runValidateReleaseReviewCommand(
        ['--sha', 'b'.repeat(40), join('generated', `release-review-v2-${sha}.json`)],
        directory,
      ),
    ).resolves.toBe(1)
    await expect(runValidateReleaseReviewCommand([result.jsonPath], directory)).resolves.toBe(2)
  })

  it('fails CLI usage without touching Git or the network', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(runGenerateReleaseReviewCommand([])).resolves.toBe(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--dry-run is required'))
  })
})
