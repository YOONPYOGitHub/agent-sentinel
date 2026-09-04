import { dirname, resolve } from 'node:path'
import { argv, cwd, env, exit, stderr, stdout } from 'node:process'
import { mkdir, writeFile } from 'node:fs/promises'

import {
  generateReleaseEvidence,
  loadSanitizedJsonFile,
  loadSanitizedLiveResultFile,
  projectAllowListedConfiguration,
  readRepositoryState,
  type ReleaseEvidenceManifest,
} from './release-evidence.js'

interface Args {
  readonly repoRoot: string
  readonly output?: string
  readonly generatedAt?: string
  readonly configFile?: string
  readonly configKeys: readonly string[]
  readonly liveResultFiles: readonly string[]
  readonly expectedImages: readonly ReleaseEvidenceManifest['images']['expected'][number][]
  readonly deployedImages: readonly ReleaseEvidenceManifest['images']['deployed'][number][]
}

class UsageError extends Error {
  override readonly name = 'UsageError'
}

const usage = [
  'usage: generate-release-evidence [--repo-root <path>] [--output <path>]',
  '  [--generated-at <iso>] [--config-file <json> --config-key <key>...]',
  '  [--live-result <sanitized-json>...] [--expected-image <name=tag[,sha256:digest]>]',
  '  [--deployed-image <name=tag[,sha256:digest]>]',
].join('\n')

function valueAfter(input: readonly string[], index: number, option: string): string {
  const value = input[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--')) {
    throw new UsageError(`${option} requires a non-empty value.`)
  }
  return value
}

function parseImage(value: string, classification: 'planned' | 'live'): ReleaseEvidenceManifest['images']['expected'][number] {
  const [nameAndTag, digest] = value.split(',', 2)
  if (nameAndTag === undefined) throw new UsageError('Image must use name=tag syntax.')
  const separator = nameAndTag.indexOf('=')
  if (separator <= 0 || separator === nameAndTag.length - 1) throw new UsageError('Image must use name=tag syntax.')
  const image = {
    name: nameAndTag.slice(0, separator),
    tag: nameAndTag.slice(separator + 1),
    classification,
    ...(digest === undefined ? {} : { digest }),
  }
  return image
}

function parseArgs(input: readonly string[]): Args {
  let repoRoot = env['INIT_CWD'] ?? cwd()
  let output: string | undefined
  let generatedAt: string | undefined
  let configFile: string | undefined
  const configKeys: string[] = []
  const liveResultFiles: string[] = []
  const expectedImages: ReleaseEvidenceManifest['images']['expected'][number][] = []
  const deployedImages: ReleaseEvidenceManifest['images']['deployed'][number][] = []

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]
    if (token === undefined || token === '--') continue
    if (token === '--help') throw new UsageError(usage)
    if (token === '--repo-root') {
      repoRoot = valueAfter(input, index, token)
      index += 1
    } else if (token === '--output') {
      output = valueAfter(input, index, token)
      index += 1
    } else if (token === '--generated-at') {
      generatedAt = valueAfter(input, index, token)
      index += 1
    } else if (token === '--config-file') {
      configFile = valueAfter(input, index, token)
      index += 1
    } else if (token === '--config-key') {
      configKeys.push(valueAfter(input, index, token))
      index += 1
    } else if (token === '--live-result') {
      liveResultFiles.push(valueAfter(input, index, token))
      index += 1
    } else if (token === '--expected-image') {
      expectedImages.push(parseImage(valueAfter(input, index, token), 'planned'))
      index += 1
    } else if (token === '--deployed-image') {
      deployedImages.push(parseImage(valueAfter(input, index, token), 'live'))
      index += 1
    } else {
      throw new UsageError(`Unknown option ${token}.\n${usage}`)
    }
  }

  if (configFile === undefined && configKeys.length > 0) throw new UsageError('--config-key requires --config-file.')
  if (configFile !== undefined && configKeys.length === 0) throw new UsageError('--config-file requires at least one --config-key.')

  return {
    repoRoot: resolve(repoRoot),
    configKeys,
    liveResultFiles,
    expectedImages,
    deployedImages,
    ...(output === undefined ? {} : { output }),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    ...(configFile === undefined ? {} : { configFile }),
  }
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv.slice(2))
  } catch (error: unknown) {
    stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}\n`)
    return error instanceof UsageError && error.message === usage ? 0 : 2
  }

  try {
    const repository = await readRepositoryState(args.repoRoot)
    const liveResultFiles = await Promise.all(
      args.liveResultFiles.map((path) => loadSanitizedLiveResultFile(resolve(args.repoRoot, path))),
    )
    const configuration = args.configFile === undefined
      ? undefined
      : projectAllowListedConfiguration(
          await loadSanitizedJsonFile(resolve(args.repoRoot, args.configFile)),
          args.configKeys,
        )
    const manifest = generateReleaseEvidence({
      repository,
      generatedAt: args.generatedAt ?? new Date().toISOString(),
      expectedImages: args.expectedImages,
      deployedImages: args.deployedImages,
      ...(configuration === undefined ? {} : { configuration }),
      liveResultFiles,
    })
    const output = `${JSON.stringify(manifest, null, 2)}\n`
    if (args.output === undefined) {
      stdout.write(output)
      return 0
    }
    const outputPath = resolve(args.repoRoot, args.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, output, 'utf8')
    stdout.write(`wrote ${outputPath}\n`)
    return 0
  } catch (error: unknown) {
    stderr.write(`release evidence generation failed: ${error instanceof Error ? error.message : 'Unexpected failure.'}\n`)
    return 1
  }
}

main()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    stderr.write(`release evidence generation failed: ${error instanceof Error ? error.message : 'Unexpected failure.'}\n`)
    exit(1)
  })
