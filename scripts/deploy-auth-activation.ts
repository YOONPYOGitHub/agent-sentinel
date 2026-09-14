import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { z } from 'zod'

import {
  assessAuthActivation,
  authActivationInputSchema,
  readAuthActivationInput,
  type AuthActivationInput,
} from './auth-activation-preflight.js'

const APPROVAL = 'APPROVE_READ_ONLY_AUTH_ACTIVATION'
const RESOURCE_GROUP_PATTERN = /^[A-Za-z0-9._()-]{1,90}$/
const CONTAINER_APP_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/
const ACR_LOGIN_SERVER_PATTERN = /^[a-z0-9]{5,50}\.azurecr\.io$/
const PUBLIC_AUTH_CONFIG_MAX_BYTES = 64 * 1024

const publicAuthConfigSchema = z.strictObject({
  enabled: z.literal(true),
  tenantId: z.string().uuid(),
  clientId: z.string().uuid(),
  authority: z.url(),
  scopes: z.array(z.string().min(1)).min(1),
  redirectUri: z.url(),
  postLogoutRedirectUri: z.url(),
})

const API_ENVIRONMENT_VARIABLES = [
  'AUTH_MODE',
  'AUTH_TENANT_ID',
  'AUTH_AUDIENCE',
  'AUTH_ISSUER',
  'AUTH_JWKS_URI',
  'AUTH_SPA_CLIENT_ID',
  'AUTH_SPA_SCOPES',
  'AUTH_SPA_REDIRECT_URI',
  'AUTH_SPA_POST_LOGOUT_REDIRECT_URI',
  'AUTH_READ_SCOPES',
  'AUTH_WRITE_SCOPES',
  'AGENT_SENTINEL_ESTATES_JSON',
  'AGENT_SENTINEL_WRITE_ENABLED',
  'AGENT_SENTINEL_API_SHA',
  'AGENT_SENTINEL_WEB_SHA',
  'AGENT_SENTINEL_API_IMAGE_DIGEST',
  'AGENT_SENTINEL_WEB_IMAGE_DIGEST',
] as const

interface DeploymentCliOptions {
  readonly inputArguments: string[]
  readonly resourceGroup: string
  readonly apiApp: string
  readonly webApp: string
  readonly acrLoginServer: string
  readonly expectedCommitSha?: string
  readonly rollbackOutput?: string
  readonly apply: boolean
  readonly approval?: string
}

interface ContainerEnvironmentVariable {
  readonly name: string
  readonly value?: string
  readonly secretRef?: string
}

interface ContainerView {
  readonly name?: string
  readonly image?: string
  readonly env?: readonly ContainerEnvironmentVariable[]
}

interface ContainerAppView {
  readonly name?: string
  readonly properties?: {
    readonly latestReadyRevisionName?: string
    readonly template?: {
      readonly containers?: readonly ContainerView[]
    }
  }
}

interface ComponentRollback {
  readonly name: string
  readonly revision?: string
  readonly image: string
  readonly environment?: Readonly<Record<string, string>>
  readonly absentEnvironment?: readonly string[]
}

export interface AuthActivationRollback {
  readonly schemaVersion: '1.0.0'
  readonly capturedAt: string
  readonly resourceGroup: string
  readonly components: {
    readonly api: ComponentRollback
    readonly web: ComponentRollback
  }
}

function requiredOption(args: Map<string, string[]>, name: string): string {
  const values = args.get(name)
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new Error(`Exactly one --${name} value is required.`)
  }
  return value
}

function parseDeploymentCli(argv: readonly string[]): DeploymentCliOptions {
  const values = new Map<string, string[]>()
  let apply = false
  const inputArguments: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error('All deployment arguments must use named --options.')
    }
    const name = argument.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`)
    }
    index += 1
    if (name === 'input') {
      inputArguments.push('--input', next)
    } else {
      values.set(name, [...(values.get(name) ?? []), next])
    }
  }
  if (inputArguments.length === 0) {
    throw new Error('--input is required for the deployment path.')
  }
  const known = new Set([
    'resource-group',
    'api-app',
    'web-app',
    'acr-login-server',
    'expected-commit-sha',
    'rollback-output',
    'approval',
  ])
  const unknown = [...values.keys()].filter((name) => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(`Unknown deployment option: --${unknown[0] ?? 'unknown'}.`)
  }
  const rollbackOutput = values.get('rollback-output')?.[0]
  const approval = values.get('approval')?.[0]
  const expectedCommitSha = values.get('expected-commit-sha')?.[0]
  return {
    inputArguments,
    resourceGroup: requiredOption(values, 'resource-group'),
    apiApp: requiredOption(values, 'api-app'),
    webApp: requiredOption(values, 'web-app'),
    acrLoginServer: requiredOption(values, 'acr-login-server'),
    ...(expectedCommitSha === undefined ? {} : { expectedCommitSha }),
    ...(rollbackOutput === undefined ? {} : { rollbackOutput }),
    apply,
    ...(approval === undefined ? {} : { approval }),
  }
}

function validateDeploymentTarget(options: DeploymentCliOptions): void {
  if (!RESOURCE_GROUP_PATTERN.test(options.resourceGroup) || options.resourceGroup.includes('..')) {
    throw new Error('Resource group name is invalid.')
  }
  if (!CONTAINER_APP_PATTERN.test(options.apiApp) || !CONTAINER_APP_PATTERN.test(options.webApp)) {
    throw new Error('Container App names are invalid.')
  }
  if (!ACR_LOGIN_SERVER_PATTERN.test(options.acrLoginServer)) {
    throw new Error('ACR login server must be an exact lowercase azurecr.io hostname.')
  }
  if (
    options.expectedCommitSha !== undefined &&
    !/^[0-9a-f]{40}$/i.test(options.expectedCommitSha)
  ) {
    throw new Error('Expected commit SHA must be exactly 40 hexadecimal characters.')
  }
  if (options.apiApp === options.webApp) {
    throw new Error('API and web Container App names must be different.')
  }
  if (options.apply && options.approval !== APPROVAL) {
    throw new Error(`Apply requires --approval ${APPROVAL}.`)
  }
  if (options.apply && options.rollbackOutput === undefined) {
    throw new Error('Apply requires --rollback-output so the prior state is captured.')
  }
}

function azJson(args: readonly string[]): unknown {
  const result = spawnSync('az', [...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`Azure CLI command failed: az ${args.slice(0, 3).join(' ')}.`)
  }
  try {
    return JSON.parse(result.stdout) as unknown
  } catch {
    throw new Error('Azure CLI returned malformed JSON.')
  }
}

function azUpdate(args: readonly string[]): void {
  const result = spawnSync('az', [...args, '--output', 'none'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`Azure CLI update failed: az ${args.slice(0, 4).join(' ')}.`)
  }
}

function appView(resourceGroup: string, appName: string): ContainerAppView {
  const value = azJson([
    'containerapp',
    'show',
    '--resource-group',
    resourceGroup,
    '--name',
    appName,
  ])
  if (typeof value !== 'object' || value === null) throw new Error('Container App lookup failed.')
  return value
}

function component(
  view: ContainerAppView,
  appName: string,
  containerName: string,
  includeAuthEnvironment: boolean,
): ComponentRollback {
  const container = view.properties?.template?.containers?.find(
    (candidate) => candidate.name === containerName,
  )
  if (container?.image === undefined) {
    throw new Error(`${appName} does not contain the expected ${containerName} container.`)
  }
  const revision = view.properties?.latestReadyRevisionName
  if (!includeAuthEnvironment) {
    return {
      name: appName,
      ...(revision === undefined ? {} : { revision }),
      image: container.image,
    }
  }
  const selected = new Map(
    (container.env ?? [])
      .filter((entry) => (API_ENVIRONMENT_VARIABLES as readonly string[]).includes(entry.name))
      .map((entry) => [entry.name, entry]),
  )
  const environment: Record<string, string> = {}
  for (const name of API_ENVIRONMENT_VARIABLES) {
    const entry = selected.get(name)
    if (entry?.secretRef !== undefined) {
      throw new Error(
        `Existing ${name} unexpectedly uses a secret reference; activation is blocked.`,
      )
    }
    if (entry?.value !== undefined) environment[name] = entry.value
  }
  return {
    name: appName,
    ...(revision === undefined ? {} : { revision }),
    image: container.image,
    environment,
    absentEnvironment: API_ENVIRONMENT_VARIABLES.filter((name) => !selected.has(name)),
  }
}

function captureRollback(options: DeploymentCliOptions): AuthActivationRollback {
  return {
    schemaVersion: '1.0.0',
    capturedAt: new Date().toISOString(),
    resourceGroup: options.resourceGroup,
    components: {
      api: component(
        appView(options.resourceGroup, options.apiApp),
        options.apiApp,
        'agent-sentinel-api',
        true,
      ),
      web: component(
        appView(options.resourceGroup, options.webApp),
        options.webApp,
        'agent-sentinel-web',
        false,
      ),
    },
  }
}

function updateArguments(
  resourceGroup: string,
  appName: string,
  containerName: string,
  image: string,
  revisionSuffix: string,
  environment?: Readonly<Record<string, string>>,
  removeEnvironment?: readonly string[],
): string[] {
  return [
    'containerapp',
    'update',
    '--resource-group',
    resourceGroup,
    '--name',
    appName,
    '--container-name',
    containerName,
    '--image',
    image,
    '--revision-suffix',
    revisionSuffix,
    ...(environment === undefined
      ? []
      : [
          '--set-env-vars',
          ...Object.entries(environment).map(([name, value]) => `${name}=${value}`),
        ]),
    ...(removeEnvironment === undefined || removeEnvironment.length === 0
      ? []
      : ['--remove-env-vars', ...removeEnvironment]),
  ]
}

function currentContainer(
  resourceGroup: string,
  appName: string,
  containerName: string,
): ContainerView {
  const view = appView(resourceGroup, appName)
  const container = view.properties?.template?.containers?.find(
    (candidate) => candidate.name === containerName,
  )
  if (container === undefined)
    throw new Error(`${appName} verification could not find ${containerName}.`)
  return container
}

function verifyApi(
  options: DeploymentCliOptions,
  expectedImage: string,
  expectedEnvironment: Readonly<Record<string, string>>,
): void {
  const container = currentContainer(options.resourceGroup, options.apiApp, 'agent-sentinel-api')
  if (container.image !== expectedImage) throw new Error('API image digest verification failed.')
  const actualEnvironment = new Map((container.env ?? []).map((entry) => [entry.name, entry.value]))
  for (const [name, value] of Object.entries(expectedEnvironment)) {
    if (actualEnvironment.get(name) !== value) {
      throw new Error(`API environment verification failed for ${name}.`)
    }
  }
}

function verifyWeb(options: DeploymentCliOptions, expectedImage: string): void {
  const container = currentContainer(options.resourceGroup, options.webApp, 'agent-sentinel-web')
  if (container.image !== expectedImage) throw new Error('Web image digest verification failed.')
}

export async function verifyPublicAuthConfig(
  input: AuthActivationInput,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImplementation(`${input.frontDoorOrigin}/api/auth/config`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (response.status !== 200) {
      throw new Error(`Public auth configuration returned status ${String(response.status)}.`)
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > PUBLIC_AUTH_CONFIG_MAX_BYTES) {
      throw new Error(
        `Public auth configuration response exceeded ${String(PUBLIC_AUTH_CONFIG_MAX_BYTES)} bytes.`,
      )
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > PUBLIC_AUTH_CONFIG_MAX_BYTES) {
      throw new Error(
        `Public auth configuration response exceeded ${String(PUBLIC_AUTH_CONFIG_MAX_BYTES)} bytes.`,
      )
    }
    const body = publicAuthConfigSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    const tenantId = input.tenantId.toLowerCase()
    const expectedAuthority = `https://login.microsoftonline.com/${tenantId}`
    const scopesMatch =
      body.scopes.length === input.scopes.spa.length &&
      input.scopes.spa.every((scope) => body.scopes.includes(scope))
    if (
      body.tenantId !== tenantId ||
      body.clientId !== input.spaClientId.toLowerCase() ||
      body.authority !== expectedAuthority ||
      !scopesMatch ||
      body.redirectUri !== input.redirectUri ||
      body.postLogoutRedirectUri !== input.postLogoutRedirectUri
    ) {
      throw new Error('Public auth configuration does not match the approved activation input.')
    }
  } finally {
    clearTimeout(timeout)
  }
}

function restore(options: DeploymentCliOptions, rollback: AuthActivationRollback): void {
  const suffix = Date.now().toString(36).slice(-8)
  azUpdate(
    updateArguments(
      options.resourceGroup,
      rollback.components.web.name,
      'agent-sentinel-web',
      rollback.components.web.image,
      `rollback-web-${suffix}`,
    ),
  )
  azUpdate(
    updateArguments(
      options.resourceGroup,
      rollback.components.api.name,
      'agent-sentinel-api',
      rollback.components.api.image,
      `rollback-api-${suffix}`,
      rollback.components.api.environment,
      rollback.components.api.absentEnvironment,
    ),
  )
}

export async function runAuthActivationDeploymentCli(
  argv = process.argv.slice(2),
): Promise<number> {
  try {
    const options = parseDeploymentCli(argv)
    validateDeploymentTarget(options)
    const { input: rawInput } = await readAuthActivationInput(options.inputArguments)
    const preflight = assessAuthActivation(rawInput)
    if (!preflight.safeToDeploy || preflight.deploymentPlan === undefined) {
      process.stdout.write(`${JSON.stringify({ mode: 'blocked', preflight }, null, 2)}\n`)
      return 2
    }
    const input = authActivationInputSchema.parse(rawInput)
    if (
      options.expectedCommitSha !== undefined &&
      input.deployment.commitSha.toLowerCase() !== options.expectedCommitSha.toLowerCase()
    ) {
      throw new Error('Activation input commit SHA does not match the checked-out workflow SHA.')
    }
    const apiImage = `${options.acrLoginServer}/agent-sentinel-api@${input.deployment.apiImageDigest.toLowerCase()}`
    const webImage = `${options.acrLoginServer}/agent-sentinel-web@${input.deployment.webImageDigest.toLowerCase()}`
    const apiEnvironment = preflight.deploymentPlan.sequence[0].settings
    const summary = {
      schemaVersion: '1.0.0',
      kind: 'agent-sentinel-auth-activation-deployment',
      mode: options.apply ? 'apply' : 'dry-run',
      target: {
        resourceGroup: options.resourceGroup,
        apiApp: options.apiApp,
        webApp: options.webApp,
      },
      sequence: [
        { order: 1, target: 'api', image: apiImage, settings: apiEnvironment },
        { order: 2, target: 'web', image: webImage },
      ],
      invariants: preflight.deploymentPlan.invariants,
    }
    if (!options.apply) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
      return 0
    }

    const rollback = captureRollback(options)
    const rollbackOutput = options.rollbackOutput ?? ''
    const rollbackPath =
      rollbackOutput.startsWith('/') || process.env['INIT_CWD'] === undefined
        ? resolve(rollbackOutput)
        : resolve(process.env['INIT_CWD'], rollbackOutput)
    await writeFile(rollbackPath, `${JSON.stringify(rollback, null, 2)}\n`, { mode: 0o600 })
    let apiUpdated = false
    let webUpdated = false
    const suffix = `${input.deployment.commitSha.slice(0, 7)}-${Date.now().toString(36).slice(-6)}`
    try {
      azUpdate(
        updateArguments(
          options.resourceGroup,
          options.apiApp,
          'agent-sentinel-api',
          apiImage,
          `auth-api-${suffix}`,
          apiEnvironment,
        ),
      )
      apiUpdated = true
      verifyApi(options, apiImage, apiEnvironment)
      await verifyPublicAuthConfig(input)

      azUpdate(
        updateArguments(
          options.resourceGroup,
          options.webApp,
          'agent-sentinel-web',
          webImage,
          `auth-web-${suffix}`,
        ),
      )
      webUpdated = true
      verifyWeb(options, webImage)
      await verifyPublicAuthConfig(input)
    } catch (error: unknown) {
      if (apiUpdated || webUpdated) {
        try {
          restore(options, rollback)
        } catch {
          throw new Error(
            `${error instanceof Error ? error.message : 'Authentication activation failed.'} Automatic rollback also failed; use the captured rollback file.`,
          )
        }
      }
      throw error
    }
    process.stdout.write(
      `${JSON.stringify({ ...summary, status: 'applied', rollbackCaptured: true }, null, 2)}\n`,
    )
    return 0
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Authentication deployment failed.'}\n`,
    )
    return 1
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) process.exitCode = await runAuthActivationDeploymentCli()
