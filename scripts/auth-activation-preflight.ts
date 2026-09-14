import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { z } from 'zod'

import { frontDoorMutationGuardContract } from './frontdoor-mutation-guard-contract.js'

export const AUTH_ACTIVATION_ROLES = [
  'AgentSentinel.Viewer',
  'AgentSentinel.Analyst',
  'AgentSentinel.Approver',
  'AgentSentinel.Administrator',
] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA_PATTERN = /^[0-9a-f]{40}$/i
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i
const SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,119}$/
const FORBIDDEN_KEY_PATTERN = /(secret|password|token|credential|certificate|private.?key)/i
const MAX_INPUT_BYTES = 64 * 1024

const estateGrantSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(100),
  tenantId: z.string().regex(UUID_PATTERN),
  environment: z.string().trim().min(1).max(64),
  isDefault: z.boolean(),
  allowedAuthTenantIds: z.array(z.string().regex(UUID_PATTERN)).min(1).max(20),
})

export const authActivationInputSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0.0'),
    environment: z.literal('replacement-validation'),
    production: z.literal(true),
    tenantId: z.string().regex(UUID_PATTERN),
    apiClientId: z.string().regex(UUID_PATTERN),
    spaClientId: z.string().regex(UUID_PATTERN),
    audience: z.string().min(1).max(256),
    issuer: z.string().url().optional(),
    jwksUri: z.string().url().optional(),
    frontDoorOrigin: z.string().url(),
    redirectUri: z.string().url(),
    postLogoutRedirectUri: z.string().url(),
    scopes: z.strictObject({
      read: z.array(z.string().regex(SCOPE_PATTERN)).min(1).max(20),
      write: z.array(z.string().regex(SCOPE_PATTERN)).min(1).max(20),
      spa: z.array(z.string().min(1).max(256)).min(1).max(20),
    }),
    roles: z.array(z.enum(AUTH_ACTIVATION_ROLES)).length(AUTH_ACTIVATION_ROLES.length),
    estateGrants: z.array(estateGrantSchema).min(1).max(50),
    writesEnabled: z.literal(false),
    waf: z.strictObject({
      policyMode: z.literal('Prevention'),
      mutationGuardContractDigest: z.literal(frontDoorMutationGuardContract.contractDigest),
      mutationGuardDeployment: z.literal('separate-after-jwt-read-validation'),
      mutationGuardEnabledDuringAuthActivation: z.literal(false),
      unchanged: z.literal(true),
    }),
    deployment: z.strictObject({
      commitSha: z.string().regex(SHA_PATTERN),
      apiImageDigest: z.string().regex(DIGEST_PATTERN),
      webImageDigest: z.string().regex(DIGEST_PATTERN),
    }),
  })
  .superRefine((input, context) => {
    let origin: URL
    try {
      origin = new URL(input.frontDoorOrigin)
    } catch {
      return
    }
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.port !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      input.frontDoorOrigin !== origin.origin ||
      origin.hostname === 'localhost' ||
      origin.hostname.endsWith('.localhost')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['frontDoorOrigin'],
        message:
          'Production Front Door origin must be an HTTPS origin without credentials, port, path, query, fragment, or localhost.',
      })
    }

    const normalizedOrigin = origin.origin
    const expectedRedirect = `${normalizedOrigin}/auth-redirect.html`
    const expectedLogout = `${normalizedOrigin}/`
    if (input.redirectUri !== expectedRedirect) {
      context.addIssue({
        code: 'custom',
        path: ['redirectUri'],
        message: `Redirect URI must be exactly ${expectedRedirect}.`,
      })
    }
    if (input.postLogoutRedirectUri !== expectedLogout) {
      context.addIssue({
        code: 'custom',
        path: ['postLogoutRedirectUri'],
        message: `Post-logout redirect URI must be exactly ${expectedLogout}.`,
      })
    }

    if (input.apiClientId.toLowerCase() === input.spaClientId.toLowerCase()) {
      context.addIssue({
        code: 'custom',
        path: ['spaClientId'],
        message: 'API and SPA client IDs must identify separate app registrations.',
      })
    }
    const expectedAudience = `api://${input.apiClientId.toLowerCase()}`
    if (input.audience.toLowerCase() !== expectedAudience) {
      context.addIssue({
        code: 'custom',
        path: ['audience'],
        message: `Audience must be exactly api://<api-client-id> (${expectedAudience}).`,
      })
    }

    const authority = `https://login.microsoftonline.com/${input.tenantId.toLowerCase()}`
    const issuer = `${authority}/v2.0`
    const jwksUri = `${authority}/discovery/v2.0/keys`
    if (input.issuer !== undefined && input.issuer.toLowerCase() !== issuer) {
      context.addIssue({
        code: 'custom',
        path: ['issuer'],
        message: 'Issuer must equal the tenant-specific Microsoft Entra v2 issuer.',
      })
    }
    if (input.jwksUri !== undefined && input.jwksUri.toLowerCase() !== jwksUri) {
      context.addIssue({
        code: 'custom',
        path: ['jwksUri'],
        message: 'JWKS URI must equal the tenant-specific Microsoft Entra v2 discovery endpoint.',
      })
    }

    const readScopes = new Set(input.scopes.read)
    const writeScopes = new Set(input.scopes.write)
    if (
      readScopes.size !== input.scopes.read.length ||
      writeScopes.size !== input.scopes.write.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Read and write scope lists must not contain duplicates.',
      })
    }
    if (input.scopes.read.some((scope) => writeScopes.has(scope))) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Read and write scopes must be disjoint.',
      })
    }
    const qualifiedRead = new Set(input.scopes.read.map((scope) => `${input.audience}/${scope}`))
    if (
      new Set(input.scopes.spa).size !== input.scopes.spa.length ||
      input.scopes.spa.some((scope) => !qualifiedRead.has(scope))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scopes', 'spa'],
        message: 'Read-only activation allows the SPA to request only configured read scopes.',
      })
    }

    if (
      new Set(input.roles).size !== AUTH_ACTIVATION_ROLES.length ||
      AUTH_ACTIVATION_ROLES.some((role) => !input.roles.includes(role))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Roles must contain the four exact Agent Sentinel app-role values once each.',
      })
    }

    const estateIds = new Set<string>()
    const estateTenantIds = new Set<string>()
    let defaultCount = 0
    for (const [index, estate] of input.estateGrants.entries()) {
      if (estateIds.has(estate.id)) {
        context.addIssue({
          code: 'custom',
          path: ['estateGrants', index, 'id'],
          message: `Duplicate estate ID: ${estate.id}.`,
        })
      }
      estateIds.add(estate.id)
      if (estateTenantIds.has(estate.tenantId.toLowerCase())) {
        context.addIssue({
          code: 'custom',
          path: ['estateGrants', index, 'tenantId'],
          message: 'Estate tenant IDs must be unique until estate-scoped persistence is enabled.',
        })
      }
      estateTenantIds.add(estate.tenantId.toLowerCase())
      if (estate.isDefault) defaultCount += 1
      if (
        estate.environment !== input.environment ||
        estate.allowedAuthTenantIds.length !== 1 ||
        estate.allowedAuthTenantIds[0]?.toLowerCase() !== input.tenantId.toLowerCase()
      ) {
        context.addIssue({
          code: 'custom',
          path: ['estateGrants', index],
          message:
            'Each estate must use the target environment and grant exactly the configured authentication tenant.',
        })
      }
    }
    if (defaultCount !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['estateGrants'],
        message: 'Exactly one estate grant must be the default.',
      })
    }
  })

export type AuthActivationInput = z.infer<typeof authActivationInputSchema>

export interface AuthActivationCheck {
  readonly id: string
  readonly status: 'pass' | 'block'
  readonly message: string
  readonly path?: string
}

export interface AuthActivationPreflightReport {
  readonly schemaVersion: '1.0.0'
  readonly kind: 'agent-sentinel-auth-activation-preflight'
  readonly status: 'ready' | 'blocked'
  readonly safeToDeploy: boolean
  readonly checks: readonly AuthActivationCheck[]
  readonly derived?: {
    readonly authority: string
    readonly issuer: string
    readonly jwksUri: string
  }
  readonly deploymentPlan?: {
    readonly operation: 'read-only-auth-activation'
    readonly environment: 'replacement-validation'
    readonly defaultMode: 'dry-run'
    readonly requiresProtectedApproval: true
    readonly commitSha: string
    readonly images: {
      readonly apiDigest: string
      readonly webDigest: string
    }
    readonly sequence: readonly [
      {
        readonly order: 1
        readonly target: 'api'
        readonly settings: Readonly<Record<string, string>>
      },
      {
        readonly order: 2
        readonly target: 'web'
        readonly settings: Readonly<Record<string, string>>
      },
    ]
    readonly invariants: readonly string[]
    readonly rollback: {
      readonly captureBeforeApply: true
      readonly restoreOrder: readonly ['web', 'api']
    }
  }
}

function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findForbiddenKeys(item, `${path}[${String(index)}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_KEY_PATTERN.test(key) ? [`${path}.${key}`] : []),
    ...findForbiddenKeys(child, `${path}.${key}`),
  ])
}

function issuePath(path: PropertyKey[]): string {
  return path.length === 0 ? '$' : `$.${path.map(String).join('.')}`
}

export function assessAuthActivation(input: unknown): AuthActivationPreflightReport {
  const forbiddenKeys = findForbiddenKeys(input)
  if (forbiddenKeys.length > 0) {
    return {
      schemaVersion: '1.0.0',
      kind: 'agent-sentinel-auth-activation-preflight',
      status: 'blocked',
      safeToDeploy: false,
      checks: forbiddenKeys.map((path) => ({
        id: 'secret-material-forbidden',
        status: 'block',
        path,
        message: 'Secret, token, credential, certificate, and private-key fields are forbidden.',
      })),
    }
  }

  const parsed = authActivationInputSchema.safeParse(input)
  if (!parsed.success) {
    return {
      schemaVersion: '1.0.0',
      kind: 'agent-sentinel-auth-activation-preflight',
      status: 'blocked',
      safeToDeploy: false,
      checks: parsed.error.issues.map((issue) => ({
        id: 'activation-input-invalid',
        status: 'block',
        path: issuePath(issue.path),
        message: issue.message,
      })),
    }
  }

  const value = parsed.data
  const tenantId = value.tenantId.toLowerCase()
  const authority = `https://login.microsoftonline.com/${tenantId}`
  const issuer = `${authority}/v2.0`
  const jwksUri = `${authority}/discovery/v2.0/keys`
  const estateJson = JSON.stringify(value.estateGrants)
  const apiSettings = {
    AUTH_MODE: 'jwt',
    AUTH_TENANT_ID: tenantId,
    AUTH_AUDIENCE: value.audience.toLowerCase(),
    AUTH_ISSUER: issuer,
    AUTH_JWKS_URI: jwksUri,
    AUTH_SPA_CLIENT_ID: value.spaClientId.toLowerCase(),
    AUTH_SPA_SCOPES: value.scopes.spa.join(','),
    AUTH_SPA_REDIRECT_URI: value.redirectUri,
    AUTH_SPA_POST_LOGOUT_REDIRECT_URI: value.postLogoutRedirectUri,
    AUTH_READ_SCOPES: value.scopes.read.join(','),
    AUTH_WRITE_SCOPES: value.scopes.write.join(','),
    AGENT_SENTINEL_ESTATES_JSON: estateJson,
    AGENT_SENTINEL_WRITE_ENABLED: 'false',
    AGENT_SENTINEL_API_SHA: value.deployment.commitSha.toLowerCase(),
    AGENT_SENTINEL_WEB_SHA: value.deployment.commitSha.toLowerCase(),
    AGENT_SENTINEL_API_IMAGE_DIGEST: value.deployment.apiImageDigest.toLowerCase(),
    AGENT_SENTINEL_WEB_IMAGE_DIGEST: value.deployment.webImageDigest.toLowerCase(),
  } as const

  return {
    schemaVersion: '1.0.0',
    kind: 'agent-sentinel-auth-activation-preflight',
    status: 'ready',
    safeToDeploy: true,
    checks: [
      {
        id: 'sanitized-input-only',
        status: 'pass',
        message: 'Input contains no secret-shaped fields.',
      },
      {
        id: 'entra-v2-endpoints',
        status: 'pass',
        message: 'Issuer and JWKS are derived from the exact tenant-specific Entra v2 endpoints.',
      },
      {
        id: 'same-origin-redirects',
        status: 'pass',
        message: 'Redirect and logout URIs use the exact production Front Door origin and paths.',
      },
      {
        id: 'read-only-boundary',
        status: 'pass',
        message:
          'SPA scopes are read-only, application writes are disabled, and this activation makes no WAF change.',
      },
      {
        id: 'roles-and-estates',
        status: 'pass',
        message: 'Four exact app roles and bounded single-issuer estate grants are declared.',
      },
      {
        id: 'immutable-images',
        status: 'pass',
        message: 'API and web images are pinned to canonical SHA-256 digests.',
      },
    ],
    derived: { authority, issuer, jwksUri },
    deploymentPlan: {
      operation: 'read-only-auth-activation',
      environment: value.environment,
      defaultMode: 'dry-run',
      requiresProtectedApproval: true,
      commitSha: value.deployment.commitSha.toLowerCase(),
      images: {
        apiDigest: value.deployment.apiImageDigest.toLowerCase(),
        webDigest: value.deployment.webImageDigest.toLowerCase(),
      },
      sequence: [
        { order: 1, target: 'api', settings: apiSettings },
        {
          order: 2,
          target: 'web',
          settings: {
            imageDigest: value.deployment.webImageDigest.toLowerCase(),
            redirectOrigin: value.frontDoorOrigin,
          },
        },
      ],
      invariants: [
        'AGENT_SENTINEL_WRITE_ENABLED remains false.',
        `Front Door mutation contract ${value.waf.mutationGuardContractDigest} is deployed only after JWT read validation.`,
        'No Entra application, grant, role assignment, secret, or WAF resource is mutated.',
        'API is updated and verified before web.',
      ],
      rollback: { captureBeforeApply: true, restoreOrder: ['web', 'api'] },
    },
  }
}

interface CliOptions {
  readonly inputPath?: string
  readonly outputPath?: string
  readonly values: Map<string, string[]>
}

function parseCliOptions(argv: readonly string[]): CliOptions {
  if (Buffer.byteLength(argv.join('\0'), 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`Activation options must not exceed ${String(MAX_INPUT_BYTES)} bytes.`)
  }
  const values = new Map<string, string[]>()
  let inputPath: string | undefined
  let outputPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error('All arguments must use named --options.')
    }
    const name = argument.slice(2)
    if (FORBIDDEN_KEY_PATTERN.test(name)) {
      throw new Error(
        'Secret, token, credential, certificate, and private-key options are forbidden.',
      )
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`)
    }
    index += 1
    if (name === 'input') inputPath = next
    else if (name === 'output') outputPath = next
    else values.set(name, [...(values.get(name) ?? []), next])
  }
  if (inputPath !== undefined && values.size > 0) {
    throw new Error('--input cannot be combined with activation data options.')
  }
  return {
    ...(inputPath === undefined ? {} : { inputPath }),
    ...(outputPath === undefined ? {} : { outputPath }),
    values,
  }
}

function one(values: Map<string, string[]>, name: string): string | undefined {
  const items = values.get(name)
  if (items === undefined) return undefined
  if (items.length !== 1) throw new Error(`Option --${name} may be supplied only once.`)
  return items[0]
}

function required(values: Map<string, string[]>, name: string): string {
  const value = one(values, name)
  if (value === undefined || value.trim() === '')
    throw new Error(`Missing required option --${name}.`)
  return value
}

function repeated(values: Map<string, string[]>, name: string): string[] {
  const items = values.get(name)
  if (items === undefined || items.length === 0)
    throw new Error(`Missing required option --${name}.`)
  return items
}

function invocationPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env['INIT_CWD'] ?? process.cwd(), path)
}

function inputFromOptions(values: Map<string, string[]>): unknown {
  const known = new Set([
    'environment',
    'tenant-id',
    'api-client-id',
    'spa-client-id',
    'audience',
    'issuer',
    'jwks-uri',
    'front-door-origin',
    'redirect-uri',
    'post-logout-redirect-uri',
    'read-scope',
    'write-scope',
    'spa-scope',
    'role',
    'estate-grants-json',
    'commit-sha',
    'api-image-digest',
    'web-image-digest',
    'production',
    'writes-enabled',
    'waf-policy-mode',
    'waf-contract-digest',
    'waf-guard-deployment',
    'waf-guard-enabled',
    'waf-unchanged',
  ])
  const unknown = [...values.keys()].filter((name) => !known.has(name))
  if (unknown.length > 0) throw new Error(`Unknown activation option: --${unknown[0]}.`)

  let estateGrants: unknown
  try {
    estateGrants = JSON.parse(required(values, 'estate-grants-json')) as unknown
  } catch {
    throw new Error('--estate-grants-json must contain valid sanitized JSON.')
  }
  const issuer = one(values, 'issuer')
  const jwksUri = one(values, 'jwks-uri')
  return {
    schemaVersion: '1.0.0',
    environment: required(values, 'environment'),
    production: required(values, 'production') === 'true',
    tenantId: required(values, 'tenant-id'),
    apiClientId: required(values, 'api-client-id'),
    spaClientId: required(values, 'spa-client-id'),
    audience: required(values, 'audience'),
    ...(issuer === undefined ? {} : { issuer }),
    ...(jwksUri === undefined ? {} : { jwksUri }),
    frontDoorOrigin: required(values, 'front-door-origin'),
    redirectUri: required(values, 'redirect-uri'),
    postLogoutRedirectUri: required(values, 'post-logout-redirect-uri'),
    scopes: {
      read: repeated(values, 'read-scope'),
      write: repeated(values, 'write-scope'),
      spa: repeated(values, 'spa-scope'),
    },
    roles: repeated(values, 'role'),
    estateGrants,
    writesEnabled: required(values, 'writes-enabled') === 'true',
    waf: {
      policyMode: required(values, 'waf-policy-mode'),
      mutationGuardContractDigest: required(values, 'waf-contract-digest'),
      mutationGuardDeployment: required(values, 'waf-guard-deployment'),
      mutationGuardEnabledDuringAuthActivation: required(values, 'waf-guard-enabled') === 'true',
      unchanged: required(values, 'waf-unchanged') === 'true',
    },
    deployment: {
      commitSha: required(values, 'commit-sha'),
      apiImageDigest: required(values, 'api-image-digest'),
      webImageDigest: required(values, 'web-image-digest'),
    },
  }
}

export async function readAuthActivationInput(argv: readonly string[]): Promise<{
  readonly input: unknown
  readonly outputPath?: string
}> {
  const options = parseCliOptions(argv)
  if (options.inputPath === undefined) {
    return {
      input: inputFromOptions(options.values),
      ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
    }
  }
  const candidates = isAbsolute(options.inputPath)
    ? [options.inputPath]
    : [
        ...(process.env['INIT_CWD'] === undefined
          ? []
          : [resolve(process.env['INIT_CWD'], options.inputPath)]),
        resolve(options.inputPath),
      ]
  let contents: string | undefined
  let lastError: unknown
  for (const candidate of [...new Set(candidates)]) {
    try {
      contents = await readFile(candidate, 'utf8')
      break
    } catch (error: unknown) {
      lastError = error
    }
  }
  if (contents === undefined) throw lastError
  if (Buffer.byteLength(contents, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`Activation input must not exceed ${String(MAX_INPUT_BYTES)} bytes.`)
  }
  return {
    input: JSON.parse(contents) as unknown,
    ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
  }
}

export async function runAuthActivationPreflightCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { input, outputPath } = await readAuthActivationInput(argv)
    const report = assessAuthActivation(input)
    const output = `${JSON.stringify(report, null, 2)}\n`
    if (outputPath !== undefined)
      await writeFile(invocationPath(outputPath), output, { mode: 0o600 })
    process.stdout.write(output)
    return report.safeToDeploy ? 0 : 2
  } catch (error: unknown) {
    const report: AuthActivationPreflightReport = {
      schemaVersion: '1.0.0',
      kind: 'agent-sentinel-auth-activation-preflight',
      status: 'blocked',
      safeToDeploy: false,
      checks: [
        {
          id: 'preflight-input-error',
          status: 'block',
          message: error instanceof Error ? error.message : 'Authentication preflight failed.',
        },
      ],
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 2
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) process.exitCode = await runAuthActivationPreflightCli()
