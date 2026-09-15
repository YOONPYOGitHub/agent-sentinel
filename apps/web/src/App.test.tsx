/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { useState } from 'react'

import App, { AuthenticatedApplication } from './App'
import { connectorApi, demoApi } from './api'
import { connectorsApi } from './api/connectors-api'
import { governanceApi } from './api/governance-api'
import { exposureApi } from './api/exposure-api'
import { EstateApiError, estateApi } from './api/estate-api'
import { getActiveEstateId, setActiveEstateId } from './api/auth-fetch'
import {
  AuthContext,
  type AuthContextValue,
  type SignInResult,
  type WebAuthPrincipal,
} from './hooks/AuthContext'
import { governancePostureFixture, testState } from './test-fixture'

vi.mock('./api')
vi.mock('./api/connectors-api')
vi.mock('./api/governance-api')
vi.mock('./api/exposure-api')
vi.mock('./components/ExposureGraph', () => ({ ExposureGraph: () => <div /> }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setActiveEstateId(undefined)
})

beforeEach(() => {
  localStorage.clear()
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'foundry',
    connectorId: 'azure-ai-foundry-agent-service',
    mode: 'foundry',
    projectEndpoint: 'https://contoso.services.ai.azure.com/api/projects/sentinel',
    writeEnabled: true,
  })
  vi.mocked(governanceApi.getPosture).mockResolvedValue(governancePostureFixture)
  vi.mocked(exposureApi.list).mockResolvedValue({
    findings: [],
    total: 0,
    facets: { severity: {}, status: {}, policyId: {} },
  })
  vi.mocked(exposureApi.listAll).mockResolvedValue([])
  vi.mocked(connectorsApi.listConnectors).mockResolvedValue({
    active: {
      id: 'azure-ai-foundry-agent-service',
      mode: 'foundry',
      source: 'foundry',
      lifecycleState: 'connected',
      writeEnabled: true,
      projectEndpoint: 'https://contoso.services.ai.azure.com/api/projects/sentinel',
    },
    catalog: [
      {
        id: 'azure-ai-foundry',
        name: 'Azure AI Foundry',
        description: 'Discovers agents.',
        lifecycleState: 'connected',
        capabilities: ['discovery'],
        sourceOfTruth: true,
        ownershipModel: 'consumes',
      },
    ],
  })
})

async function renderRoute(route: string) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
  await waitFor(() => expect(demoApi.getState).toHaveBeenCalled())
}

function authenticatedContext(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    isConfigured: true,
    spaConfig: {
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
      redirectUri: 'http://localhost:3000/auth-redirect.html',
      postLogoutRedirectUri: 'http://localhost:3000/',
    },
    isLoading: false,
    isSignedIn: true,
    principal: {
      subject: 'subject-id',
      tenantId: '11111111-1111-4111-8111-111111111111',
      roles: ['Viewer'],
      capabilities: ['read'],
    },
    authError: null,
    signIn: vi.fn().mockResolvedValue({ status: 'success' }),
    signOut: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue('access-token'),
    ...overrides,
  }
}

function renderAuthenticatedRoute(auth: AuthContextValue, route = '/overview') {
  render(
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={[route]}>
        <AuthenticatedApplication />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

function StatefulReauthentication({ attempt }: { attempt: () => Promise<SignInResult> }) {
  const initialPrincipal: WebAuthPrincipal = {
    subject: 'subject-id',
    tenantId: '11111111-1111-4111-8111-111111111111',
    roles: ['Viewer'],
    capabilities: ['read'],
  }
  const [authState, setAuthState] = useState<{
    isSignedIn: boolean
    principal: WebAuthPrincipal | null
    authError: string | null
  }>({
    isSignedIn: true,
    principal: initialPrincipal,
    authError: null,
  })
  const signIn = async (): Promise<SignInResult> => {
    const result = await attempt()
    if (result.status === 'failure') {
      setAuthState({
        isSignedIn: false,
        principal: null,
        authError: result.message,
      })
    }
    return result
  }
  const auth = authenticatedContext({ ...authState, signIn })
  return (
    <AuthContext.Provider value={auth}>
      <span data-testid="reauth-signed-in">{String(authState.isSignedIn)}</span>
      <span data-testid="reauth-principal">{authState.principal?.subject ?? 'none'}</span>
      <span data-testid="reauth-error">{authState.authError ?? 'none'}</span>
      <MemoryRouter initialEntries={['/overview']}>
        <AuthenticatedApplication />
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

function StatefulAuthErrorRecovery({
  attempt,
  signOut = vi.fn().mockResolvedValue(undefined),
}: {
  attempt: () => Promise<SignInResult>
  signOut?: () => Promise<void>
}) {
  const [authState, setAuthState] = useState<{
    isSignedIn: boolean
    principal: WebAuthPrincipal | null
    authError: string | null
  }>({
    isSignedIn: false,
    principal: null,
    authError: 'The previous session could not be restored. Sign in again.',
  })
  const signIn = async (): Promise<SignInResult> => {
    const result = await attempt()
    if (result.status === 'success') {
      setAuthState({
        isSignedIn: true,
        principal: {
          subject: 'recovered-subject',
          tenantId: '11111111-1111-4111-8111-111111111111',
          roles: ['Viewer'],
          capabilities: ['read'],
        },
        authError: null,
      })
    } else {
      setAuthState({
        isSignedIn: false,
        principal: null,
        authError: result.message,
      })
    }
    return result
  }
  const auth = authenticatedContext({ ...authState, signIn, signOut })
  return (
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/overview']}>
        <AuthenticatedApplication />
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

describe('application routing', () => {
  it('keeps one-estate deployments compatible without a selector', async () => {
    await renderRoute('/overview')
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(screen.queryByRole('combobox', { name: 'Active estate' })).not.toBeInTheDocument()
  })

  it('renders a multi-estate selector and reloads state after switching', async () => {
    let resolveReload!: (state: typeof testState) => void
    const reload = new Promise<typeof testState>((resolve) => {
      resolveReload = resolve
    })
    vi.mocked(demoApi.getState).mockResolvedValueOnce(testState).mockReturnValueOnce(reload)
    vi.spyOn(estateApi, 'list').mockResolvedValue({
      defaultEstateId: 'default',
      estates: [
        {
          id: 'default',
          name: 'Default estate',
          tenantId: 'test',
          environment: 'test',
          isDefault: true,
        },
        {
          id: 'research',
          name: 'Research estate',
          tenantId: 'research-tenant',
          environment: 'research',
          isDefault: false,
        },
      ],
    })
    await renderRoute('/overview')
    const initialLoads = vi.mocked(demoApi.getState).mock.calls.length
    fireEvent.change(screen.getByRole('combobox', { name: 'Active estate' }), {
      target: { value: 'research' },
    })
    expect(
      screen.queryByRole('heading', { name: 'Agent operations overview' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Connecting the agent evidence graph…')).toBeVisible()
    await waitFor(() =>
      expect(vi.mocked(demoApi.getState).mock.calls.length).toBeGreaterThan(initialLoads),
    )
    resolveReload(testState)
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(localStorage.getItem('agent-sentinel.estate-id')).toBe('research')
    fireEvent.click(screen.getByRole('button', { name: 'Scope information' }))
    expect(screen.getByText('research-tenant')).toBeVisible()
    expect(screen.getByText('research')).toBeVisible()
  })

  it('keeps estate selection available when the selected estate cannot load data', async () => {
    vi.spyOn(estateApi, 'list').mockResolvedValue({
      defaultEstateId: 'default',
      estates: [
        {
          id: 'default',
          name: 'Default estate',
          tenantId: 'test',
          environment: 'test',
          isDefault: true,
        },
        {
          id: 'research',
          name: 'Research estate',
          tenantId: 'research-tenant',
          environment: 'research',
          isDefault: false,
        },
      ],
    })
    vi.mocked(demoApi.getState)
      .mockResolvedValueOnce(testState)
      .mockRejectedValueOnce(new Error('This API is not yet enabled for non-default estates.'))
      .mockResolvedValueOnce(testState)

    await renderRoute('/overview')
    fireEvent.change(screen.getByRole('combobox', { name: 'Active estate' }), {
      target: { value: 'research' },
    })

    const unavailableHeading = await screen.findByRole('heading', {
      name: 'Agent estate is unavailable',
    })
    expect(screen.getByRole('alert')).toContainElement(unavailableHeading)
    const recoverySelector = screen.getByRole('combobox', { name: 'Active estate' })
    expect(recoverySelector).toHaveValue('research')
    fireEvent.change(recoverySelector, { target: { value: 'default' } })

    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(localStorage.getItem('agent-sentinel.estate-id')).toBe('default')
  })

  it.each([
    ['unauthorized', 'Authentication required'],
    ['forbidden', 'Estate access denied'],
    ['unavailable', 'Estate service unavailable'],
  ] as const)('renders the %s estate failure explicitly', async (kind, title) => {
    vi.spyOn(estateApi, 'list').mockRejectedValue(
      new EstateApiError(kind, `${kind} estate response`),
    )
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <App />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    expect(screen.getByText(`${kind} estate response`)).toBeVisible()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('renders an empty authorization set explicitly', async () => {
    vi.spyOn(estateApi, 'list').mockResolvedValue({
      defaultEstateId: 'default',
      estates: [],
    })
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <App />
      </MemoryRouter>,
    )
    expect(await screen.findByRole('heading', { name: 'No authorized estates' })).toBeVisible()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it.each([
    [
      'cancellation',
      {
        status: 'failure',
        reason: 'cancelled',
        message: 'Sign-in was cancelled.',
      } satisfies SignInResult,
      'Authentication is unavailable',
      'Sign-in was cancelled.',
    ],
    [
      'popup failure',
      {
        status: 'failure',
        reason: 'popup',
        message: 'Popup was blocked.',
      } satisfies SignInResult,
      'Authentication is unavailable',
      'Popup was blocked.',
    ],
    [
      'principal failure',
      {
        status: 'failure',
        reason: 'principal',
        message: 'Principal lookup failed.',
      } satisfies SignInResult,
      'Authentication is unavailable',
      'Principal lookup failed.',
    ],
    [
      'token failure',
      {
        status: 'failure',
        reason: 'token',
        message: 'Token acquisition failed.',
      } satisfies SignInResult,
      'Authentication is unavailable',
      'Token acquisition failed.',
    ],
  ] as const)(
    'does not retry estate authorization anonymously after %s',
    async (_case, result, expectedHeading, expectedError) => {
      const attempt = vi.fn().mockResolvedValue(result)
      vi.spyOn(estateApi, 'list').mockRejectedValue(
        new EstateApiError('unauthorized', 'Session expired.', 401),
      )

      render(<StatefulReauthentication attempt={attempt} />)

      fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }))

      expect(await screen.findByRole('heading', { name: expectedHeading })).toBeVisible()
      expect(attempt).toHaveBeenCalledOnce()
      expect(estateApi.list).toHaveBeenCalledOnce()
      expect(screen.getByTestId('reauth-signed-in')).toHaveTextContent('false')
      expect(screen.getByTestId('reauth-principal')).toHaveTextContent('none')
      expect(screen.getByTestId('reauth-error')).toHaveTextContent(expectedError)
      expect(getActiveEstateId()).toBeUndefined()
      expect(demoApi.getState).not.toHaveBeenCalled()

      await Promise.resolve()
      expect(estateApi.list).toHaveBeenCalledOnce()
    },
  )

  it('reauthenticates and retries estate authorization once after confirmed success', async () => {
    const attempt = vi.fn().mockResolvedValue({ status: 'success' } satisfies SignInResult)
    vi.spyOn(estateApi, 'list')
      .mockRejectedValueOnce(new EstateApiError('unauthorized', 'Session expired.', 401))
      .mockResolvedValueOnce({
        defaultEstateId: 'default',
        estates: [
          {
            id: 'default',
            name: 'Default estate',
            tenantId: 'test',
            environment: 'test',
            isDefault: true,
          },
        ],
      })

    render(<StatefulReauthentication attempt={attempt} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in again' }))

    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(attempt).toHaveBeenCalledOnce()
    expect(estateApi.list).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('reauth-signed-in')).toHaveTextContent('true')
    expect(screen.getByTestId('reauth-principal')).toHaveTextContent('subject-id')
    expect(screen.getByTestId('reauth-error')).toHaveTextContent('none')
    expect(getActiveEstateId()).toBe('default')

    await Promise.resolve()
    expect(estateApi.list).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['empty authorization', undefined, 'No authorized estates'],
    [
      'forbidden authorization',
      new EstateApiError('forbidden', 'Account is not assigned.', 403),
      'Estate access denied',
    ],
  ] as const)('offers account switching for %s', async (_case, error, title) => {
    const auth = authenticatedContext()
    if (error === undefined) {
      vi.spyOn(estateApi, 'list').mockResolvedValue({
        defaultEstateId: 'default',
        estates: [],
      })
    } else {
      vi.spyOn(estateApi, 'list').mockRejectedValue(error)
    }

    renderAuthenticatedRoute(auth)

    expect(await screen.findByRole('heading', { name: title })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out and switch account' }))

    expect(auth.signOut).toHaveBeenCalledOnce()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('offers safe recovery actions after cached-session restoration fails', () => {
    const attempt = vi.fn().mockResolvedValue({
      status: 'failure',
      reason: 'popup',
      message: 'Popup was blocked.',
    } satisfies SignInResult)
    const signOut = vi.fn().mockResolvedValue(undefined)
    const list = vi.spyOn(estateApi, 'list')

    render(<StatefulAuthErrorRecovery attempt={attempt} signOut={signOut} />)

    const heading = screen.getByRole('heading', { name: 'Authentication is unavailable' })
    expect(screen.getByRole('alert')).toContainElement(heading)
    expect(screen.getByRole('button', { name: 'Retry Microsoft sign-in' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Sign out and switch account' })).toBeEnabled()
    expect(list).not.toHaveBeenCalled()
  })

  it.each([
    ['popup cancellation', 'cancelled', 'Sign-in was cancelled.'],
    ['popup error', 'popup', 'Popup was blocked.'],
    ['token failure', 'token', 'Token acquisition failed.'],
    ['principal failure', 'principal', 'Principal lookup failed.'],
  ] as const)(
    'does not load estates anonymously after retrying a %s',
    async (_case, reason, message) => {
      const attempt = vi.fn().mockResolvedValue({
        status: 'failure',
        reason,
        message,
      } satisfies SignInResult)
      const list = vi.spyOn(estateApi, 'list')

      render(<StatefulAuthErrorRecovery attempt={attempt} />)
      fireEvent.click(screen.getByRole('button', { name: 'Retry Microsoft sign-in' }))

      expect(await screen.findByText(message)).toBeVisible()
      expect(attempt).toHaveBeenCalledOnce()
      expect(list).not.toHaveBeenCalled()
      expect(demoApi.getState).not.toHaveBeenCalled()
    },
  )

  it('loads estates only after retry confirms authentication', async () => {
    const attempt = vi.fn().mockResolvedValue({ status: 'success' } satisfies SignInResult)
    const list = vi.spyOn(estateApi, 'list').mockResolvedValue({
      defaultEstateId: 'default',
      estates: [
        {
          id: 'default',
          name: 'Default estate',
          tenantId: 'test',
          environment: 'test',
          isDefault: true,
        },
      ],
    })

    render(<StatefulAuthErrorRecovery attempt={attempt} />)
    expect(list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry Microsoft sign-in' }))

    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(attempt).toHaveBeenCalledOnce()
    expect(list).toHaveBeenCalledOnce()
  })

  it('signs out to switch accounts without loading estates from the auth error state', () => {
    const attempt = vi.fn().mockResolvedValue({ status: 'success' } satisfies SignInResult)
    const signOut = vi.fn().mockResolvedValue(undefined)
    const list = vi.spyOn(estateApi, 'list')

    render(<StatefulAuthErrorRecovery attempt={attempt} signOut={signOut} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out and switch account' }))

    expect(signOut).toHaveBeenCalledOnce()
    expect(attempt).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('redirects root to overview and uses functional active navigation', async () => {
    await renderRoute('/')
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('link', { name: 'My agents' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Demo readiness' })).not.toBeInTheDocument()
  })

  it('renders a live estate overview when the mock attack path is absent', async () => {
    vi.mocked(demoApi.getState).mockResolvedValue({ ...testState, findings: [] })
    vi.mocked(exposureApi.list).mockResolvedValue({
      findings: [],
      total: 3,
      facets: {
        severity: { critical: 2, high: 1 },
        status: { open: 3 },
        policyId: { 'AS-POL-001': 2, 'AS-POL-002': 1 },
      },
    })
    await renderRoute('/overview')

    expect(await screen.findByText('Foundry declared configuration is connected')).toBeVisible()
    expect(screen.getByText('Discovered agents')).toBeVisible()
    expect(screen.getByText('Open exposures')).toBeVisible()
    expect(screen.queryByText('Agent estate is unavailable')).not.toBeInTheDocument()
  })

  it('uses persisted exposure posture instead of the legacy demo workflow in live mode', async () => {
    await renderRoute('/overview')

    expect(await screen.findByText('Foundry declared configuration is connected')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Run safe validation' })).not.toBeInTheDocument()
    expect(exposureApi.list).toHaveBeenCalled()
  })

  it('requires and submits a bounded remediation approval reason', async () => {
    const proposedState = {
      ...testState,
      findings: testState.findings.map((finding) => ({
        ...finding,
        path: { ...finding.path, status: 'validated' as const },
      })),
      remediations: [
        {
          id: 'remediation-1',
          findingId: testState.findings[0]!.id,
          title: 'Block route',
          description: 'Block the unsafe route.',
          targetEdgeId: 'edge-data-mcp',
          status: 'proposed' as const,
          expectedRiskReduction: 91,
          businessDisruption: 'low' as const,
          rollbackAvailable: true,
        },
      ],
    }
    vi.mocked(demoApi.getState).mockResolvedValue(proposedState)
    vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
      writeEnabled: true,
    })
    vi.mocked(demoApi.approveRemediation).mockResolvedValue({
      ...proposedState,
      remediations: [
        {
          ...proposedState.remediations[0]!,
          status: 'approved',
          approvedBy: 'Local demo operator',
          approvedAt: '2026-08-30T13:00:00.000Z',
          approvalReason: 'Validated evidence supports this reversible containment.',
        },
      ],
    })
    await renderRoute('/overview')

    const approve = await screen.findByRole('button', { name: 'Approve response' })
    expect(approve).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Approval reason' }), {
      target: { value: 'Validated evidence supports this reversible containment.' },
    })
    expect(approve).toBeEnabled()
    fireEvent.click(approve)

    await waitFor(() =>
      expect(demoApi.approveRemediation).toHaveBeenCalledWith(
        'remediation-1',
        'Local demo operator',
        'Validated evidence supports this reversible containment.',
      ),
    )
  })

  it('renders the inventory and direct detail routes', async () => {
    await renderRoute('/agent-inventory')
    expect(await screen.findByText('3 of 3 agents')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agent inventory' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    cleanup()
    await renderRoute('/agent-inventory/hr-policy-agent')
    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
  })

  it('renders the cloud resource inventory route', async () => {
    await renderRoute('/cloud-resources')
    expect(await screen.findByRole('heading', { name: 'Cloud resources' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Cloud resources' })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('redirects legacy agent estate routes to the inventory', async () => {
    await renderRoute('/agent-estate')
    expect(await screen.findByRole('heading', { name: 'Agent inventory' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agent inventory' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    cleanup()
    await renderRoute('/agent-estate/hr-policy-agent')
    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
  })

  it('renders governance and wildcard 404 without an evidence route', async () => {
    await renderRoute('/governance')
    expect(await screen.findByRole('heading', { name: 'Policy governance' })).toBeVisible()
    cleanup()
    await renderRoute('/agent-estate/hr-policy-agent/evidence/evidence-hr-agent-manifest')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  it('renders evidence observability without placeholder metrics', async () => {
    await renderRoute('/observability')
    expect(await screen.findByRole('heading', { name: 'Evidence operations' })).toBeVisible()
    expect(screen.getByText('Evidence observability, not runtime APM')).toBeVisible()
  })

  it('renders the evidence-backed trust catalog', async () => {
    await renderRoute('/trust-catalog')
    expect(
      await screen.findByRole('heading', { name: 'Agent, MCP, and tool catalog' }),
    ).toBeVisible()
    expect(
      screen.getByText('Discovered capabilities, not a marketplace approval system'),
    ).toBeVisible()
  })

  it('renders lifecycle evidence without fabricated lineage', async () => {
    await renderRoute('/lifecycle')
    expect(await screen.findByRole('heading', { name: 'Lifecycle evidence' })).toBeVisible()
    expect(
      screen.getByText('Current-version evidence, not full release orchestration'),
    ).toBeVisible()
  })

  it('uses release readiness as the canonical route and redirects the compatibility path', async () => {
    await renderRoute('/release-readiness')
    expect(await screen.findByRole('heading', { name: 'Release readiness' })).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Release readiness' })).not.toBeInTheDocument()
    cleanup()

    await renderRoute('/demo-readiness')
    expect(await screen.findByRole('heading', { name: 'Release readiness' })).toBeVisible()
  })

  it('shows My agents in primary navigation only when authentication is configured', async () => {
    vi.spyOn(estateApi, 'list').mockResolvedValue({
      defaultEstateId: 'default',
      estates: [
        {
          id: 'default',
          name: 'Default estate',
          tenantId: 'test',
          environment: 'test',
          isDefault: true,
        },
      ],
    })

    renderAuthenticatedRoute(authenticatedContext())

    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'My agents' })).toHaveAttribute('href', '/my-agents')
  })

  it('renders bounded optimization recommendations', async () => {
    await renderRoute('/optimization')
    expect(
      await screen.findByRole('heading', { name: 'Evidence-backed recommendations' }),
    ).toBeVisible()
    expect(screen.getByText('Recommendation scope is bounded by available evidence')).toBeVisible()
  })

  it('renders connector status and metadata', async () => {
    await renderRoute('/connectors')
    expect(await screen.findByRole('heading', { name: 'Data connectors' })).toBeVisible()
    expect(await screen.findByText('Project endpoint')).toBeVisible()
  })

  it('opens global search with Ctrl+K and navigates to an agent result', async () => {
    await renderRoute('/overview')
    await screen.findByRole('heading', { name: 'Agent operations overview' })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(
      await screen.findByRole('dialog', { name: /Find an agent, cloud resource/i }),
    ).toBeVisible()
    const shellSearch = screen.getByRole('textbox', {
      name: 'Search agents, cloud resources, identities, tools, and evidence',
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(shellSearch).toHaveFocus())
    expect(
      screen.queryByRole('dialog', { name: /Find an agent, cloud resource/i }),
    ).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Agent Sentinel' }), {
      target: { value: 'Sales Research Agent' },
    })
    fireEvent.click(screen.getByRole('link', { name: /^Sales Research Agent agent/i }))

    expect(await screen.findByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    expect(
      screen.queryByRole('dialog', { name: /Find an agent, cloud resource/i }),
    ).not.toBeInTheDocument()
  })

  it('makes scope, environment, overflow, and user shell controls informative', async () => {
    await renderRoute('/overview')
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Scope information' }))
    expect(screen.getByText(/Foundry-connected portfolio/i)).toBeVisible()
    expect(screen.getAllByText('test').length).toBeGreaterThanOrEqual(2)
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Environment information' }))
    expect(screen.getByText(/Environment changes are deployment-controlled/i)).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Help and diagnostics' }))
    expect(screen.getByRole('link', { name: /connector management/i })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Authentication status' }))
    expect(screen.getByText('Authentication not configured')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Authentication settings' })).toBeVisible()
  })

  it('renders real settings and links to connector management', async () => {
    await renderRoute('/settings')

    expect(await screen.findByRole('heading', { name: 'Application settings' })).toBeVisible()
    expect(
      screen.getByRole('heading', { name: 'Configured scope · Foundry-connected' }),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Microsoft Foundry' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Default landing page' })).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Display density' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage connectors' }))
    expect(await screen.findByRole('heading', { name: 'Data connectors' })).toBeVisible()
  })

  it('shows read-only mode and disables mutations when writes are blocked', async () => {
    vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
      writeEnabled: false,
    })
    await renderRoute('/overview')
    expect(
      await screen.findByText(/Write operations are blocked by deployment policy/i),
    ).toBeVisible()
    expect(screen.queryByText(/auth not yet configured/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run safe validation' })).toBeDisabled()
  })
})
