import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  generateReleaseReviewBundleJsonSchema,
  generateReleaseReviewInputJsonSchema,
} from './release-review-schema.js'
import {
  generateBlockedReleaseReviewExample,
  releaseReviewSchemaMatches,
  runWriteReleaseReviewSchemasCommand,
} from './write-release-review-schemas.js'

const scratchDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('release review JSON Schema writer', () => {
  it('writes both versioned schemas and the blocked example, then verifies them canonically', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.release-review-schema-test-'))
    scratchDirectories.push(directory)

    await expect(runWriteReleaseReviewSchemasCommand([], directory)).resolves.toBe(0)
    await expect(runWriteReleaseReviewSchemasCommand(['--check'], directory)).resolves.toBe(0)
    expect(
      JSON.parse(await readFile(join(directory, 'release-evidence/v2/input.schema.json'), 'utf8')),
    ).toEqual(generateReleaseReviewInputJsonSchema())
    expect(
      JSON.parse(await readFile(join(directory, 'release-evidence/v2/bundle.schema.json'), 'utf8')),
    ).toEqual(generateReleaseReviewBundleJsonSchema())
    expect(
      JSON.parse(
        await readFile(
          join(directory, 'release-evidence/v2/examples/blocked-dry-run.json'),
          'utf8',
        ),
      ),
    ).toEqual(generateBlockedReleaseReviewExample())
  })

  it('accepts ordering and EOL differences but rejects semantic drift', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.release-review-schema-test-'))
    scratchDirectories.push(directory)
    await runWriteReleaseReviewSchemasCommand([], directory)
    const path = join(directory, 'release-evidence/v2/input.schema.json')
    const schema = generateReleaseReviewInputJsonSchema()
    const reordered = Object.fromEntries(Object.entries(schema).reverse())
    const windowsEol = `${JSON.stringify(reordered, null, 2)}\n`.replaceAll('\n', '\r\n')
    await writeFile(path, windowsEol)

    expect(releaseReviewSchemaMatches(windowsEol, schema)).toBe(true)
    await expect(runWriteReleaseReviewSchemasCommand(['--check'], directory)).resolves.toBe(0)

    await writeFile(path, JSON.stringify({ ...schema, title: 'drifted' }))
    await expect(runWriteReleaseReviewSchemasCommand(['--check'], directory)).resolves.toBe(1)
  })

  it('rejects duplicate keys and unsupported arguments', async () => {
    expect(releaseReviewSchemaMatches('{"title":"one","title":"two"}', {})).toBe(false)
    await expect(runWriteReleaseReviewSchemasCommand(['--unknown'])).resolves.toBe(2)
  })
})
