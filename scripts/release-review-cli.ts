import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  missingAccessibilityEvidence,
  readAccessibilityArtifact,
} from './accessibility-evidence.js'
import { readRepositoryState } from './release-evidence-cli.js'
import {
  buildReleaseReviewBundle,
  assertReleaseReviewContainsNoSensitiveContent,
  releaseReviewBundleSchema,
  type ReleaseReviewBundle,
} from './release-review-schema.js'
import type { RepositoryState } from './release-evidence-schema.js'
import { isDuplicateJsonKeyError, parseJsonRejectingDuplicateKeys } from './strict-json.js'

export const RELEASE_REVIEW_DEFAULT_TIMESTAMP_ENV = 'SOURCE_DATE_EPOCH' as const

export interface ReleaseReviewArgs {
  dryRun: true
  sha: string
  inputPath: string
  outputDirectory: string
  accessibilityPath?: string
  accessibilityRef: string
  accessibilityObservedAt?: string
  generatedAt?: string
}
interface ReleaseReviewDependencies {
  baseDirectory?: string
  readRepositoryState?: () => Promise<RepositoryState>
}
class UsageError extends Error {
  override readonly name = 'UsageError'
}
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function releaseReviewGeneratedAt(
  explicitTimestamp: string | undefined,
  sourceDateEpoch = process.env[RELEASE_REVIEW_DEFAULT_TIMESTAMP_ENV],
): string {
  if (explicitTimestamp !== undefined) return explicitTimestamp
  if (sourceDateEpoch === undefined || !/^(0|[1-9][0-9]{0,12})$/.test(sourceDateEpoch)) {
    throw new Error(
      '--timestamp or a valid SOURCE_DATE_EPOCH is required for deterministic generation.',
    )
  }
  const milliseconds = Number(sourceDateEpoch) * 1000
  const timestamp = new Date(milliseconds)
  if (!Number.isSafeInteger(milliseconds) || Number.isNaN(timestamp.valueOf())) {
    throw new Error('SOURCE_DATE_EPOCH is outside the supported deterministic timestamp range.')
  }
  return timestamp.toISOString()
}
function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--'))
    throw new UsageError(`${option} requires a non-empty value.`)
  return value
}
export function parseReleaseReviewArgs(args: readonly string[]): ReleaseReviewArgs {
  const values = new Map<string, string>()
  let dryRun = false
  const allowed = new Set([
    '--dry-run',
    '--sha',
    '--input',
    '--output',
    '--accessibility',
    '--accessibility-ref',
    '--accessibility-observed-at',
    '--timestamp',
  ])
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === '--') continue
    if (option === undefined || !allowed.has(option))
      throw new UsageError(`Unknown option ${option}.`)
    if (option === '--dry-run') {
      if (dryRun) throw new UsageError('--dry-run may be provided only once.')
      dryRun = true
      continue
    }
    if (values.has(option)) throw new UsageError(`${option} may be provided only once.`)
    values.set(option, requiredValue(args, index, option))
    index += 1
  }
  if (!dryRun)
    throw new UsageError('--dry-run is required; this workflow never submits or deploys.')
  for (const option of ['--sha', '--input', '--output'])
    if (!values.has(option)) throw new UsageError(`${option} is required.`)
  const sha = values.get('--sha') as string
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new UsageError('--sha must be an exact lowercase 40-character commit SHA.')
  if (values.has('--accessibility-observed-at') && !values.has('--accessibility'))
    throw new UsageError('--accessibility-observed-at requires --accessibility.')
  return {
    dryRun: true,
    sha,
    inputPath: values.get('--input') as string,
    outputDirectory: values.get('--output') as string,
    accessibilityRef: values.get('--accessibility-ref') ?? 'accessibility-artifact',
    ...(values.has('--accessibility')
      ? { accessibilityPath: values.get('--accessibility') as string }
      : {}),
    ...(values.has('--accessibility-observed-at')
      ? { accessibilityObservedAt: values.get('--accessibility-observed-at') as string }
      : {}),
    ...(values.has('--timestamp') ? { generatedAt: values.get('--timestamp') as string } : {}),
  }
}
async function readStrictJson(path: string, label: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`Could not read ${label} file ${basename(path)}.`)
  }
  try {
    return parseJsonRejectingDuplicateKeys(text)
  } catch (error: unknown) {
    if (isDuplicateJsonKeyError(error))
      throw new Error(`${label} file ${basename(path)} contains duplicate JSON object keys.`)
    throw new Error(`${label} file ${basename(path)} is not valid JSON.`)
  }
}
function cell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(/([`*_[\]<>|])/g, '\\$1')
    .replaceAll(/\s+/g, ' ')
    .trim()
}
export function renderReleaseReviewMarkdown(bundle: ReleaseReviewBundle): string {
  const gateRows = Object.entries(bundle.gateChecks)
    .map(
      ([name, gate]) =>
        `| ${name} | ${gate.status} | ${gate.reasons.length === 0 ? 'complete' : cell(gate.reasons.join(' '))} |`,
    )
    .join('\n')
  const decisions = Object.entries(bundle.humanDecisions)
    .map(([name, decision]) => `| ${name} | ${decision.status} | ${cell(decision.summary)} |`)
    .join('\n')
  const blockers =
    bundle.readinessGate.reasons.length === 0
      ? '- None.'
      : bundle.readinessGate.reasons.map((reason) => `- ${cell(reason)}`).join('\n')
  return `# Release review evidence\n\n- Exact SHA: \`${bundle.release.commitSha}\`\n- Schema: \`${bundle.schemaVersion}\`\n- Workflow: \`${bundle.workflow.mode}\`\n- Readiness: **${bundle.readinessGate.status.toUpperCase()}**\n- Canonical SHA-256: \`${bundle.canonicalHash.value}\`\n- Generated: ${bundle.release.generatedAt}\n\n## Gate summary\n\n| Gate | Status | Evidence gap |\n| --- | --- | --- |\n${gateRows}\n\n## Required human decisions\n\n| Review | Status | Summary |\n| --- | --- | --- |\n${decisions}\n\n## Blocking reasons\n\n${blockers}\n\nThis sanitized dry-run bundle does not submit, approve, deploy, contact reviewers, access providers, or retain raw payloads.\n`
}
async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.pending`
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, path)
  } catch (error: unknown) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}
export async function generateReleaseReviewBundle(
  args: ReleaseReviewArgs,
  dependencies: ReleaseReviewDependencies = {},
): Promise<{ jsonPath: string; markdownPath: string; bundle: ReleaseReviewBundle }> {
  const baseDirectory = dependencies.baseDirectory ?? repositoryRoot
  const repository = await (dependencies.readRepositoryState ?? readRepositoryState)()
  if (repository.commitSha !== args.sha)
    throw new Error(
      `Requested SHA ${args.sha} does not match checked-out HEAD ${repository.commitSha}.`,
    )
  const input = await readStrictJson(resolve(baseDirectory, args.inputPath), 'sanitized input')
  assertReleaseReviewContainsNoSensitiveContent(input)
  const accessibility =
    args.accessibilityPath === undefined
      ? missingAccessibilityEvidence()
      : await readAccessibilityArtifact(
          resolve(baseDirectory, args.accessibilityPath),
          args.accessibilityRef,
          args.accessibilityObservedAt,
        )
  const bundle = buildReleaseReviewBundle(
    repository,
    input,
    accessibility,
    releaseReviewGeneratedAt(args.generatedAt),
  )
  const outputDirectory = resolve(baseDirectory, args.outputDirectory)
  const jsonPath = resolve(outputDirectory, `release-review-v2-${args.sha}.json`)
  const markdownPath = resolve(outputDirectory, `release-review-v2-${args.sha}.md`)
  await mkdir(outputDirectory, { recursive: true })
  await atomicWrite(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`)
  await atomicWrite(markdownPath, renderReleaseReviewMarkdown(bundle))
  return { jsonPath, markdownPath, bundle }
}
export async function validateReleaseReviewBundle(
  path: string,
  baseDirectory = repositoryRoot,
): Promise<ReleaseReviewBundle> {
  const raw = await readStrictJson(resolve(baseDirectory, path), 'release review bundle')
  assertReleaseReviewContainsNoSensitiveContent(raw)
  return releaseReviewBundleSchema.parse(raw)
}
export async function runGenerateReleaseReviewCommand(args: readonly string[]): Promise<number> {
  try {
    const parsed = parseReleaseReviewArgs(args)
    const result = await generateReleaseReviewBundle(parsed)
    process.stdout.write(
      [
        `dry-run bundle: ${relative(process.cwd(), result.jsonPath)}`,
        `dry-run summary: ${relative(process.cwd(), result.markdownPath)}`,
        `canonical sha256: ${result.bundle.canonicalHash.value}`,
        'external submission: not performed',
      ].join('\n') + '\n',
    )
    return 0
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Release review evidence generation failed.'}\n`,
    )
    return error instanceof UsageError ? 2 : 1
  }
}
export async function runValidateReleaseReviewCommand(
  args: readonly string[],
  baseDirectory?: string,
): Promise<number> {
  const filtered = args.filter((value) => value !== '--')
  if (
    filtered.length !== 3 ||
    filtered[0] !== '--sha' ||
    filtered[1] === undefined ||
    filtered[2] === undefined ||
    !/^[a-f0-9]{40}$/.test(filtered[1]) ||
    filtered[2].startsWith('--')
  ) {
    process.stderr.write('usage: release-review:validate --sha <full-sha> <bundle.json>\n')
    return 2
  }
  try {
    const bundle = await validateReleaseReviewBundle(filtered[2], baseDirectory)
    if (bundle.release.commitSha !== filtered[1])
      throw new Error('Release review bundle does not match the requested exact SHA.')
    return 0
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Release review validation failed.'}\n`,
    )
    return 1
  }
}
