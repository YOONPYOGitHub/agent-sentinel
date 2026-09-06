import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { generateReleaseEvidenceJsonSchema } from './release-evidence-schema.js'
import {
  releaseEvidenceSchemaMatches,
  runWriteReleaseEvidenceSchemaCommand,
} from './write-release-evidence-schema.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('release evidence JSON Schema writer', () => {
  it('accepts canonical schema content across property order and EOL differences', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-sentinel-release-schema-'))
    temporaryDirectories.push(directory)
    const generated = generateReleaseEvidenceJsonSchema()
    const reordered = {
      ...Object.fromEntries(Object.entries(generated).reverse()),
    }
    const schemaPath = join(directory, 'schema.json')
    const windowsEol = `${JSON.stringify(reordered, null, 2)}\n`.replaceAll('\n', '\r\n')
    await writeFile(schemaPath, windowsEol)

    expect(releaseEvidenceSchemaMatches(windowsEol)).toBe(true)
    await expect(
      runWriteReleaseEvidenceSchemaCommand(['--check', 'schema.json'], directory),
    ).resolves.toBe(0)
  })

  it('still rejects semantic schema drift and invalid JSON', () => {
    const generated = generateReleaseEvidenceJsonSchema()

    expect(
      releaseEvidenceSchemaMatches(
        JSON.stringify({
          ...generated,
          title: 'Semantically different schema',
        }),
      ),
    ).toBe(false)
    expect(releaseEvidenceSchemaMatches('{not-json')).toBe(false)
  })
})
