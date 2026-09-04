import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { cwd } from 'node:process'
import { promisify } from 'node:util'

import {
  buildReleaseEvidence,
  releaseEvidenceManifestSchema,
  sanitizeReleaseEvidenceInput,
  type RepositoryState,
} from './release-evidence-schema.js'

export interface GenerateArgs {
  readonly inputPath?: string
  readonly outputPath: string
  readonly generatedAt?: string
}

export type ExecFileImplementation = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>

interface GenerateDependencies {
  readonly baseDirectory?: string
  readonly readRepositoryState?: () => Promise<RepositoryState>
}

class UsageError extends Error {
  override readonly name = 'UsageError'
}

const execFileAsync = promisify(execFile)

function requiredValue(input: readonly string[], index: number, option: string): string {
  const value = input[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new UsageError(`${option} requires a non-empty value.`)
  }
  return value
}

export function parseGenerateArgs(input: readonly string[]): GenerateArgs {
  let inputPath: string | undefined
  let outputPath: string | undefined
  let generatedAt: string | undefined
  const seen = new Set<string>()

  for (let index = 0; index < input.length; index += 1) {
    const option = input[index]
    if (option === undefined || option === '--') continue
    if (!['--input', '--output', '--timestamp'].includes(option)) {
      throw new UsageError(`Unknown option ${option}.`)
    }
    if (seen.has(option)) throw new UsageError(`${option} may be provided only once.`)
    seen.add(option)
    const value = requiredValue(input, index, option)
    if (option === '--input') inputPath = value
    else if (option === '--output') outputPath = value
    else generatedAt = value
    index += 1
  }

  if (outputPath === undefined) throw new UsageError('--output is required.')
  return {
    outputPath,
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
  }
}

async function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(file, [...args], {
    cwd: resolve(cwd()),
    encoding: 'utf8',
    windowsHide: true,
  })
  return { stdout: result.stdout, stderr: result.stderr }
}

export async function readRepositoryState(
  run: ExecFileImplementation = defaultExecFile,
): Promise<RepositoryState> {
  const revision = await run('git', ['rev-parse', 'HEAD'])
  const status = await run('git', ['status', '--porcelain', '--untracked-files=normal'])
  return {
    commitSha: revision.stdout.trim(),
    dirty: status.stdout.trim().length > 0,
  }
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`Could not read ${label} file ${basename(path)}.`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label} file ${basename(path)} is not valid JSON.`)
  }
}

export async function generateReleaseEvidence(
  args: GenerateArgs,
  dependencies: GenerateDependencies = {},
): Promise<void> {
  const baseDirectory = dependencies.baseDirectory ?? process.env['INIT_CWD'] ?? cwd()
  const repository = await (dependencies.readRepositoryState ?? readRepositoryState)()
  const rawInput =
    args.inputPath === undefined
      ? {}
      : await readJsonFile(resolve(baseDirectory, args.inputPath), 'input')
  const input = sanitizeReleaseEvidenceInput(rawInput)
  const manifest = buildReleaseEvidence(
    repository,
    input,
    args.generatedAt ?? new Date().toISOString(),
  )
  const outputPath = resolve(baseDirectory, args.outputPath)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function validateReleaseEvidenceFile(
  path: string,
  baseDirectory = process.env['INIT_CWD'] ?? cwd(),
): Promise<void> {
  const raw = await readJsonFile(resolve(baseDirectory, path), 'release evidence')
  releaseEvidenceManifestSchema.parse(raw)
}

export async function runGenerateCommand(input: readonly string[]): Promise<number> {
  try {
    await generateReleaseEvidence(parseGenerateArgs(input))
    return 0
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Generation failed.'}\n`)
    return error instanceof UsageError ? 2 : 1
  }
}

export async function runValidateCommand(
  input: readonly string[],
  baseDirectory?: string,
): Promise<number> {
  const args = input.filter((value) => value !== '--')
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith('--')) {
    process.stderr.write('usage: validate-release-evidence <manifest.json>\n')
    return 2
  }
  try {
    await validateReleaseEvidenceFile(args[0], baseDirectory)
    return 0
  } catch (error: unknown) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Validation failed.'}\n`)
    return 1
  }
}
