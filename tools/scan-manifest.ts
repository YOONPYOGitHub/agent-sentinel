/**
 * Offline shift-left policy scanner.
 *
 * Exit codes: 0 accepted, 1 policy gate failed, 2 invalid input, 3 unexpected failure.
 */
import { resolve } from 'node:path'
import { argv, cwd, env, stdout } from 'node:process'

import { loadManifestFile } from '@agent-sentinel/manifest-connector'
import {
  scanManifest,
  SHIFT_LEFT_REPORT_VERSION,
  type ShiftLeftDecision,
  type ShiftLeftReport,
} from '@agent-sentinel/shift-left-scanner'

interface Args {
  readonly path: string
  readonly tenantId: string
  readonly environmentId?: string
  readonly format: 'json' | 'text'
  readonly failOn: Exclude<ShiftLeftDecision, 'pass'>
}

class UsageError extends Error {
  override readonly name = 'UsageError'
}

const usage =
  'usage: scan-manifest <manifest.json> --tenant <id> [--environment <id>] [--format json|text] [--fail-on block|warn]'

function write(value: string): void {
  stdout.write(`${value}\n`)
}

function requiredValue(input: readonly string[], index: number, option: string): string {
  const value = input[index + 1]
  if (value === undefined || value.trim() === '' || value.startsWith('--'))
    throw new UsageError(`${option} requires a non-empty value.`)
  return value
}

function parseArgs(input: readonly string[]): Args {
  let path: string | undefined
  let tenantId: string | undefined
  let environmentId: string | undefined
  let format: Args['format'] = 'json'
  let failOn: Args['failOn'] = 'block'
  const seen = new Set<string>()

  for (let index = 0; index < input.length; index += 1) {
    const token = input[index]
    if (token === undefined || token === '--') continue
    if (['--tenant', '--environment', '--format', '--fail-on'].includes(token)) {
      if (seen.has(token)) throw new UsageError(`${token} may be provided only once.`)
      seen.add(token)
      const value = requiredValue(input, index, token)
      if (token === '--tenant') tenantId = value
      else if (token === '--environment') environmentId = value
      else if (token === '--format') {
        if (value !== 'json' && value !== 'text')
          throw new UsageError('--format must be json or text.')
        format = value
      } else {
        if (value !== 'block' && value !== 'warn')
          throw new UsageError('--fail-on must be block or warn.')
        failOn = value
      }
      index += 1
      continue
    }
    if (token.startsWith('--')) throw new UsageError(`Unknown option ${token}.`)
    if (path !== undefined) throw new UsageError('Provide exactly one manifest path.')
    path = token
  }

  if (path === undefined) throw new UsageError('A manifest path is required.')
  if (tenantId === undefined)
    throw new UsageError('--tenant is required so scanning enforces the manifest tenant boundary.')
  return {
    path,
    tenantId,
    format,
    failOn,
    ...(environmentId === undefined ? {} : { environmentId }),
  }
}

function renderText(report: ShiftLeftReport): string {
  const lines = [
    `${report.decision.toUpperCase()} ${report.manifest.manifestId}`,
    `manifestHash: ${report.manifest.manifestHash}`,
    `tenant/environment: ${report.manifest.tenantId}/${report.manifest.environmentId}`,
    'evidence boundary: non-authoritative manifest declarations; sourceOfTruth=false',
  ]
  for (const policy of report.policies) {
    lines.push('', `[${policy.decision.toUpperCase()}] ${policy.policyId} ${policy.policyName}`)
    for (const item of policy.findings) {
      lines.push(`  ${item.finding.title}`)
      lines.push(`  Why: ${item.finding.summary}`)
      lines.push(`  Fix: ${item.finding.recommendation}`)
      lines.push('  Evidence:')
      for (const evidence of item.evidence)
        lines.push(
          `    - ${evidence.id} (${evidence.observedAt}, confidence=${String(evidence.confidence)}): ${evidence.summary}`,
        )
    }
  }
  lines.push(
    '',
    `Summary: ${String(report.summary.policiesEvaluated)} policies; ${String(report.summary.policiesPassed)} passed; ${String(report.summary.warningFindings)} warnings; ${String(report.summary.blockingFindings)} blocking.`,
  )
  return lines.join('\n')
}

function invalidOutput(message: string, path = '', includeUsage = false): string {
  return JSON.stringify(
    {
      schemaVersion: SHIFT_LEFT_REPORT_VERSION,
      decision: 'invalid',
      errors: [{ path, message }],
      ...(includeUsage ? { usage } : {}),
    },
    null,
    2,
  )
}

async function main(): Promise<number> {
  if (argv.slice(2).length === 1 && argv[2] === '--help') {
    write(usage)
    return 0
  }

  let args: Args
  try {
    args = parseArgs(argv.slice(2))
  } catch (error: unknown) {
    write(invalidOutput(error instanceof Error ? error.message : 'Invalid command line.', '', true))
    return 2
  }

  const absolute = resolve(env['INIT_CWD'] ?? cwd(), args.path)
  let raw: unknown
  try {
    raw = await loadManifestFile(absolute)
  } catch (error: unknown) {
    write(invalidOutput(error instanceof Error ? error.message : 'Manifest could not be read.'))
    return 2
  }

  const result = scanManifest(raw, {
    tenantId: args.tenantId,
    ...(args.environmentId === undefined ? {} : { environmentId: args.environmentId }),
  })
  if (!result.ok) {
    write(
      JSON.stringify(
        {
          schemaVersion: SHIFT_LEFT_REPORT_VERSION,
          decision: 'invalid',
          errors: result.errors,
        },
        null,
        2,
      ),
    )
    return 2
  }

  write(args.format === 'json' ? JSON.stringify(result.report, null, 2) : renderText(result.report))
  if (result.report.decision === 'block') return 1
  if (result.report.decision === 'warn' && args.failOn === 'warn') return 1
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    write(invalidOutput(error instanceof Error ? error.message : 'Unexpected scanner failure.'))
    process.exitCode = 3
  })
