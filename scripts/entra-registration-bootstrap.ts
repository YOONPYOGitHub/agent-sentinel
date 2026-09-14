import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AzureCliCredential } from '@azure/identity'
import { z } from 'zod'

import { parseJsonRejectingDuplicateKeys } from './strict-json.js'

export const ENTRA_BOOTSTRAP_APPROVAL = 'APPROVE_ENTRA_REGISTRATION_BOOTSTRAP'
export const ENTRA_BOOTSTRAP_PROTECTED_ENVIRONMENT = 'entra-registration-bootstrap'
export const ENTRA_BOOTSTRAP_ROLES = [
  'AgentSentinel.Viewer',
  'AgentSentinel.Analyst',
  'AgentSentinel.Approver',
  'AgentSentinel.Administrator',
] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,119}$/
const DISPLAY_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,78}[A-Za-z0-9]$/
const FORBIDDEN_KEY_PATTERN =
  /(secret|password|credential|certificate|private.?key|access.?token|refresh.?token|id.?token)/i
const MAX_FILE_BYTES = 512 * 1024
const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'

const scopeSchema = z.strictObject({
  value: z.string().regex(SCOPE_PATTERN),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(256),
})

const roleSchema = z.strictObject({
  value: z.enum(ENTRA_BOOTSTRAP_ROLES),
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(256),
})

export const entraRegistrationInputSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0.0'),
    tenantId: z.string().regex(UUID_PATTERN),
    frontDoorOrigin: z.string().url().max(256),
    displayNamePrefix: z.string().trim().regex(DISPLAY_PREFIX_PATTERN),
    apiIdentifierUriPolicy: z.literal('api-app-id'),
    scopes: z.strictObject({
      read: scopeSchema,
      write: scopeSchema,
    }),
    roles: z.array(roleSchema).length(ENTRA_BOOTSTRAP_ROLES.length),
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
      origin.hostname === 'localhost' ||
      origin.hostname.endsWith('.localhost') ||
      input.frontDoorOrigin !== origin.origin
    ) {
      context.addIssue({
        code: 'custom',
        path: ['frontDoorOrigin'],
        message: 'Front Door origin must be one exact public HTTPS origin.',
      })
    }
    if (input.scopes.read.value === input.scopes.write.value) {
      context.addIssue({
        code: 'custom',
        path: ['scopes'],
        message: 'Read and write delegated scope values must be distinct.',
      })
    }
    const values = input.roles.map((role) => role.value)
    if (
      new Set(values).size !== ENTRA_BOOTSTRAP_ROLES.length ||
      ENTRA_BOOTSTRAP_ROLES.some((role) => !values.includes(role))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Roles must contain the four exact Agent Sentinel values once each.',
      })
    }
  })

export type EntraRegistrationInput = z.infer<typeof entraRegistrationInputSchema>

const oauth2PermissionScopeSchema = z.object({
  id: z.string().regex(UUID_PATTERN),
  value: z.string().regex(SCOPE_PATTERN).nullable().optional(),
  adminConsentDisplayName: z.string().optional(),
  adminConsentDescription: z.string().optional(),
  userConsentDisplayName: z.string().nullable().optional(),
  userConsentDescription: z.string().nullable().optional(),
  type: z.enum(['Admin', 'User']).optional(),
  isEnabled: z.boolean().optional(),
})

const appRoleSchema = z.object({
  id: z.string().regex(UUID_PATTERN),
  value: z.string().nullable().optional(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  allowedMemberTypes: z.array(z.enum(['User', 'Application'])).optional(),
  isEnabled: z.boolean().optional(),
})

const resourceAccessSchema = z.object({
  id: z.string().regex(UUID_PATTERN),
  type: z.enum(['Scope', 'Role']),
})

const requiredResourceAccessSchema = z.object({
  resourceAppId: z.string().regex(UUID_PATTERN),
  resourceAccess: z.array(resourceAccessSchema),
})

export const graphApplicationSchema = z.object({
  id: z.string().min(1).max(256),
  appId: z.string().regex(UUID_PATTERN),
  displayName: z.string().min(1).max(256),
  signInAudience: z.string().optional(),
  identifierUris: z.array(z.string()).optional(),
  api: z
    .object({
      requestedAccessTokenVersion: z.number().int().nullable().optional(),
      oauth2PermissionScopes: z.array(oauth2PermissionScopeSchema).optional(),
    })
    .optional(),
  appRoles: z.array(appRoleSchema).optional(),
  spa: z.object({ redirectUris: z.array(z.string()).optional() }).optional(),
  web: z.object({ logoutUrl: z.string().nullable().optional() }).optional(),
  requiredResourceAccess: z.array(requiredResourceAccessSchema).optional(),
})

export type GraphApplication = z.infer<typeof graphApplicationSchema>

export const graphServicePrincipalSchema = z.object({
  id: z.string().min(1).max(256),
  appId: z.string().regex(UUID_PATTERN),
  displayName: z.string().min(1).max(256).optional(),
})

export type GraphServicePrincipal = z.infer<typeof graphServicePrincipalSchema>

export const entraRegistrationStateSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  tenantId: z.string().regex(UUID_PATTERN),
  applications: z.array(graphApplicationSchema).max(100),
  servicePrincipals: z.array(graphServicePrincipalSchema).max(100),
})

export type EntraRegistrationState = z.infer<typeof entraRegistrationStateSchema>

export interface GraphApplicationCreateResult {
  readonly id: string
  readonly appId: string
}

export interface GraphServicePrincipalCreateResult {
  readonly id: string
  readonly appId: string
}

export const graphCreateResultSchema = z.object({
  id: z.string().min(1),
  appId: z.string().regex(UUID_PATTERN),
})

export interface EntraGraphClient {
  getTenantId(): Promise<string>
  listApplicationsByDisplayName(displayName: string): Promise<readonly GraphApplication[]>
  listServicePrincipalsByAppId(appId: string): Promise<readonly GraphServicePrincipal[]>
  createApplication(body: Readonly<Record<string, unknown>>): Promise<GraphApplicationCreateResult>
  updateApplication(id: string, body: Readonly<Record<string, unknown>>): Promise<void>
  createServicePrincipal(
    body: Readonly<Record<string, unknown>>,
  ): Promise<GraphServicePrincipalCreateResult>
  deleteApplication(id: string): Promise<void>
  deleteServicePrincipal(id: string): Promise<void>
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deterministicUuid(...parts: readonly string[]): string {
  const bytes = createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isForbiddenKey(key: string): boolean {
  return key !== 'requestedAccessTokenVersion' && FORBIDDEN_KEY_PATTERN.test(key)
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey)
  if (typeof value !== 'object' || value === null) return false
  return Object.entries(value).some(
    ([key, child]) => isForbiddenKey(key) || containsForbiddenKey(child),
  )
}

function assertSanitized(value: unknown): void {
  if (containsForbiddenKey(value)) {
    throw new Error(
      'Secret, token, credential, certificate, password, and private-key fields are forbidden.',
    )
  }
}

function normalizedInput(input: EntraRegistrationInput): EntraRegistrationInput {
  return {
    ...input,
    tenantId: input.tenantId.toLowerCase(),
    frontDoorOrigin: new URL(input.frontDoorOrigin).origin,
    displayNamePrefix: input.displayNamePrefix.trim(),
    scopes: {
      read: { ...input.scopes.read, value: input.scopes.read.value.trim() },
      write: { ...input.scopes.write, value: input.scopes.write.value.trim() },
    },
    roles: [...input.roles].sort((left, right) => left.value.localeCompare(right.value)),
  }
}

function desiredScope(
  input: EntraRegistrationInput,
  scope: EntraRegistrationInput['scopes']['read'],
  existingId?: string,
): Record<string, unknown> {
  return {
    id:
      existingId ??
      deterministicUuid(input.tenantId, input.displayNamePrefix, 'delegated-scope', scope.value),
    value: scope.value,
    adminConsentDisplayName: scope.displayName,
    adminConsentDescription: scope.description,
    userConsentDisplayName: scope.displayName,
    userConsentDescription: scope.description,
    type: 'User',
    isEnabled: true,
  }
}

function desiredRole(
  input: EntraRegistrationInput,
  role: EntraRegistrationInput['roles'][number],
  existingId?: string,
): Record<string, unknown> {
  return {
    id:
      existingId ??
      deterministicUuid(input.tenantId, input.displayNamePrefix, 'application-role', role.value),
    value: role.value,
    displayName: role.displayName,
    description: role.description,
    allowedMemberTypes: ['User'],
    isEnabled: true,
  }
}

function exactCandidate<T>(items: readonly T[], description: string): T | undefined {
  if (items.length > 1) {
    throw new Error(
      `Ambiguous ${description}: ${String(items.length)} exact-name candidates found.`,
    )
  }
  return items[0]
}

function byUniqueValue<
  T extends { readonly id: string; readonly value?: string | null | undefined },
>(items: readonly T[], description: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    if (item.value === undefined || item.value === null) {
      throw new Error(`${description} contains an entry without a value.`)
    }
    if (result.has(item.value)) throw new Error(`${description} contains duplicate ${item.value}.`)
    result.set(item.value, item)
  }
  return result
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export interface GraphRequestShape {
  readonly method: 'POST' | 'PATCH'
  readonly path: string
  readonly body: Readonly<Record<string, unknown>>
}

export interface EntraRegistrationOperation {
  readonly id: string
  readonly action: 'create' | 'update'
  readonly resource: 'application' | 'servicePrincipal'
  readonly target: 'api' | 'spa'
  readonly dependsOn: readonly string[]
  readonly request: GraphRequestShape
}

export interface EntraRegistrationRollbackOperation {
  readonly id: string
  readonly action: 'delete'
  readonly resource: 'application' | 'servicePrincipal'
  readonly createdByOperationId: string
  readonly request: {
    readonly method: 'DELETE'
    readonly path: string
  }
}

export interface EntraRegistrationPlan {
  readonly schemaVersion: '1.0.0'
  readonly kind: 'agent-sentinel-entra-registration-bootstrap-plan'
  readonly mode: 'plan'
  readonly status: 'ready'
  readonly tenantId: string
  readonly frontDoorOrigin: string
  readonly displayNames: {
    readonly api: string
    readonly spa: string
  }
  readonly apiIdentifierUriPolicy: 'api-app-id'
  readonly redirectUris: {
    readonly spa: string
    readonly logout: string
  }
  readonly operations: readonly EntraRegistrationOperation[]
  readonly rollbackPlan: {
    readonly scope: 'resources-created-by-this-plan-only'
    readonly operations: readonly EntraRegistrationRollbackOperation[]
    readonly updatesRequireManualReview: true
  }
  readonly invariants: readonly string[]
  readonly planDigest: string
}

export const entraRegistrationPlanSchema = z.strictObject({
  schemaVersion: z.literal('1.0.0'),
  kind: z.literal('agent-sentinel-entra-registration-bootstrap-plan'),
  mode: z.literal('plan'),
  status: z.literal('ready'),
  tenantId: z.string().regex(UUID_PATTERN),
  frontDoorOrigin: z.string().url(),
  displayNames: z.strictObject({ api: z.string(), spa: z.string() }),
  apiIdentifierUriPolicy: z.literal('api-app-id'),
  redirectUris: z.strictObject({ spa: z.string().url(), logout: z.string().url() }),
  operations: z
    .array(
      z.strictObject({
        id: z.string(),
        action: z.enum(['create', 'update']),
        resource: z.enum(['application', 'servicePrincipal']),
        target: z.enum(['api', 'spa']),
        dependsOn: z.array(z.string()),
        request: z.strictObject({
          method: z.enum(['POST', 'PATCH']),
          path: z.string(),
          body: z.record(z.string(), z.unknown()),
        }),
      }),
    )
    .max(8),
  rollbackPlan: z.strictObject({
    scope: z.literal('resources-created-by-this-plan-only'),
    operations: z.array(
      z.strictObject({
        id: z.string(),
        action: z.literal('delete'),
        resource: z.enum(['application', 'servicePrincipal']),
        createdByOperationId: z.string(),
        request: z.strictObject({ method: z.literal('DELETE'), path: z.string() }),
      }),
    ),
    updatesRequireManualReview: z.literal(true),
  }),
  invariants: z.array(z.string()).min(4),
  planDigest: z.string().regex(/^[0-9a-f]{64}$/),
})

interface DesiredApi {
  readonly appIdReference: string
  readonly objectIdReference: string
  readonly body: Readonly<Record<string, unknown>>
  readonly readScopeId: string
}

function validateApiCandidate(
  candidate: GraphApplication | undefined,
  input: EntraRegistrationInput,
): void {
  if (candidate === undefined) return
  if (candidate.signInAudience !== undefined && candidate.signInAudience !== 'AzureADMyOrg') {
    throw new Error('Existing API registration is not single-tenant.')
  }
  const expectedIdentifier = `api://${candidate.appId.toLowerCase()}`
  const identifiers = candidate.identifierUris ?? []
  if (identifiers.length > 0 && !equalJson(identifiers, [expectedIdentifier])) {
    throw new Error('Existing API registration has a historical or unexpected identifier URI.')
  }
  const scopes = byUniqueValue(candidate.api?.oauth2PermissionScopes ?? [], 'Existing API scopes')
  const allowedScopes = new Set([input.scopes.read.value, input.scopes.write.value])
  for (const value of scopes.keys()) {
    if (!allowedScopes.has(value)) {
      throw new Error(`Existing API registration has an unexpected delegated scope: ${value}.`)
    }
  }
  const roles = byUniqueValue(candidate.appRoles ?? [], 'Existing API roles')
  const allowedRoles = new Set<string>(ENTRA_BOOTSTRAP_ROLES)
  for (const value of roles.keys()) {
    if (!allowedRoles.has(value)) {
      throw new Error(`Existing API registration has an unexpected app role: ${value}.`)
    }
  }
}

function desiredApi(
  input: EntraRegistrationInput,
  candidate: GraphApplication | undefined,
): DesiredApi {
  const existingScopes = byUniqueValue(
    candidate?.api?.oauth2PermissionScopes ?? [],
    'Existing API scopes',
  )
  const existingRoles = byUniqueValue(candidate?.appRoles ?? [], 'Existing API roles')
  const readScope = desiredScope(
    input,
    input.scopes.read,
    existingScopes.get(input.scopes.read.value)?.id,
  )
  const writeScope = desiredScope(
    input,
    input.scopes.write,
    existingScopes.get(input.scopes.write.value)?.id,
  )
  const appIdReference = candidate?.appId.toLowerCase() ?? '{{api.appId}}'
  const objectIdReference = candidate?.id ?? '{{api.objectId}}'
  return {
    appIdReference,
    objectIdReference,
    readScopeId: String(readScope['id']),
    body: {
      signInAudience: 'AzureADMyOrg',
      identifierUris: [`api://${appIdReference}`],
      api: {
        requestedAccessTokenVersion: 2,
        oauth2PermissionScopes: [readScope, writeScope],
      },
      appRoles: input.roles.map((role) =>
        desiredRole(input, role, existingRoles.get(role.value)?.id),
      ),
    },
  }
}

function validateSpaCandidate(
  candidate: GraphApplication | undefined,
  input: EntraRegistrationInput,
  apiAppId: string,
  readScopeId: string,
): void {
  if (candidate === undefined) return
  if (candidate.signInAudience !== undefined && candidate.signInAudience !== 'AzureADMyOrg') {
    throw new Error('Existing SPA registration is not single-tenant.')
  }
  const redirect = `${input.frontDoorOrigin}/auth-redirect.html`
  const redirects = candidate.spa?.redirectUris ?? []
  if (redirects.length > 0 && !equalJson(redirects, [redirect])) {
    throw new Error('Existing SPA registration contains a historical or wrong-origin redirect URI.')
  }
  const logout = `${input.frontDoorOrigin}/`
  if (
    candidate.web?.logoutUrl !== undefined &&
    candidate.web.logoutUrl !== null &&
    candidate.web.logoutUrl !== logout
  ) {
    throw new Error('Existing SPA registration contains a historical or wrong-origin logout URL.')
  }
  for (const resource of candidate.requiredResourceAccess ?? []) {
    if (resource.resourceAppId.toLowerCase() !== apiAppId.toLowerCase()) {
      throw new Error('Existing SPA registration has unexpected required-resource access.')
    }
    if (
      resource.resourceAccess.some(
        (access) =>
          access.type !== 'Scope' || access.id.toLowerCase() !== readScopeId.toLowerCase(),
      )
    ) {
      throw new Error('Existing SPA registration requests access beyond the delegated Read scope.')
    }
  }
}

function desiredSpa(
  input: EntraRegistrationInput,
  apiAppIdReference: string,
  readScopeId: string,
): Readonly<Record<string, unknown>> {
  return {
    signInAudience: 'AzureADMyOrg',
    spa: { redirectUris: [`${input.frontDoorOrigin}/auth-redirect.html`] },
    web: { logoutUrl: `${input.frontDoorOrigin}/` },
    requiredResourceAccess: [
      {
        resourceAppId: apiAppIdReference,
        resourceAccess: [{ id: readScopeId, type: 'Scope' }],
      },
    ],
  }
}

function createOperation(
  operation: Omit<EntraRegistrationOperation, 'action'>,
): EntraRegistrationOperation {
  return { ...operation, action: 'create' }
}

function updateOperation(
  operation: Omit<EntraRegistrationOperation, 'action'>,
): EntraRegistrationOperation {
  return { ...operation, action: 'update' }
}

function rollbackFor(
  operations: readonly EntraRegistrationOperation[],
): EntraRegistrationRollbackOperation[] {
  return [...operations]
    .reverse()
    .filter((operation) => operation.action === 'create')
    .map((operation) => ({
      id: `rollback.${operation.id}`,
      action: 'delete' as const,
      resource: operation.resource,
      createdByOperationId: operation.id,
      request: {
        method: 'DELETE' as const,
        path: `/${operation.resource === 'application' ? 'applications' : 'servicePrincipals'}/{{operation.${operation.id}.objectId}}`,
      },
    }))
}

export async function buildEntraRegistrationPlan(
  rawInput: unknown,
  graph: EntraGraphClient,
): Promise<EntraRegistrationPlan> {
  assertSanitized(rawInput)
  const input = normalizedInput(entraRegistrationInputSchema.parse(rawInput))
  const actualTenant = (await graph.getTenantId()).toLowerCase()
  if (actualTenant !== input.tenantId) {
    throw new Error('Graph context tenant does not match the exact requested tenant.')
  }

  const apiName = `${input.displayNamePrefix} API`
  const spaName = `${input.displayNamePrefix} SPA`
  const [apiCandidates, spaCandidates] = await Promise.all([
    graph.listApplicationsByDisplayName(apiName),
    graph.listApplicationsByDisplayName(spaName),
  ])
  const api = exactCandidate(apiCandidates, 'API application')
  const spa = exactCandidate(spaCandidates, 'SPA application')
  validateApiCandidate(api, input)
  const apiDesired = desiredApi(input, api)
  validateSpaCandidate(spa, input, apiDesired.appIdReference, apiDesired.readScopeId)
  const spaDesired = desiredSpa(input, apiDesired.appIdReference, apiDesired.readScopeId)

  const operations: EntraRegistrationOperation[] = []
  if (api === undefined) {
    operations.push(
      createOperation({
        id: 'api.application.create',
        resource: 'application',
        target: 'api',
        dependsOn: [],
        request: {
          method: 'POST',
          path: '/applications',
          body: {
            displayName: apiName,
            signInAudience: 'AzureADMyOrg',
            api: apiDesired.body['api'],
            appRoles: apiDesired.body['appRoles'],
          },
        },
      }),
    )
  }
  const currentApiBody =
    api === undefined
      ? undefined
      : {
          signInAudience: api.signInAudience ?? 'AzureADMyOrg',
          identifierUris: api.identifierUris ?? [],
          api: {
            requestedAccessTokenVersion: api.api?.requestedAccessTokenVersion ?? null,
            oauth2PermissionScopes: api.api?.oauth2PermissionScopes ?? [],
          },
          appRoles: api.appRoles ?? [],
        }
  if (api === undefined || !equalJson(currentApiBody, apiDesired.body)) {
    operations.push(
      updateOperation({
        id: 'api.application.configure',
        resource: 'application',
        target: 'api',
        dependsOn: api === undefined ? ['api.application.create'] : [],
        request: {
          method: 'PATCH',
          path: `/applications/${apiDesired.objectIdReference}`,
          body: apiDesired.body,
        },
      }),
    )
  }

  const apiServicePrincipals =
    api === undefined ? [] : await graph.listServicePrincipalsByAppId(api.appId)
  const apiServicePrincipal = exactCandidate(apiServicePrincipals, 'API service principal')
  if (apiServicePrincipal === undefined) {
    operations.push(
      createOperation({
        id: 'api.servicePrincipal.create',
        resource: 'servicePrincipal',
        target: 'api',
        dependsOn: [
          api === undefined ? 'api.application.create' : 'api.application.configure',
        ].filter((dependency) => operations.some((operation) => operation.id === dependency)),
        request: {
          method: 'POST',
          path: '/servicePrincipals',
          body: { appId: apiDesired.appIdReference },
        },
      }),
    )
  }

  if (spa === undefined) {
    operations.push(
      createOperation({
        id: 'spa.application.create',
        resource: 'application',
        target: 'spa',
        dependsOn: operations
          .filter((operation) => operation.target === 'api')
          .map((operation) => operation.id),
        request: {
          method: 'POST',
          path: '/applications',
          body: { displayName: spaName, ...spaDesired },
        },
      }),
    )
  } else {
    const currentSpaBody = {
      signInAudience: spa.signInAudience ?? 'AzureADMyOrg',
      spa: { redirectUris: spa.spa?.redirectUris ?? [] },
      web: { logoutUrl: spa.web?.logoutUrl ?? null },
      requiredResourceAccess: spa.requiredResourceAccess ?? [],
    }
    if (!equalJson(currentSpaBody, spaDesired)) {
      operations.push(
        updateOperation({
          id: 'spa.application.configure',
          resource: 'application',
          target: 'spa',
          dependsOn: operations
            .filter((operation) => operation.target === 'api')
            .map((operation) => operation.id),
          request: {
            method: 'PATCH',
            path: `/applications/${spa.id}`,
            body: spaDesired,
          },
        }),
      )
    }
  }

  const spaServicePrincipals =
    spa === undefined ? [] : await graph.listServicePrincipalsByAppId(spa.appId)
  const spaServicePrincipal = exactCandidate(spaServicePrincipals, 'SPA service principal')
  if (spaServicePrincipal === undefined) {
    operations.push(
      createOperation({
        id: 'spa.servicePrincipal.create',
        resource: 'servicePrincipal',
        target: 'spa',
        dependsOn: [
          spa === undefined
            ? 'spa.application.create'
            : operations.some((operation) => operation.id === 'spa.application.configure')
              ? 'spa.application.configure'
              : '',
        ].filter((value) => value !== ''),
        request: {
          method: 'POST',
          path: '/servicePrincipals',
          body: { appId: spa?.appId.toLowerCase() ?? '{{spa.appId}}' },
        },
      }),
    )
  }

  const planWithoutDigest = {
    schemaVersion: '1.0.0' as const,
    kind: 'agent-sentinel-entra-registration-bootstrap-plan' as const,
    mode: 'plan' as const,
    status: 'ready' as const,
    tenantId: input.tenantId,
    frontDoorOrigin: input.frontDoorOrigin,
    displayNames: { api: apiName, spa: spaName },
    apiIdentifierUriPolicy: input.apiIdentifierUriPolicy,
    redirectUris: {
      spa: `${input.frontDoorOrigin}/auth-redirect.html`,
      logout: `${input.frontDoorOrigin}/`,
    },
    operations,
    rollbackPlan: {
      scope: 'resources-created-by-this-plan-only' as const,
      operations: rollbackFor(operations),
      updatesRequireManualReview: true as const,
    },
    invariants: [
      'No client secret, certificate, credential, token, consent grant, group, or app-role assignment is created.',
      'Only exact display-name candidates are considered; ambiguous or historical registrations fail closed.',
      'The SPA requests only the delegated Read scope.',
      'Rollback deletes only directory objects created by operation IDs in this plan.',
    ],
  }
  const plan: EntraRegistrationPlan = {
    ...planWithoutDigest,
    planDigest: createHash('sha256').update(canonicalJson(planWithoutDigest)).digest('hex'),
  }
  assertSanitized(plan)
  return plan
}

export class SnapshotEntraGraphClient implements EntraGraphClient {
  public constructor(private readonly state: EntraRegistrationState) {}

  public getTenantId(): Promise<string> {
    return Promise.resolve(this.state.tenantId)
  }

  public listApplicationsByDisplayName(displayName: string): Promise<readonly GraphApplication[]> {
    return Promise.resolve(
      this.state.applications.filter((application) => application.displayName === displayName),
    )
  }

  public listServicePrincipalsByAppId(appId: string): Promise<readonly GraphServicePrincipal[]> {
    return Promise.resolve(
      this.state.servicePrincipals.filter(
        (principal) => principal.appId.toLowerCase() === appId.toLowerCase(),
      ),
    )
  }

  public createApplication(): Promise<GraphApplicationCreateResult> {
    return Promise.reject(new Error('Snapshot Graph client is read-only.'))
  }

  public updateApplication(): Promise<void> {
    return Promise.reject(new Error('Snapshot Graph client is read-only.'))
  }

  public createServicePrincipal(): Promise<GraphServicePrincipalCreateResult> {
    return Promise.reject(new Error('Snapshot Graph client is read-only.'))
  }

  public deleteApplication(): Promise<void> {
    return Promise.reject(new Error('Snapshot Graph client is read-only.'))
  }

  public deleteServicePrincipal(): Promise<void> {
    return Promise.reject(new Error('Snapshot Graph client is read-only.'))
  }
}

interface GraphCollection<T> {
  readonly value: readonly T[]
  readonly '@odata.nextLink'?: string
}

export class MicrosoftEntraGraphClient implements EntraGraphClient {
  private readonly credential: AzureCliCredential

  public constructor(tenantId: string, credential = new AzureCliCredential({ tenantId })) {
    this.credential = credential
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const token = await this.credential.getToken('https://graph.microsoft.com/.default')
    if (token === null) throw new Error('Azure CLI did not provide a Microsoft Graph access token.')
    const response = await fetch(path.startsWith('https://') ? path : `${GRAPH_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      throw new Error(
        `Microsoft Graph ${method} ${path.split('?')[0]} failed (${response.status}).`,
      )
    }
    if (response.status === 204) return undefined
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_FILE_BYTES)
      throw new Error('Microsoft Graph response was too large.')
    return parseJsonRejectingDuplicateKeys(new TextDecoder().decode(bytes))
  }

  private async collection<T>(path: string, schema: z.ZodType<T>): Promise<readonly T[]> {
    const results: T[] = []
    let next: string | undefined = path
    for (let page = 0; next !== undefined && page < 5; page += 1) {
      const raw = await this.request('GET', next)
      const collection = z
        .object({
          value: z.array(schema),
          '@odata.nextLink': z.string().url().optional(),
          '@odata.context': z.string().optional(),
          '@odata.count': z.number().optional(),
        })
        .parse(raw) as GraphCollection<T>
      results.push(...collection.value)
      if (results.length > 100) throw new Error('Microsoft Graph discovery exceeded 100 objects.')
      next = collection['@odata.nextLink']
    }
    if (next !== undefined) throw new Error('Microsoft Graph discovery exceeded five pages.')
    return results
  }

  public async getTenantId(): Promise<string> {
    const organizations = await this.collection(
      '/organization?$select=id&$top=2',
      z.strictObject({ id: z.string().regex(UUID_PATTERN) }),
    )
    if (organizations.length !== 1) throw new Error('Graph tenant discovery was not singular.')
    return organizations[0]?.id ?? ''
  }

  public async listApplicationsByDisplayName(
    displayName: string,
  ): Promise<readonly GraphApplication[]> {
    const escaped = displayName.replaceAll("'", "''")
    return this.collection(
      `/applications?$filter=displayName%20eq%20'${encodeURIComponent(escaped)}'&$select=id,appId,displayName,signInAudience,identifierUris,api,appRoles,spa,web,requiredResourceAccess&$top=20`,
      graphApplicationSchema,
    )
  }

  public async listServicePrincipalsByAppId(
    appId: string,
  ): Promise<readonly GraphServicePrincipal[]> {
    return this.collection(
      `/servicePrincipals?$filter=appId%20eq%20'${appId}'&$select=id,appId,displayName&$top=20`,
      graphServicePrincipalSchema,
    )
  }

  public async createApplication(
    body: Readonly<Record<string, unknown>>,
  ): Promise<GraphApplicationCreateResult> {
    return graphCreateResultSchema.parse(await this.request('POST', '/applications', body))
  }

  public async updateApplication(
    id: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.request('PATCH', `/applications/${encodeURIComponent(id)}`, body)
  }

  public async createServicePrincipal(
    body: Readonly<Record<string, unknown>>,
  ): Promise<GraphServicePrincipalCreateResult> {
    return graphCreateResultSchema.parse(await this.request('POST', '/servicePrincipals', body))
  }

  public async deleteApplication(id: string): Promise<void> {
    await this.request('DELETE', `/applications/${encodeURIComponent(id)}`)
  }

  public async deleteServicePrincipal(id: string): Promise<void> {
    await this.request('DELETE', `/servicePrincipals/${encodeURIComponent(id)}`)
  }
}

interface ApplyReference {
  readonly objectId: string
  readonly appId?: string
}

function resolveReferences(value: unknown, references: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
      const replacement = references[key]
      if (replacement === undefined) throw new Error(`Unresolved operation reference: ${key}.`)
      return replacement
    })
  }
  if (Array.isArray(value)) return value.map((child) => resolveReferences(child, references))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveReferences(child, references)]),
    )
  }
  return value
}

export interface EntraRegistrationApplyResult {
  readonly schemaVersion: '1.0.0'
  readonly kind: 'agent-sentinel-entra-registration-bootstrap-result'
  readonly status: 'applied'
  readonly tenantId: string
  readonly approvedPlanDigest: string
  readonly appliedOperationIds: readonly string[]
  readonly createdOperationIds: readonly string[]
  readonly postApply: {
    readonly rediscovered: true
    readonly remainingOperationCount: 0
  }
}

export async function applyEntraRegistrationPlan(
  input: EntraRegistrationInput,
  approvedPlan: EntraRegistrationPlan,
  graph: EntraGraphClient,
): Promise<EntraRegistrationApplyResult> {
  const currentPlan = await buildEntraRegistrationPlan(input, graph)
  if (!equalJson(currentPlan, approvedPlan)) {
    throw new Error('Approved plan no longer matches current Graph discovery; generate a new plan.')
  }

  const references: Record<string, string> = {}
  const created = new Map<string, ApplyReference>()
  const applied: string[] = []
  try {
    for (const operation of approvedPlan.operations) {
      const body = resolveReferences(operation.request.body, references)
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new Error(`Operation ${operation.id} has an invalid request body.`)
      }
      if (operation.resource === 'application' && operation.action === 'create') {
        const result = await graph.createApplication(body as Readonly<Record<string, unknown>>)
        const reference = { objectId: result.id, appId: result.appId.toLowerCase() }
        created.set(operation.id, reference)
        references[`${operation.target}.objectId`] = reference.objectId
        references[`${operation.target}.appId`] = reference.appId
        references[`operation.${operation.id}.objectId`] = reference.objectId
      } else if (operation.resource === 'application' && operation.action === 'update') {
        const path = resolveReferences(operation.request.path, references)
        if (typeof path !== 'string' || !path.startsWith('/applications/')) {
          throw new Error(`Operation ${operation.id} has an invalid application path.`)
        }
        await graph.updateApplication(
          decodeURIComponent(path.slice('/applications/'.length)),
          body as Readonly<Record<string, unknown>>,
        )
      } else if (operation.resource === 'servicePrincipal' && operation.action === 'create') {
        const result = await graph.createServicePrincipal(body as Readonly<Record<string, unknown>>)
        const reference = { objectId: result.id, appId: result.appId.toLowerCase() }
        created.set(operation.id, reference)
        references[`operation.${operation.id}.objectId`] = reference.objectId
      } else {
        throw new Error(`Unsupported operation ${operation.id}.`)
      }
      applied.push(operation.id)
    }

    const postApply = await buildEntraRegistrationPlan(input, graph)
    if (postApply.operations.length !== 0) {
      throw new Error(
        `Post-apply rediscovery found remaining registration operations: ${postApply.operations
          .map((operation) => operation.id)
          .join(', ')}.`,
      )
    }
    return {
      schemaVersion: '1.0.0',
      kind: 'agent-sentinel-entra-registration-bootstrap-result',
      status: 'applied',
      tenantId: input.tenantId.toLowerCase(),
      approvedPlanDigest: approvedPlan.planDigest,
      appliedOperationIds: applied,
      createdOperationIds: [...created.keys()],
      postApply: { rediscovered: true, remainingOperationCount: 0 },
    }
  } catch (error: unknown) {
    for (const rollback of approvedPlan.rollbackPlan.operations) {
      const reference = created.get(rollback.createdByOperationId)
      if (reference === undefined) continue
      try {
        if (rollback.resource === 'application') await graph.deleteApplication(reference.objectId)
        else await graph.deleteServicePrincipal(reference.objectId)
      } catch {
        throw new Error(
          `${error instanceof Error ? error.message : 'Registration apply failed.'} Rollback of created operation ${rollback.createdByOperationId} also failed.`,
        )
      }
    }
    throw error
  }
}

interface CliOptions {
  readonly input?: string
  readonly state?: string
  readonly output: string
  readonly approvedPlan?: string
  readonly apply: boolean
  readonly approval?: string
  readonly confirmTenant?: string
  readonly values: Map<string, string[]>
}

function one(values: Map<string, string[]>, name: string): string | undefined {
  const candidates = values.get(name)
  if (candidates === undefined) return undefined
  if (candidates.length !== 1) throw new Error(`Option --${name} may be supplied only once.`)
  return candidates[0]
}

function required(values: Map<string, string[]>, name: string): string {
  const value = one(values, name)
  if (value === undefined || value.trim() === '') throw new Error(`Missing --${name}.`)
  return value
}

function parseCli(argv: readonly string[]): CliOptions {
  const values = new Map<string, string[]>()
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') continue
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === undefined || !argument.startsWith('--')) {
      throw new Error('All arguments must use named --options.')
    }
    const name = argument.slice(2)
    if (isForbiddenKey(name)) throw new Error(`Forbidden option --${name}.`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Option --${name} requires a value.`)
    }
    index += 1
    values.set(name, [...(values.get(name) ?? []), next])
  }
  const known = new Set([
    'input',
    'state',
    'output',
    'approved-plan',
    'approval',
    'confirm-tenant',
    'tenant',
    'front-door-origin',
    'display-name-prefix',
    'api-identifier-uri-policy',
    'read-scope',
    'write-scope',
    'role',
  ])
  const unknown = [...values.keys()].filter((name) => !known.has(name))
  if (unknown.length > 0) throw new Error(`Unknown option --${unknown[0]}.`)
  const input = one(values, 'input')
  const state = one(values, 'state')
  const approvedPlan = one(values, 'approved-plan')
  const approval = one(values, 'approval')
  const confirmTenant = one(values, 'confirm-tenant')
  if (
    input !== undefined &&
    [...values.keys()].some((name) =>
      [
        'tenant',
        'front-door-origin',
        'display-name-prefix',
        'api-identifier-uri-policy',
        'read-scope',
        'write-scope',
        'role',
      ].includes(name),
    )
  ) {
    throw new Error('--input cannot be combined with registration data options.')
  }
  if (apply && state !== undefined)
    throw new Error('--state is plan-only and cannot be used for apply.')
  return {
    ...(input === undefined ? {} : { input }),
    ...(state === undefined ? {} : { state }),
    output: required(values, 'output'),
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
    apply,
    ...(approval === undefined ? {} : { approval }),
    ...(confirmTenant === undefined ? {} : { confirmTenant }),
    values,
  }
}

function cliInput(values: Map<string, string[]>): EntraRegistrationInput {
  const roleValues = values.get('role') ?? []
  const roleName = (value: (typeof ENTRA_BOOTSTRAP_ROLES)[number]): string =>
    value.slice('AgentSentinel.'.length)
  return entraRegistrationInputSchema.parse({
    schemaVersion: '1.0.0',
    tenantId: required(values, 'tenant'),
    frontDoorOrigin: required(values, 'front-door-origin'),
    displayNamePrefix: required(values, 'display-name-prefix'),
    apiIdentifierUriPolicy: required(values, 'api-identifier-uri-policy'),
    scopes: {
      read: {
        value: required(values, 'read-scope'),
        displayName: 'Read Agent Sentinel',
        description: 'Read Agent Sentinel inventory, evidence, posture, and connector state.',
      },
      write: {
        value: required(values, 'write-scope'),
        displayName: 'Write Agent Sentinel',
        description: 'Perform approved Agent Sentinel mutations within assigned app roles.',
      },
    },
    roles: roleValues.map((value) => ({
      value,
      displayName: roleName(value as (typeof ENTRA_BOOTSTRAP_ROLES)[number]),
      description: `${roleName(value as (typeof ENTRA_BOOTSTRAP_ROLES)[number])} access to Agent Sentinel.`,
    })),
  })
}

function invocationPath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env['INIT_CWD'] ?? process.cwd(), path)
}

async function readBoundedJson(path: string): Promise<unknown> {
  const contents = await readFile(invocationPath(path), 'utf8')
  if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) {
    throw new Error(`JSON input must not exceed ${String(MAX_FILE_BYTES)} bytes.`)
  }
  const parsed = parseJsonRejectingDuplicateKeys(contents)
  assertSanitized(parsed)
  return parsed
}

export async function runEntraRegistrationBootstrapCli(
  argv = process.argv.slice(2),
  graphOverride?: EntraGraphClient,
): Promise<number> {
  try {
    const options = parseCli(argv)
    const input = normalizedInput(
      options.input === undefined
        ? cliInput(options.values)
        : entraRegistrationInputSchema.parse(await readBoundedJson(options.input)),
    )
    if (options.apply) {
      if (options.approval !== ENTRA_BOOTSTRAP_APPROVAL) {
        throw new Error(`Apply requires --approval ${ENTRA_BOOTSTRAP_APPROVAL}.`)
      }
      if (options.confirmTenant?.toLowerCase() !== input.tenantId) {
        throw new Error('Apply requires --confirm-tenant to exactly match the requested tenant.')
      }
      if (
        process.env['AGENT_SENTINEL_PROTECTED_ENVIRONMENT'] !==
        ENTRA_BOOTSTRAP_PROTECTED_ENVIRONMENT
      ) {
        throw new Error(
          `Apply requires AGENT_SENTINEL_PROTECTED_ENVIRONMENT=${ENTRA_BOOTSTRAP_PROTECTED_ENVIRONMENT}.`,
        )
      }
      if (options.approvedPlan === undefined) {
        throw new Error('Apply requires --approved-plan from the protected plan artifact.')
      }
    }

    let graph = graphOverride
    if (graph === undefined && options.state !== undefined) {
      graph = new SnapshotEntraGraphClient(
        entraRegistrationStateSchema.parse(await readBoundedJson(options.state)),
      )
    }
    graph ??= new MicrosoftEntraGraphClient(input.tenantId)

    if (!options.apply) {
      const plan = await buildEntraRegistrationPlan(input, graph)
      const output = `${JSON.stringify(plan, null, 2)}\n`
      await writeFile(invocationPath(options.output), output, { mode: 0o600 })
      process.stdout.write(
        `${JSON.stringify({ mode: 'plan', status: 'ready', planDigest: plan.planDigest, operationCount: plan.operations.length })}\n`,
      )
      return 0
    }

    const approvedPlanPath = options.approvedPlan
    if (approvedPlanPath === undefined) throw new Error('Approved plan path is unavailable.')
    const approvedPlan = entraRegistrationPlanSchema.parse(await readBoundedJson(approvedPlanPath))
    if (
      approvedPlan.kind !== 'agent-sentinel-entra-registration-bootstrap-plan' ||
      approvedPlan.status !== 'ready' ||
      approvedPlan.tenantId.toLowerCase() !== input.tenantId
    ) {
      throw new Error('Approved plan is invalid or targets a different tenant.')
    }
    const result = await applyEntraRegistrationPlan(input, approvedPlan, graph)
    await writeFile(invocationPath(options.output), `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    })
    process.stdout.write(
      `${JSON.stringify({ mode: 'apply', status: result.status, approvedPlanDigest: result.approvedPlanDigest })}\n`,
    )
    return 0
  } catch (error: unknown) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Entra registration bootstrap failed.'}\n`,
    )
    return 1
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) process.exitCode = await runEntraRegistrationBootstrapCli()
