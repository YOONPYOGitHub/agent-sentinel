import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { missingAccessibilityEvidence } from './accessibility-evidence.js'
import { canonicalJson } from './release-evidence-schema.js'
import {
  buildReleaseReviewBundle,
  generateReleaseReviewBundleJsonSchema,
  generateReleaseReviewInputJsonSchema,
} from './release-review-schema.js'
import { parseJsonRejectingDuplicateKeys } from './strict-json.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function generateBlockedReleaseReviewExample() {
  return buildReleaseReviewBundle(
    { commitSha: 'a'.repeat(40), dirty: false },
    {},
    missingAccessibilityEvidence(),
    '2026-09-14T01:00:00.000Z',
  )
}
const definitions = [
  ['release-evidence/v2/input.schema.json', generateReleaseReviewInputJsonSchema],
  ['release-evidence/v2/bundle.schema.json', generateReleaseReviewBundleJsonSchema],
  ['release-evidence/v2/examples/blocked-dry-run.json', generateBlockedReleaseReviewExample],
] as const
export function releaseReviewSchemaMatches(current: string, expected: unknown): boolean {
  try {
    return canonicalJson(parseJsonRejectingDuplicateKeys(current)) === canonicalJson(expected)
  } catch {
    return false
  }
}
export async function runWriteReleaseReviewSchemasCommand(
  args: readonly string[],
  baseDirectory = repositoryRoot,
): Promise<number> {
  const filtered = args.filter((value) => value !== '--')
  if (
    filtered.some((value) => value !== '--check') ||
    filtered.filter((value) => value === '--check').length > 1
  ) {
    process.stderr.write('usage: release-review:schema [--check]\n')
    return 2
  }
  const check = filtered.includes('--check')
  for (const [relativePath, generate] of definitions) {
    const path = resolve(baseDirectory, relativePath)
    const schema = generate()
    if (check) {
      let current: string
      try {
        current = await readFile(path, 'utf8')
      } catch {
        process.stderr.write(`Release review schema ${relativePath} is missing.\n`)
        return 1
      }
      if (!releaseReviewSchemaMatches(current, schema)) {
        process.stderr.write(`Release review schema ${relativePath} is out of date.\n`)
        return 1
      }
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`)
    }
  }
  return 0
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWriteReleaseReviewSchemasCommand(process.argv.slice(2))
}
