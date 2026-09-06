import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalJson, generateReleaseEvidenceJsonSchema } from './release-evidence-schema.js'

const defaultPath = 'release-evidence/v1/schema.json'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function renderedReleaseEvidenceSchema(): string {
  return `${JSON.stringify(generateReleaseEvidenceJsonSchema(), null, 2)}\n`
}

export function releaseEvidenceSchemaMatches(current: string): boolean {
  try {
    return (
      canonicalJson(JSON.parse(current) as unknown) ===
      canonicalJson(generateReleaseEvidenceJsonSchema())
    )
  } catch {
    return false
  }
}

export async function runWriteReleaseEvidenceSchemaCommand(
  input: readonly string[],
  baseDirectory = repositoryRoot,
): Promise<number> {
  const check = input[0] === '--check'
  const remaining = check ? input.slice(1) : input
  if (remaining.length > 1 || remaining[0]?.startsWith('--') === true) {
    process.stderr.write('usage: write-release-evidence-schema [--check] [schema-path]\n')
    return 2
  }

  const path = resolve(baseDirectory, remaining[0] ?? defaultPath)
  const expected = renderedReleaseEvidenceSchema()
  if (check) {
    let current: string
    try {
      current = await readFile(path, 'utf8')
    } catch {
      process.stderr.write('Release evidence JSON Schema is missing.\n')
      return 1
    }
    if (!releaseEvidenceSchemaMatches(current)) {
      process.stderr.write('Release evidence JSON Schema is out of date.\n')
      return 1
    }
    return 0
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, expected)
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWriteReleaseEvidenceSchemaCommand(process.argv.slice(2))
}
