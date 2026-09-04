import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generateReleaseEvidenceJsonSchema } from './release-evidence-schema.js'

const defaultPath = 'release-evidence/v1/schema.json'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function renderedSchema(): string {
  return `${JSON.stringify(generateReleaseEvidenceJsonSchema(), null, 2)}\n`
}

async function main(input: readonly string[]): Promise<number> {
  const check = input[0] === '--check'
  const remaining = check ? input.slice(1) : input
  if (remaining.length > 1 || remaining[0]?.startsWith('--') === true) {
    process.stderr.write('usage: write-release-evidence-schema [--check] [schema-path]\n')
    return 2
  }

  const path = resolve(repositoryRoot, remaining[0] ?? defaultPath)
  const expected = renderedSchema()
  if (check) {
    let current: string
    try {
      current = await readFile(path, 'utf8')
    } catch {
      process.stderr.write('Release evidence JSON Schema is missing.\n')
      return 1
    }
    if (current !== expected) {
      process.stderr.write('Release evidence JSON Schema is out of date.\n')
      return 1
    }
    return 0
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, expected)
  return 0
}

process.exitCode = await main(process.argv.slice(2))
