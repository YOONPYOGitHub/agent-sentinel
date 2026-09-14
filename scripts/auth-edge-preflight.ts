import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AzureCliCredential } from '@azure/identity'
import { z } from 'zod'

import { frontDoorMutationGuardContract } from './frontdoor-mutation-guard-contract.js'
import { parseJsonRejectingDuplicateKeys } from './strict-json.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/
const MAX_RESPONSE_BYTES = 512 * 1024

export const activeEdgePreflightInputSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0.0'),
    tenantId: z.string().regex(UUID_PATTERN),
    subscriptionId: z.string().regex(UUID_PATTERN),
    resourceGroup: z.string().regex(NAME_PATTERN),
    profileName: z.string().regex(NAME_PATTERN),
    endpointName: z.string().regex(NAME_PATTERN),
    frontDoorOrigin: z.string().url().max(256),
    stage: z.enum(['read-only', 'write-readiness']),
    reviewedMutationContractDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .superRefine((input, context) => {
    const origin = new URL(input.frontDoorOrigin)
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.port !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== '' ||
      input.frontDoorOrigin !== origin.origin
    ) {
      context.addIssue({
        code: 'custom',
        path: ['frontDoorOrigin'],
        message: 'Active edge origin must be one exact HTTPS origin.',
      })
    }
    if (input.stage === 'write-readiness' && input.reviewedMutationContractDigest === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['reviewedMutationContractDigest'],
        message: 'Write-stage readiness requires the exact reviewed Front Door contract digest.',
      })
    }
  })

export type ActiveEdgePreflightInput = z.infer<typeof activeEdgePreflightInputSchema>

const mutationRuleSchema = z.strictObject({
  name: z.string().min(1),
  priority: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  action: z.string(),
  pathOperator: z.string(),
  pathValues: z.array(z.string()),
  pathTransforms: z.array(z.string()),
  methodOperator: z.string(),
  methods: z.array(z.string()),
  authorizationBoundaryMatches: z.boolean(),
})

export const activeEdgeSnapshotSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  origin: z.strictObject({
    rootStatus: z.number().int().min(100).max(599),
    redirectStatus: z.number().int().min(100).max(599),
    authConfigStatus: z.number().int().min(100).max(599),
    authConfig: z
      .strictObject({
        enabled: z.boolean(),
        tenantId: z.string().optional(),
        redirectUri: z.string().optional(),
        postLogoutRedirectUri: z.string().optional(),
      })
      .optional(),
    apiStatusStatus: z.number().int().min(100).max(599),
    apiStatus: z
      .strictObject({
        security: z.strictObject({
          authMode: z.enum(['disabled', 'jwt', 'unknown']),
          writeEnabled: z.boolean().nullable(),
        }),
      })
      .optional(),
  }),
  frontDoor: z.strictObject({
    associatedSecurityPolicyIds: z.array(z.string().min(1)).max(20),
    associatedWafPolicyIds: z.array(z.string().min(1)).max(20),
    wafPolicyId: z.string().min(1).nullable(),
    wafPolicyContractDigest: z.string().nullable(),
    endpointEnabled: z.boolean(),
    endpointHostName: z.string().min(1),
    wafAssociated: z.boolean(),
    wafEnabled: z.boolean(),
    wafMode: z.enum(['Prevention', 'Detection', 'Unknown']),
    mutationRules: z.array(mutationRuleSchema).max(100),
  }),
})

export type ActiveEdgeSnapshot = z.infer<typeof activeEdgeSnapshotSchema>

export interface ActiveEdgeInspectionClient {
  inspect(input: ActiveEdgePreflightInput): Promise<ActiveEdgeSnapshot>
}

export interface ActiveEdgeCheck {
  readonly id: string
  readonly status: 'pass' | 'block'
  readonly message: string
}

export interface ActiveEdgePreflightReport {
  readonly schemaVersion: '1.0.0'
  readonly kind: 'agent-sentinel-active-edge-preflight'
  readonly status: 'ready' | 'blocked'
  readonly stage: 'read-only' | 'write-readiness'
  readonly safeReadOnlyPolicy:
    'front-door-mutation-rule' | 'api-writes-disabled-no-write-activation' | 'none'
  readonly writeActivationAllowed: boolean
  readonly observations: {
    readonly httpsOrigin: boolean
    readonly authRedirectAvailable: boolean
    readonly jwtActive: boolean
    readonly apiWriteEnabled: boolean | null
    readonly securityPolicyId: string | null
    readonly wafPolicyId: string | null
    readonly wafPolicyContractDigest: string | null
    readonly wafPolicyUnambiguous: boolean
    readonly mutationContractDigestMatches: boolean
    readonly frontDoorMutationRulePresent: boolean
    readonly exactMutationRuleContractPresent: boolean
    readonly apiAllowRulePresent: boolean
  }
  readonly checks: readonly ActiveEdgeCheck[]
  readonly activationOrder: readonly [
    'validate-jwt-reads-with-writes-disabled',
    'deploy-and-verify-front-door-anonymous-mutation-guard',
    'separately-approve-write-switch',
  ]
  readonly rollbackOrder: readonly [
    'restore-write-switch-false',
    'restore-approved-front-door-waf-association',
    'restore-last-known-good-container-revisions',
  ]
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((value, index) => value === sortedRight[index])
}

function mutationRuleMatches(
  rule: ActiveEdgeSnapshot['frontDoor']['mutationRules'][number],
  expected: (typeof frontDoorMutationGuardContract.rules)[number],
): boolean {
  return (
    rule.name === expected.name &&
    rule.priority === expected.priority &&
    rule.enabled &&
    rule.action === 'Block' &&
    rule.pathOperator === expected.pathOperator &&
    sameValues(rule.pathValues, expected.pathValues) &&
    sameValues(rule.pathTransforms, ['Lowercase']) &&
    rule.methodOperator === 'Equal' &&
    sameValues(
      rule.methods.map((method) => method.toUpperCase()),
      expected.methods,
    ) &&
    rule.authorizationBoundaryMatches
  )
}

function apiAllowRulePresent(rules: ActiveEdgeSnapshot['frontDoor']['mutationRules']): boolean {
  return rules.some(
    (rule) =>
      rule.enabled &&
      rule.action === 'Allow' &&
      (rule.pathValues.length === 0 ||
        rule.pathValues.some((value) => {
          const normalized = value.toLowerCase()
          return normalized.startsWith('/api') || normalized.startsWith('^/api')
        })),
  )
}

export function assessActiveEdge(
  rawInput: unknown,
  rawSnapshot: unknown,
): ActiveEdgePreflightReport {
  const input = activeEdgePreflightInputSchema.parse(rawInput)
  const snapshot = activeEdgeSnapshotSchema.parse(rawSnapshot)
  const origin = new URL(input.frontDoorOrigin)
  const httpsOrigin = origin.protocol === 'https:'
  const endpointMatches =
    snapshot.frontDoor.endpointEnabled &&
    snapshot.frontDoor.endpointHostName.toLowerCase() === origin.hostname.toLowerCase()
  const authRedirectAvailable =
    snapshot.origin.redirectStatus >= 200 && snapshot.origin.redirectStatus < 400
  const authConfig = snapshot.origin.authConfig
  const authConfigMatches =
    snapshot.origin.authConfigStatus === 200 &&
    authConfig !== undefined &&
    authConfig.tenantId?.toLowerCase() === input.tenantId.toLowerCase() &&
    authConfig.redirectUri === `${input.frontDoorOrigin}/auth-redirect.html` &&
    authConfig.postLogoutRedirectUri === `${input.frontDoorOrigin}/`
  const jwtActive = authConfigMatches && authConfig?.enabled === true
  const apiWriteEnabled = snapshot.origin.apiStatus?.security.writeEnabled ?? null
  const writesDisabled = snapshot.origin.apiStatusStatus === 200 && apiWriteEnabled === false
  const wafPolicyUnambiguous =
    snapshot.frontDoor.associatedSecurityPolicyIds.length === 1 &&
    snapshot.frontDoor.associatedWafPolicyIds.length === 1 &&
    snapshot.frontDoor.wafPolicyId === snapshot.frontDoor.associatedWafPolicyIds[0]
  const noWafAssociation =
    snapshot.frontDoor.associatedSecurityPolicyIds.length === 0 &&
    snapshot.frontDoor.associatedWafPolicyIds.length === 0 &&
    snapshot.frontDoor.wafPolicyId === null
  const wafAssociationSafe = noWafAssociation || wafPolicyUnambiguous
  const mutationContractDigestMatches =
    snapshot.frontDoor.wafPolicyContractDigest === frontDoorMutationGuardContract.contractDigest &&
    (input.reviewedMutationContractDigest === undefined ||
      input.reviewedMutationContractDigest === frontDoorMutationGuardContract.contractDigest)
  const names = snapshot.frontDoor.mutationRules.map((rule) => rule.name)
  const priorities = snapshot.frontDoor.mutationRules.map((rule) => rule.priority)
  const rulesUnambiguous =
    new Set(names).size === names.length && new Set(priorities).size === priorities.length
  const exactMutationRuleContractPresent =
    rulesUnambiguous &&
    frontDoorMutationGuardContract.rules.every(
      (expected) =>
        snapshot.frontDoor.mutationRules.filter((rule) => mutationRuleMatches(rule, expected))
          .length === 1,
    )
  const allowRulePresent = apiAllowRulePresent(snapshot.frontDoor.mutationRules)
  const frontDoorMutationRulePresent =
    wafPolicyUnambiguous &&
    snapshot.frontDoor.wafAssociated &&
    snapshot.frontDoor.wafEnabled &&
    snapshot.frontDoor.wafMode === 'Prevention' &&
    mutationContractDigestMatches &&
    exactMutationRuleContractPresent &&
    !allowRulePresent
  const commonReady =
    httpsOrigin && endpointMatches && authRedirectAvailable && authConfigMatches && writesDisabled
  const writeActivationAllowed = commonReady && jwtActive && frontDoorMutationRulePresent
  const ready =
    input.stage === 'read-only'
      ? commonReady && wafAssociationSafe && !allowRulePresent
      : commonReady && jwtActive && frontDoorMutationRulePresent
  const safeReadOnlyPolicy = frontDoorMutationRulePresent
    ? 'front-door-mutation-rule'
    : writesDisabled
      ? 'api-writes-disabled-no-write-activation'
      : 'none'

  const checks: ActiveEdgeCheck[] = [
    {
      id: 'active-https-origin',
      status: httpsOrigin && endpointMatches && snapshot.origin.rootStatus < 500 ? 'pass' : 'block',
      message: 'The inspected enabled Front Door endpoint must match the exact HTTPS origin.',
    },
    {
      id: 'auth-redirect-available',
      status: authRedirectAvailable ? 'pass' : 'block',
      message: 'The exact /auth-redirect.html route must be available through active Front Door.',
    },
    {
      id: 'auth-config-boundary',
      status: authConfigMatches ? 'pass' : 'block',
      message:
        'Public auth configuration must match the exact tenant, redirect, and logout origin.',
    },
    {
      id: 'api-writes-disabled',
      status: writesDisabled ? 'pass' : 'block',
      message: 'The active API must truthfully report writeEnabled=false.',
    },
    {
      id: 'front-door-mutation-rule',
      status: frontDoorMutationRulePresent
        ? 'pass'
        : input.stage === 'read-only' && writesDisabled
          ? 'pass'
          : 'block',
      message: frontDoorMutationRulePresent
        ? 'One associated Front Door WAF Prevention policy has the exact reviewed anonymous-mutation contract.'
        : 'The exact active Front Door mutation contract is absent or ambiguous; only write-disabled read-only activation is allowed.',
    },
    {
      id: 'front-door-policy-identity',
      status:
        input.stage === 'read-only'
          ? wafAssociationSafe
            ? 'pass'
            : 'block'
          : wafPolicyUnambiguous && mutationContractDigestMatches
            ? 'pass'
            : 'block',
      message:
        'Write readiness requires one endpoint security policy, one WAF policy, and the exact immutable contract digest.',
    },
    {
      id: 'no-api-allow-rule',
      status: allowRulePresent ? 'block' : 'pass',
      message: 'No enabled Front Door Allow rule may target the API boundary.',
    },
    {
      id: 'write-stage-jwt-and-reviewed-edge',
      status: input.stage === 'read-only' || writeActivationAllowed ? 'pass' : 'block',
      message:
        'Write-stage readiness requires active JWT configuration and the exact reviewed Front Door mutation contract.',
    },
  ]

  return {
    schemaVersion: '1.0.0',
    kind: 'agent-sentinel-active-edge-preflight',
    status: ready ? 'ready' : 'blocked',
    stage: input.stage,
    safeReadOnlyPolicy,
    writeActivationAllowed,
    observations: {
      httpsOrigin,
      authRedirectAvailable,
      jwtActive,
      apiWriteEnabled,
      securityPolicyId:
        snapshot.frontDoor.associatedSecurityPolicyIds.length === 1
          ? (snapshot.frontDoor.associatedSecurityPolicyIds[0] ?? null)
          : null,
      wafPolicyId: snapshot.frontDoor.wafPolicyId,
      wafPolicyContractDigest: snapshot.frontDoor.wafPolicyContractDigest,
      wafPolicyUnambiguous,
      mutationContractDigestMatches,
      frontDoorMutationRulePresent,
      exactMutationRuleContractPresent,
      apiAllowRulePresent: allowRulePresent,
    },
    checks,
    activationOrder: [
      'validate-jwt-reads-with-writes-disabled',
      'deploy-and-verify-front-door-anonymous-mutation-guard',
      'separately-approve-write-switch',
    ],
    rollbackOrder: [
      'restore-write-switch-false',
      'restore-approved-front-door-waf-association',
      'restore-last-known-good-container-revisions',
    ],
  }
}

export class SnapshotActiveEdgeInspectionClient implements ActiveEdgeInspectionClient {
  public constructor(private readonly snapshot: ActiveEdgeSnapshot) {}

  public inspect(): Promise<ActiveEdgeSnapshot> {
    return Promise.resolve(this.snapshot)
  }
}

function parseJsonBody(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Active edge response was too large.')
  return parseJsonRejectingDuplicateKeys(new TextDecoder().decode(bytes))
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function extractMutationRules(policy: unknown): ActiveEdgeSnapshot['frontDoor']['mutationRules'] {
  const properties = objectValue(objectValue(policy)?.['properties'])
  const customRules = objectValue(properties?.['customRules'])
  return arrayValue(customRules?.['rules']).flatMap((candidate) => {
    const rule = objectValue(candidate)
    if (rule === undefined) return []
    let pathOperator = ''
    let pathValues: string[] = []
    let pathTransforms: string[] = []
    let methodOperator = ''
    let methods: string[] = []
    let authorizationBoundaryMatches = false
    for (const rawCondition of arrayValue(rule['matchConditions'])) {
      const condition = objectValue(rawCondition)
      if (condition === undefined) continue
      const directVariable = stringValue(condition['matchVariable'])
      const variables = arrayValue(condition['matchVariables'])
      const variableNames = [
        ...(directVariable === undefined ? [] : [directVariable]),
        ...variables
          .map((entry) => stringValue(objectValue(entry)?.['variableName']))
          .filter((value): value is string => value !== undefined),
      ]
      const values =
        arrayValue(condition['matchValue']).length > 0
          ? arrayValue(condition['matchValue'])
          : arrayValue(condition['matchValues'])
      const strings = values.filter((value): value is string => typeof value === 'string')
      if (variableNames.includes('RequestUri')) {
        pathOperator = stringValue(condition['operator']) ?? pathOperator
        pathValues = strings
        pathTransforms = arrayValue(condition['transforms']).filter(
          (value): value is string => typeof value === 'string',
        )
      }
      if (variableNames.includes('RequestMethod')) {
        methodOperator = stringValue(condition['operator']) ?? methodOperator
        const negated =
          condition['negateCondition'] === true || condition['negationConditon'] === true
        methods = negated
          ? ['POST', 'PUT', 'PATCH', 'DELETE']
          : strings.map((method) => method.toUpperCase())
      }
      const conditionTransforms = arrayValue(condition['transforms']).filter(
        (value): value is string => typeof value === 'string',
      )
      if (
        variableNames.includes('RequestHeader') &&
        stringValue(condition['selector'])?.toLowerCase() === 'authorization' &&
        condition['operator'] === frontDoorMutationGuardContract.authorizationBoundary.operator &&
        condition['negateCondition'] ===
          frontDoorMutationGuardContract.authorizationBoundary.negateCondition &&
        sameValues(strings, frontDoorMutationGuardContract.authorizationBoundary.matchValues) &&
        sameValues(
          conditionTransforms,
          frontDoorMutationGuardContract.authorizationBoundary.transforms,
        )
      ) {
        authorizationBoundaryMatches = true
      }
    }
    return [
      {
        name: stringValue(rule['name']) ?? 'unnamed',
        priority:
          typeof rule['priority'] === 'number' && Number.isInteger(rule['priority'])
            ? rule['priority']
            : 1000,
        enabled: rule['enabledState'] === 'Enabled' || rule['enabled'] === true,
        action: stringValue(rule['action']) ?? 'Unknown',
        pathOperator,
        pathValues,
        pathTransforms,
        methodOperator,
        methods,
        authorizationBoundaryMatches,
      },
    ]
  })
}

export class AzureActiveEdgeInspectionClient implements ActiveEdgeInspectionClient {
  private readonly credential: AzureCliCredential

  public constructor(tenantId: string, credential = new AzureCliCredential({ tenantId })) {
    this.credential = credential
  }

  private async publicRequest(url: string): Promise<{ status: number; body?: unknown }> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_RESPONSE_BYTES)
      throw new Error('Active edge response was too large.')
    if (bytes.byteLength === 0) return { status: response.status }
    try {
      return { status: response.status, body: parseJsonBody(bytes) }
    } catch {
      return { status: response.status }
    }
  }

  private async arm(path: string): Promise<unknown> {
    const token = await this.credential.getToken('https://management.azure.com/.default')
    if (token === null) throw new Error('Azure CLI did not provide an ARM access token.')
    const response = await fetch(`https://management.azure.com${path}`, {
      headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(`ARM read failed for ${path.split('?')[0]} (${response.status}).`)
    return parseJsonBody(new Uint8Array(await response.arrayBuffer()))
  }

  public async inspect(input: ActiveEdgePreflightInput): Promise<ActiveEdgeSnapshot> {
    const base = `/subscriptions/${input.subscriptionId}/resourceGroups/${encodeURIComponent(input.resourceGroup)}/providers/Microsoft.Cdn/profiles/${encodeURIComponent(input.profileName)}`
    const [root, redirect, authConfig, apiStatus, endpoint, policies] = await Promise.all([
      this.publicRequest(`${input.frontDoorOrigin}/`),
      this.publicRequest(`${input.frontDoorOrigin}/auth-redirect.html`),
      this.publicRequest(`${input.frontDoorOrigin}/api/auth/config`),
      this.publicRequest(`${input.frontDoorOrigin}/api/status`),
      this.arm(
        `${base}/afdEndpoints/${encodeURIComponent(input.endpointName)}?api-version=2024-02-01`,
      ),
      this.arm(`${base}/securityPolicies?api-version=2024-02-01`),
    ])
    const endpointProperties = objectValue(objectValue(endpoint)?.['properties'])
    const policyItems = arrayValue(objectValue(policies)?.['value'])
    const associatedSecurityPolicyIds: string[] = []
    const associatedWafPolicyIds: string[] = []
    for (const [index, rawPolicy] of policyItems.entries()) {
      const parameters = objectValue(
        objectValue(objectValue(rawPolicy)?.['properties'])?.['parameters'],
      )
      const wafPolicy = objectValue(parameters?.['wafPolicy'])
      const associations = arrayValue(parameters?.['associations'])
      const associated = associations.some((rawAssociation) =>
        arrayValue(objectValue(rawAssociation)?.['domains']).some((rawDomain) =>
          (stringValue(objectValue(rawDomain)?.['id']) ?? '')
            .toLowerCase()
            .endsWith(`/afdendpoints/${input.endpointName.toLowerCase()}`),
        ),
      )
      if (associated) {
        associatedSecurityPolicyIds.push(
          stringValue(objectValue(rawPolicy)?.['id']) ?? `unknown-security-policy-${String(index)}`,
        )
        const associatedWafPolicyId = stringValue(wafPolicy?.['id'])
        if (associatedWafPolicyId !== undefined) {
          associatedWafPolicyIds.push(associatedWafPolicyId)
        }
      }
    }
    const uniqueSecurityPolicyIds = [...new Set(associatedSecurityPolicyIds)]
    const uniqueWafPolicyIds = [...new Set(associatedWafPolicyIds)]
    const wafPolicyId = uniqueWafPolicyIds.length === 1 ? uniqueWafPolicyIds[0] : undefined
    const waf =
      wafPolicyId === undefined
        ? undefined
        : await this.arm(`${wafPolicyId}?api-version=2024-02-01`)
    const wafProperties = objectValue(objectValue(waf)?.['properties'])
    const settings = objectValue(wafProperties?.['policySettings'])
    const wafTags = objectValue(objectValue(waf)?.['tags'])
    const authBody = objectValue(authConfig.body)
    const statusBody = objectValue(apiStatus.body)
    const security = objectValue(statusBody?.['security'])
    return activeEdgeSnapshotSchema.parse({
      schemaVersion: '1.0.0',
      origin: {
        rootStatus: root.status,
        redirectStatus: redirect.status,
        authConfigStatus: authConfig.status,
        ...(authBody === undefined
          ? {}
          : {
              authConfig: {
                enabled: authBody['enabled'] === true,
                ...(stringValue(authBody['tenantId']) === undefined
                  ? {}
                  : { tenantId: stringValue(authBody['tenantId']) }),
                ...(stringValue(authBody['redirectUri']) === undefined
                  ? {}
                  : { redirectUri: stringValue(authBody['redirectUri']) }),
                ...(stringValue(authBody['postLogoutRedirectUri']) === undefined
                  ? {}
                  : { postLogoutRedirectUri: stringValue(authBody['postLogoutRedirectUri']) }),
              },
            }),
        apiStatusStatus: apiStatus.status,
        ...(security === undefined
          ? {}
          : {
              apiStatus: {
                security: {
                  authMode:
                    security['authMode'] === 'jwt'
                      ? 'jwt'
                      : security['authMode'] === 'disabled'
                        ? 'disabled'
                        : 'unknown',
                  writeEnabled:
                    security['writeEnabled'] === true
                      ? true
                      : security['writeEnabled'] === false
                        ? false
                        : null,
                },
              },
            }),
      },
      frontDoor: {
        associatedSecurityPolicyIds: uniqueSecurityPolicyIds,
        associatedWafPolicyIds: uniqueWafPolicyIds,
        wafPolicyId: wafPolicyId ?? null,
        wafPolicyContractDigest:
          stringValue(wafTags?.['agent-sentinel-auth-mutation-contract']) ?? null,
        endpointEnabled: endpointProperties?.['enabledState'] === 'Enabled',
        endpointHostName: stringValue(endpointProperties?.['hostName']) ?? '',
        wafAssociated: uniqueSecurityPolicyIds.length > 0 && uniqueWafPolicyIds.length > 0,
        wafEnabled: settings?.['enabledState'] === 'Enabled',
        wafMode:
          settings?.['mode'] === 'Prevention' || settings?.['mode'] === 'Detection'
            ? settings['mode']
            : 'Unknown',
        mutationRules: extractMutationRules(waf),
      },
    })
  }
}

function invocationPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env['INIT_CWD'] ?? process.cwd(), path)
}

async function readJson(path: string): Promise<unknown> {
  const contents = await readFile(invocationPath(path), 'utf8')
  if (Buffer.byteLength(contents, 'utf8') > MAX_RESPONSE_BYTES)
    throw new Error('Input is too large.')
  return parseJsonRejectingDuplicateKeys(contents)
}

function parseCli(argv: readonly string[]): { input: string; snapshot?: string; output: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    const next = argv[index + 1]
    if (
      argument === undefined ||
      !argument.startsWith('--') ||
      next === undefined ||
      next.startsWith('--')
    ) {
      throw new Error('All edge preflight arguments must be named options with values.')
    }
    const name = argument.slice(2)
    if (values.has(name)) throw new Error(`Option --${name} may be supplied only once.`)
    values.set(name, next)
    index += 1
  }
  for (const name of values.keys()) {
    if (!['input', 'snapshot', 'output'].includes(name))
      throw new Error(`Unknown option --${name}.`)
  }
  const input = values.get('input')
  const output = values.get('output')
  if (input === undefined || output === undefined)
    throw new Error('--input and --output are required.')
  const snapshot = values.get('snapshot')
  return { input, output, ...(snapshot === undefined ? {} : { snapshot }) }
}

export async function runActiveEdgePreflightCli(
  argv = process.argv.slice(2),
  clientOverride?: ActiveEdgeInspectionClient,
): Promise<number> {
  try {
    const options = parseCli(argv)
    const input = activeEdgePreflightInputSchema.parse(await readJson(options.input))
    const client =
      clientOverride ??
      (options.snapshot === undefined
        ? new AzureActiveEdgeInspectionClient(input.tenantId)
        : new SnapshotActiveEdgeInspectionClient(
            activeEdgeSnapshotSchema.parse(await readJson(options.snapshot)),
          ))
    const report = assessActiveEdge(input, await client.inspect(input))
    await writeFile(invocationPath(options.output), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    })
    process.stdout.write(
      `${JSON.stringify({ status: report.status, safeReadOnlyPolicy: report.safeReadOnlyPolicy, writeActivationAllowed: report.writeActivationAllowed })}\n`,
    )
    return report.status === 'ready' ? 0 : 2
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Active edge preflight failed.'}\n`,
    )
    return 1
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) process.exitCode = await runActiveEdgePreflightCli()
