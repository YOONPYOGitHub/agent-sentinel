/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const msal = vi.hoisted(() => ({
  initialize: vi.fn(),
  loginPopup: vi.fn(),
  logoutPopup: vi.fn(),
  acquireTokenSilent: vi.fn(),
  getAllAccounts: vi.fn(),
}))

vi.mock('@azure/msal-browser', () => ({
  BrowserCacheLocation: { SessionStorage: 'sessionStorage' },
  PublicClientApplication: vi.fn(() => msal),
}))

vi.mock('../api/auth-api', () => ({
  authApi: { getConfig: vi.fn() },
}))

import { authApi } from '../api/auth-api'
import { AuthProvider } from './AuthProvider'
import { useAuth } from './useAuth'

function AuthState() {
  const auth = useAuth()
  return (
    <div>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="configured">{String(auth.isConfigured)}</span>
      <span data-testid="signed-in">{String(auth.isSignedIn)}</span>
      <span data-testid="principal">{auth.principal?.displayName ?? 'none'}</span>
      <span data-testid="error">{auth.authError ?? 'none'}</span>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  msal.initialize.mockResolvedValue(undefined)
  msal.getAllAccounts.mockReturnValue([])
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AuthProvider', () => {
  it('preserves anonymous local behavior only when auth is explicitly disabled', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({ enabled: false })
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(await screen.findByText('false', { selector: '[data-testid="loading"]' })).toBeVisible()
    expect(screen.getByTestId('configured')).toHaveTextContent('false')
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
  })

  it('reports configured but unsigned when no cached account exists', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      enabled: true,
      clientId: 'spa-client',
      authority: 'https://login.microsoftonline.com/tenant-id',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    })
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
  })

  it('loads a sanitized principal for a cached signed-in account', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      enabled: true,
      clientId: 'spa-client',
      authority: 'https://login.microsoftonline.com/tenant-id',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
    })
    msal.getAllAccounts.mockReturnValue([{ homeAccountId: 'home' }])
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: 'access-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            subject: 'subject-id',
            tenantId: 'tenant-id',
            displayName: 'Alice Analyst',
            roles: ['Analyst'],
            capabilities: ['read', 'validateFinding'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(await screen.findByText('Alice Analyst')).toBeVisible()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('true')
  })

  it('surfaces configuration failures instead of falling back to anonymous mode', async () => {
    vi.mocked(authApi.getConfig).mockRejectedValue(new Error('Configuration unavailable'))
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(await screen.findByText('Configuration unavailable')).toBeVisible()
    expect(screen.getByTestId('configured')).toHaveTextContent('false')
  })
})
