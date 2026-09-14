/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'

const msal = vi.hoisted(() => ({
  initialize: vi.fn(),
  handleRedirectPromise: vi.fn(),
  loginPopup: vi.fn(),
  logoutRedirect: vi.fn(),
  clearCache: vi.fn(),
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

const enabledConfig = {
  enabled: true as const,
  tenantId: '11111111-1111-4111-8111-111111111111',
  clientId: '22222222-2222-4222-8222-222222222222',
  authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
  scopes: ['api://agent-sentinel/AgentSentinel.Read'],
  redirectUri: 'http://localhost:3000/auth-redirect.html',
  postLogoutRedirectUri: 'http://localhost:3000/',
}

function AuthState() {
  const auth = useAuth()
  const [signInResult, setSignInResult] = useState('none')
  const [accessToken, setAccessToken] = useState('none')
  return (
    <div>
      <span data-testid="loading">{String(auth.isLoading)}</span>
      <span data-testid="configured">{String(auth.isConfigured)}</span>
      <span data-testid="signed-in">{String(auth.isSignedIn)}</span>
      <span data-testid="principal">{auth.principal?.displayName ?? 'none'}</span>
      <span data-testid="error">{auth.authError ?? 'none'}</span>
      <span data-testid="sign-in-result">{signInResult}</span>
      <span data-testid="access-token">{accessToken}</span>
      <button
        onClick={() => {
          void auth.signIn().then((result) => {
            setSignInResult(
              result.status === 'success' ? result.status : `${result.status}:${result.reason}`,
            )
          })
        }}
      >
        Sign in test
      </button>
      <button
        onClick={() => {
          void auth.getAccessToken().then((token) => setAccessToken(token ?? 'none'))
        }}
      >
        Get access token test
      </button>
      <button onClick={() => void auth.signOut()}>Sign out test</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  msal.initialize.mockResolvedValue(undefined)
  msal.handleRedirectPromise.mockResolvedValue(null)
  msal.logoutRedirect.mockResolvedValue(undefined)
  msal.clearCache.mockResolvedValue(undefined)
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
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    expect(msal.handleRedirectPromise).toHaveBeenCalledOnce()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
  })

  it('returns an explicit cancellation failure without establishing auth state', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    msal.loginPopup.mockRejectedValue(
      Object.assign(new Error('User cancelled sign-in.'), { errorCode: 'user_cancelled' }),
    )

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:cancelled', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(msal.loginPopup).toHaveBeenCalledOnce()
    expect(msal.loginPopup).toHaveBeenCalledWith({
      scopes: enabledConfig.scopes,
      prompt: 'select_account',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
    expect(screen.getByTestId('error')).toHaveTextContent('Sign-in was cancelled.')
    expect(msal.clearCache).not.toHaveBeenCalled()
  })

  it('returns an explicit popup failure without fetching a principal', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    msal.loginPopup.mockRejectedValue(new Error('Popup was blocked.'))

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:popup', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(msal.loginPopup).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
    expect(screen.getByTestId('error')).toHaveTextContent('Popup was blocked.')
    expect(msal.clearCache).not.toHaveBeenCalled()
  })

  it('returns an explicit popup failure when sign-in does not establish an account', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)
    msal.loginPopup.mockResolvedValue({
      account: null,
      accessToken: 'popup-access-token',
    })

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:popup', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(msal.loginPopup).toHaveBeenCalledOnce()
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
    expect(screen.getByTestId('error')).toHaveTextContent('Sign-in did not return an account.')
  })

  it('returns an explicit token failure without fetching a principal', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'popup-home' }
    msal.loginPopup.mockResolvedValue({ account, accessToken: '' })
    msal.acquireTokenSilent.mockRejectedValue(new Error('Token acquisition failed.'))
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:token', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(msal.acquireTokenSilent).toHaveBeenCalledOnce()
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({
      account,
      scopes: enabledConfig.scopes,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
    expect(screen.getByTestId('error')).toHaveTextContent('Token acquisition failed.')
    expect(msal.clearCache).toHaveBeenCalledWith({ account })
  })

  it('returns an explicit principal failure and clears the popup account', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'popup-home' }
    msal.loginPopup.mockResolvedValue({
      account,
      accessToken: 'popup-access-token',
    })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Principal lookup failed.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:principal', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(msal.loginPopup).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
    expect(screen.getByTestId('error')).toHaveTextContent('Principal lookup failed.')
    expect(msal.clearCache).toHaveBeenCalledWith({ account })

    fireEvent.click(screen.getByRole('button', { name: 'Get access token test' }))
    expect(
      await screen.findByText('none', { selector: '[data-testid="access-token"]' }),
    ).toBeVisible()
    expect(msal.acquireTokenSilent).not.toHaveBeenCalled()
  })

  it('rejects a principal response containing fields outside the sanitized contract', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'popup-home' }
    msal.loginPopup.mockResolvedValue({ account, accessToken: 'popup-access-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            subject: 'subject-id',
            tenantId: 'tenant-id',
            roles: ['Viewer'],
            capabilities: ['read'],
            rawToken: 'must-not-be-accepted',
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

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('failure:principal', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(msal.clearCache).toHaveBeenCalledWith({ account })
  })

  it('confirms success only after the popup principal and scoped token state are established', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'popup-home' }
    msal.loginPopup.mockResolvedValue({
      account,
      accessToken: 'popup-access-token',
    })
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: 'refreshed-access-token' })
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
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
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('true', { selector: '[data-testid="configured"]' }),
    ).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in test' }))

    expect(
      await screen.findByText('success', { selector: '[data-testid="sign-in-result"]' }),
    ).toBeVisible()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('true')
    expect(screen.getByTestId('principal')).toHaveTextContent('Alice Analyst')
    expect(screen.getByTestId('error')).toHaveTextContent('none')

    fireEvent.click(screen.getByRole('button', { name: 'Get access token test' }))
    expect(
      await screen.findByText('refreshed-access-token', {
        selector: '[data-testid="access-token"]',
      }),
    ).toBeVisible()
    expect(msal.acquireTokenSilent).toHaveBeenCalledOnce()
    expect(msal.acquireTokenSilent).toHaveBeenCalledWith({
      account,
      scopes: enabledConfig.scopes,
    })
  })

  it('loads a sanitized principal for a cached signed-in account', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      enabled: true,
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
      redirectUri: 'http://localhost:3000/auth-redirect.html',
      postLogoutRedirectUri: 'http://localhost:3000/',
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

  it('clears a cached account when the previous session cannot be restored', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'stale-home' }
    msal.getAllAccounts.mockReturnValueOnce([account]).mockReturnValue([])
    msal.acquireTokenSilent.mockRejectedValue(new Error('Cached token is expired.'))
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText('The previous session could not be restored. Sign in again.'),
    ).toBeVisible()
    expect(msal.clearCache).toHaveBeenCalledWith({ account })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')

    fireEvent.click(screen.getByRole('button', { name: 'Get access token test' }))
    expect(
      await screen.findByText('none', { selector: '[data-testid="access-token"]' }),
    ).toBeVisible()
    expect(msal.acquireTokenSilent).toHaveBeenCalledOnce()
  })

  it('reports when MSAL resolves cache clearing but leaves the stale account', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue(enabledConfig)
    const account = { homeAccountId: 'stale-home' }
    msal.getAllAccounts.mockReturnValue([account])
    msal.acquireTokenSilent.mockRejectedValue(new Error('Cached token is expired.'))

    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(
      await screen.findByText(
        /The cached Microsoft session could not be cleared\. Use account switching to recover\./,
      ),
    ).toBeVisible()
    expect(msal.clearCache).toHaveBeenCalledWith({ account })
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
  })

  it('uses full-page logout so the application is not initialized inside a popup', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      enabled: true,
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
      redirectUri: 'http://localhost:3000/auth-redirect.html',
      postLogoutRedirectUri: 'http://localhost:3000/',
    })
    const account = { homeAccountId: 'home' }
    msal.getAllAccounts.mockReturnValue([account])
    msal.acquireTokenSilent.mockResolvedValue({ accessToken: 'access-token' })
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            subject: 'subject-id',
            tenantId: 'tenant-id',
            displayName: 'Alice Analyst',
            roles: ['Viewer'],
            capabilities: ['read'],
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
    fireEvent.click(screen.getByRole('button', { name: 'Sign out test' }))

    await waitFor(() =>
      expect(msal.logoutRedirect).toHaveBeenCalledWith({
        account,
        postLogoutRedirectUri: 'http://localhost:3000/',
      }),
    )
    expect(screen.getByTestId('signed-in')).toHaveTextContent('false')
    expect(screen.getByTestId('principal')).toHaveTextContent('none')
  })

  it('fails closed when configured redirects use same-origin but incorrect paths', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      ...enabledConfig,
      redirectUri: 'http://localhost:3000/auth/callback',
    })
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(await screen.findByText(/exact application callback and logout URLs/i)).toBeVisible()
    expect(screen.getByTestId('configured')).toHaveTextContent('false')
  })

  it('fails closed when configured redirects target another origin', async () => {
    vi.mocked(authApi.getConfig).mockResolvedValue({
      enabled: true,
      tenantId: '11111111-1111-4111-8111-111111111111',
      clientId: '22222222-2222-4222-8222-222222222222',
      authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
      scopes: ['api://agent-sentinel/AgentSentinel.Read'],
      redirectUri: 'https://other.example/auth/callback',
      postLogoutRedirectUri: 'https://other.example/',
    })
    render(
      <AuthProvider>
        <AuthState />
      </AuthProvider>,
    )

    expect(await screen.findByText(/exact application callback and logout URLs/i)).toBeVisible()
    expect(screen.getByTestId('configured')).toHaveTextContent('false')
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
