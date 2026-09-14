import { readFile } from 'node:fs/promises'

import { describe, expect, it, vi } from 'vitest'

import {
  ENTRA_BOOTSTRAP_APPROVAL,
  ENTRA_BOOTSTRAP_PROTECTED_ENVIRONMENT,
  SnapshotEntraGraphClient,
  applyEntraRegistrationPlan,
  buildEntraRegistrationPlan,
  entraRegistrationInputSchema,
  entraRegistrationStateSchema,
  graphCreateResultSchema,
  runEntraRegistrationBootstrapCli,
  type EntraGraphClient,
  type GraphApplication,
  type GraphApplicationCreateResult,
  type GraphServicePrincipal,
  type GraphServicePrincipalCreateResult,
} from './entra-registration-bootstrap.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`./test-fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as unknown
}

async function planFor(stateName: string) {
  const input = await fixture('entra-registration-input')
  const state = entraRegistrationStateSchema.parse(await fixture(stateName))
  return buildEntraRegistrationPlan(input, new SnapshotEntraGraphClient(state))
}

describe('buildEntraRegistrationPlan', () => {
  it('creates a deterministic sanitized empty-tenant plan with all required Graph shapes', async () => {
    const first = await planFor('entra-registration-state-empty')
    const second = await planFor('entra-registration-state-empty')

    expect(first).toEqual(second)
    expect(first.operations.map((operation) => operation.id)).toEqual([
      'api.application.create',
      'api.application.configure',
      'api.servicePrincipal.create',
      'spa.application.create',
      'spa.servicePrincipal.create',
    ])
    expect(
      first.operations.find((operation) => operation.id === 'api.application.create')?.request,
    ).toMatchObject({
      method: 'POST',
      path: '/applications',
      body: {
        displayName: 'Agent Sentinel Replacement API',
        signInAudience: 'AzureADMyOrg',
      },
    })

    describe('Microsoft Graph create responses', () => {
      it('projects required identifiers from expanded application and service principal payloads', () => {
        expect(
          graphCreateResultSchema.parse({
            '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#applications/$entity',
            id: 'object-id',
            appId: '22222222-2222-4222-8222-222222222222',
            displayName: 'Agent Sentinel Replacement API',
            identifierUris: [],
            appRoles: [],
            api: {},
            spa: {},
            web: {},
          }),
        ).toEqual({
          id: 'object-id',
          appId: '22222222-2222-4222-8222-222222222222',
        })
      })
    })
    expect(
      first.operations.find((operation) => operation.id === 'spa.application.create')?.request,
    ).toMatchObject({
      body: {
        spa: {
          redirectUris: ['https://sentinel-replacement.example.com/auth-redirect.html'],
        },
        web: { logoutUrl: 'https://sentinel-replacement.example.com/' },
        requiredResourceAccess: [
          {
            resourceAppId: '{{api.appId}}',
            resourceAccess: [expect.objectContaining({ type: 'Scope' })],
          },
        ],
      },
    })
    const serialized = JSON.stringify(first)
    for (const forbidden of [
      'clientSecret',
      'passwordCredentials',
      'keyCredentials',
      'accessToken',
      'refreshToken',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
    const graphBodies = JSON.stringify(first.operations.map((operation) => operation.request.body))
    for (const forbidden of [
      'groups',
      'groupIds',
      'appRoleAssignments',
      'oauth2PermissionGrants',
    ]) {
      expect(graphBodies).not.toContain(`"${forbidden}"`)
    }
    expect(
      first.rollbackPlan.operations.every((item) => item.createdByOperationId.endsWith('create')),
    ).toBe(true)
    expect(first.rollbackPlan.operations.map((item) => item.request.path)).toEqual(
      expect.arrayContaining([
        '/applications/{{operation.api.application.create.objectId}}',
        '/servicePrincipals/{{operation.api.servicePrincipal.create.objectId}}',
      ]),
    )
  })

  it('is idempotent for exact existing registrations and service principals', async () => {
    const plan = await planFor('entra-registration-state-exact')
    expect(plan.operations).toEqual([])
    expect(plan.rollbackPlan.operations).toEqual([])
  })

  it('rejects historical registrations on a wrong Front Door origin', async () => {
    await expect(planFor('entra-registration-state-wrong-origin')).rejects.toThrow(
      'historical or wrong-origin',
    )
  })

  it('rejects ambiguous exact-name app candidates', async () => {
    await expect(planFor('entra-registration-state-ambiguous')).rejects.toThrow('Ambiguous')
  })

  it('corrects partial service principals, scopes, roles, redirects, and Read access only', async () => {
    const plan = await planFor('entra-registration-state-partial')
    expect(plan.operations.map((operation) => operation.id)).toEqual([
      'api.application.configure',
      'api.servicePrincipal.create',
      'spa.application.configure',
      'spa.servicePrincipal.create',
    ])
    const apiBody = plan.operations[0]?.request.body
    expect(
      (apiBody?.['api'] as { oauth2PermissionScopes: unknown[] }).oauth2PermissionScopes,
    ).toHaveLength(2)
    expect(apiBody?.['appRoles']).toHaveLength(4)
    expect(plan.operations[2]?.request.body).toMatchObject({
      requiredResourceAccess: [
        {
          resourceAppId: '22222222-2222-4222-8222-222222222222',
          resourceAccess: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: 'Scope' }],
        },
      ],
    })
  })

  it('rejects secret-shaped input fields without reflecting their values', async () => {
    const input = (await fixture('entra-registration-input')) as Record<string, unknown>
    const state = entraRegistrationStateSchema.parse(
      await fixture('entra-registration-state-empty'),
    )
    await expect(
      buildEntraRegistrationPlan(
        { ...input, clientSecret: 'must-never-appear' },
        new SnapshotEntraGraphClient(state),
      ),
    ).rejects.toThrow('Secret')
  })
})

class MutableGraphClient implements EntraGraphClient {
  public readonly applications: GraphApplication[] = []
  public readonly servicePrincipals: GraphServicePrincipal[] = []
  private applicationSequence = 2
  private servicePrincipalSequence = 7

  public getTenantId(): Promise<string> {
    return Promise.resolve('11111111-1111-4111-8111-111111111111')
  }

  public listApplicationsByDisplayName(displayName: string): Promise<readonly GraphApplication[]> {
    return Promise.resolve(
      this.applications.filter((application) => application.displayName === displayName),
    )
  }

  public listServicePrincipalsByAppId(appId: string): Promise<readonly GraphServicePrincipal[]> {
    return Promise.resolve(this.servicePrincipals.filter((principal) => principal.appId === appId))
  }

  public createApplication(
    body: Readonly<Record<string, unknown>>,
  ): Promise<GraphApplicationCreateResult> {
    const digit = String(this.applicationSequence)
    this.applicationSequence += 1
    const appId = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`
    const id = `object-${appId}`
    this.applications.push({ id, appId, ...(body as Omit<GraphApplication, 'id' | 'appId'>) })
    return Promise.resolve({ id, appId })
  }

  public updateApplication(id: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    const index = this.applications.findIndex((application) => application.id === id)
    if (index < 0) return Promise.reject(new Error('missing app'))
    this.applications[index] = {
      ...this.applications[index]!,
      ...(body as Partial<GraphApplication>),
    }
    return Promise.resolve()
  }

  public createServicePrincipal(
    body: Readonly<Record<string, unknown>>,
  ): Promise<GraphServicePrincipalCreateResult> {
    const appId = String(body['appId'])
    const id = `service-principal-${String(this.servicePrincipalSequence)}`
    this.servicePrincipalSequence += 1
    this.servicePrincipals.push({ id, appId })
    return Promise.resolve({ id, appId })
  }

  public deleteApplication(id: string): Promise<void> {
    const index = this.applications.findIndex((application) => application.id === id)
    if (index >= 0) this.applications.splice(index, 1)
    return Promise.resolve()
  }

  public deleteServicePrincipal(id: string): Promise<void> {
    const index = this.servicePrincipals.findIndex((principal) => principal.id === id)
    if (index >= 0) this.servicePrincipals.splice(index, 1)
    return Promise.resolve()
  }
}

describe('applyEntraRegistrationPlan', () => {
  it('applies through the injected client and post-apply rediscovery is idempotent', async () => {
    const input = entraRegistrationInputSchema.parse(await fixture('entra-registration-input'))
    const graph = new MutableGraphClient()
    const plan = await buildEntraRegistrationPlan(input, graph)
    const result = await applyEntraRegistrationPlan(input, plan, graph)

    expect(result.status).toBe('applied')
    expect(result.postApply.remainingOperationCount).toBe(0)
    expect(graph.applications).toHaveLength(2)
    expect(graph.servicePrincipals).toHaveLength(2)
  })

  it('denies apply by default before invoking the injected Graph client', async () => {
    const graph = new MutableGraphClient()
    const tenantSpy = vi.spyOn(graph, 'getTenantId')
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const result = await runEntraRegistrationBootstrapCli(
      [
        '--input',
        new URL('./test-fixtures/entra-registration-input.json', import.meta.url).pathname,
        '--output',
        'bootstrap-result.json',
        '--approved-plan',
        'bootstrap-plan.json',
        '--apply',
        '--approval',
        'NOT_APPROVED',
        '--confirm-tenant',
        '11111111-1111-4111-8111-111111111111',
      ],
      graph,
    )

    expect(result).toBe(1)
    expect(tenantSpy).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(ENTRA_BOOTSTRAP_APPROVAL))
    stderr.mockRestore()
  })

  it('requires the protected environment and exact tenant confirmation', async () => {
    const previous = process.env['AGENT_SENTINEL_PROTECTED_ENVIRONMENT']
    delete process.env['AGENT_SENTINEL_PROTECTED_ENVIRONMENT']
    const graph = new MutableGraphClient()
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const result = await runEntraRegistrationBootstrapCli(
      [
        '--input',
        new URL('./test-fixtures/entra-registration-input.json', import.meta.url).pathname,
        '--output',
        'bootstrap-result.json',
        '--approved-plan',
        'bootstrap-plan.json',
        '--apply',
        '--approval',
        ENTRA_BOOTSTRAP_APPROVAL,
        '--confirm-tenant',
        '11111111-1111-4111-8111-111111111111',
      ],
      graph,
    )
    expect(result).toBe(1)
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(ENTRA_BOOTSTRAP_PROTECTED_ENVIRONMENT),
    )
    stderr.mockRestore()
    if (previous === undefined) delete process.env['AGENT_SENTINEL_PROTECTED_ENVIRONMENT']
    else process.env['AGENT_SENTINEL_PROTECTED_ENVIRONMENT'] = previous
  })
})
