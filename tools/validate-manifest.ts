/**
 * Offline manifest validation CLI.
 *
 * Usage:
 *   pnpm manifest:validate -- <absolute-path-to-manifest.json> --tenant <id> [--environment <id>]
 *
 * Performs no network access and starts no server. It loads a local manifest,
 * runs the same strict validation the connector runs, and prints the normalized
 * summary plus the deterministic SHA-256 hash used for ingestion idempotency.
 */
import { resolve } from 'node:path'
import { argv, exit, stdout } from 'node:process'

import {
  acceptManifest,
  loadManifestFile,
  normalizeManifest,
} from '@agent-sentinel/manifest-connector'

interface Args {
  readonly path: string
  readonly tenantId: string
  readonly environmentId?: string
}

function write(line: string): void {
  stdout.write(`${line}\n`)
}

function usage(message: string): never {
  write(`error: ${message}`)
  write('usage: validate-manifest <manifest.json> --tenant <id> [--environment <id>]')
  exit(2)
}

function parseArgs(input: readonly string[]): Args {
  let path: string | undefined
  let tenantId: string | undefined
  let environmentId: string | undefined

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]
    if (token === undefined) continue
    if (token === '--') continue
    if (token === '--tenant' || token === '--environment') {
      const value = input[index + 1]
      if (value === undefined) usage(`${token} requires a value.`)
      if (token === '--tenant') tenantId = value
      else environmentId = value
      index += 1
      continue
    }
    if (token.startsWith('--')) usage(`Unknown option ${token}.`)
    if (path !== undefined) usage('Provide exactly one manifest path.')
    path = token
  }

  if (path === undefined) usage('A manifest path is required.')
  if (tenantId === undefined)
    usage('--tenant is required so the CLI enforces the same tenant binding as the connector.')
  return {
    path,
    tenantId,
    ...(environmentId === undefined ? {} : { environmentId }),
  }
}

async function main(): Promise<number> {
  const args = parseArgs(argv.slice(2))
  const absolute = resolve(args.path)

  let raw: unknown
  try {
    raw = await loadManifestFile(absolute)
  } catch (error: unknown) {
    write(`INVALID  ${absolute}`)
    write(`  ${error instanceof Error ? error.message : 'Manifest could not be read.'}`)
    return 1
  }

  const accepted = acceptManifest(raw, {
    tenantId: args.tenantId,
    ...(args.environmentId === undefined ? {} : { environmentId: args.environmentId }),
  })
  if (!accepted.ok) {
    write(`INVALID  ${absolute}`)
    for (const issue of accepted.errors)
      write(`  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
    return 1
  }

  const { envelope, hash } = accepted.accepted
  const { snapshot, provenance } = normalizeManifest(envelope, {
    tenantId: args.tenantId,
    ...(args.environmentId === undefined ? {} : { environmentId: args.environmentId }),
  })

  const counts = new Map<string, number>()
  for (const node of snapshot.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1)

  write(`VALID    ${absolute}`)
  write(`  manifestId       ${envelope.manifestId}`)
  write(`  schemaVersion    ${envelope.schemaVersion}`)
  write(
    `  producer         ${envelope.producer.name}${envelope.producer.version === undefined ? '' : ` ${envelope.producer.version}`}`,
  )
  write(`  tenantId         ${envelope.tenantId}`)
  write(`  environmentId    ${envelope.environmentId ?? '(absent)'}`)
  write(`  producedAt       ${envelope.producedAt}`)
  write(`  actionDepth      ${envelope.capabilities.supportsActions}`)
  write(`  evidenceDepth    ${envelope.capabilities.evidenceDepth}`)
  write(`  runtimeTelemetry ${String(envelope.capabilities.supportsRuntimeTelemetry)}`)
  write(
    `  nodes            ${String(snapshot.nodes.length)} (${[...counts.entries()]
      .map(([kind, count]) => `${kind}=${String(count)}`)
      .join(', ')})`,
  )
  write(`  edges            ${String(snapshot.edges.length)}`)
  write(`  evidence         ${String(snapshot.evidence.length)}`)
  write(`  sourceOfTruth    ${String(provenance.sourceOfTruth)}`)
  write(`  nonAuthoritative ${String(provenance.isNonAuthoritative)}`)
  write(`  manifestHash     ${hash}`)
  return 0
}

main()
  .then((code) => exit(code))
  .catch((error: unknown) => {
    write(`error: ${error instanceof Error ? error.message : 'Unexpected failure.'}`)
    exit(1)
  })
