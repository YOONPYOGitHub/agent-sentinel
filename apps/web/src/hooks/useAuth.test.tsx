// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import React from 'react'

import { AuthContext, type AuthContextValue, type WebAuthPrincipal } from './AuthContext'
import { usePermission, usePermissionMessage } from './usePermission'
import { AuthenticatedApplication } from '../App'

afterEach(cleanup)

function makeAuthCtx(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    isConfigured: false,
    spaConfig: null,
    isLoading: false,
    isSignedIn: false,
    principal: null,
    authError: null,
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue(null),
    ...overrides,
  }
}

const analystPrincipal: WebAuthPrincipal = {
  subject: 'user-sub',
  tenantId: 'tenant-id',
  displayName: 'Alice Analyst',
  preferredUsername: 'alice@contoso.com',
  roles: ['Analyst'],
  capabilities: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
}

const approverPrincipal: WebAuthPrincipal = {
  subject: 'approver-sub',
  tenantId: 'tenant-id',
  displayName: 'Bob Approver',
  roles: ['Approver'],
  capabilities: [
    'read',
    'validateFinding',
    'generateAdvisory',
    'proposeRemediation',
    'approveRemediation',
  ],
}

function CapCheck({ capability }: { capability: Parameters<typeof usePermission>[0] }) {
  const ok = usePermission(capability)
  const msg = usePermissionMessage(capability)
  return (
    <div>
      <span data-testid="perm">{ok ? 'allowed' : 'denied'}</span>
      {msg ? <span data-testid="msg">{msg}</span> : null}
    </div>
  )
}

function renderWithAuth(ctx: AuthContextValue, ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={ctx}>{ui}</AuthContext.Provider>
    </MemoryRouter>,
  )
}

describe('usePermission', () => {
  it('fails closed while authentication configuration is loading', () => {
    const ctx = makeAuthCtx({ isLoading: true, isConfigured: false })
    renderWithAuth(ctx, <CapCheck capability="executeRemediation" />)
    expect(screen.getByTestId('perm').textContent).toBe('denied')
    expect(screen.getByTestId('msg').textContent).toMatch(/checking authentication/i)
  })

  it('returns true for any capability when auth is not configured', () => {
    const ctx = makeAuthCtx({ isConfigured: false })
    renderWithAuth(ctx, <CapCheck capability="executeRemediation" />)
    expect(screen.getByTestId('perm').textContent).toBe('allowed')
  })

  it('returns false for all capabilities when configured but not signed in', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: false })
    renderWithAuth(ctx, <CapCheck capability="read" />)
    expect(screen.getByTestId('perm').textContent).toBe('denied')
  })

  it('returns true for matching capability when signed in', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: true, principal: analystPrincipal })
    renderWithAuth(ctx, <CapCheck capability="validateFinding" />)
    expect(screen.getByTestId('perm').textContent).toBe('allowed')
  })

  it('returns false for capability not in principal.capabilities', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: true, principal: analystPrincipal })
    renderWithAuth(ctx, <CapCheck capability="approveRemediation" />)
    expect(screen.getByTestId('perm').textContent).toBe('denied')
  })

  it('Approver can approve but not execute', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: true, principal: approverPrincipal })
    const { unmount } = renderWithAuth(ctx, <CapCheck capability="approveRemediation" />)
    expect(screen.getByTestId('perm').textContent).toBe('allowed')
    unmount()
    renderWithAuth(ctx, <CapCheck capability="executeRemediation" />)
    expect(screen.getByTestId('perm').textContent).toBe('denied')
  })
})

describe('AuthenticatedApplication', () => {
  it('shows a Microsoft sign-in gate before protected data providers mount', () => {
    const signIn = vi.fn().mockResolvedValue(undefined)
    const ctx = makeAuthCtx({
      isConfigured: true,
      isSignedIn: false,
      signIn,
    })
    renderWithAuth(ctx, <AuthenticatedApplication />)

    expect(screen.getByRole('heading', { name: 'Sign in to Agent Sentinel' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(signIn).toHaveBeenCalledOnce()
  })
})

describe('usePermissionMessage', () => {
  it('returns null when auth is not configured', () => {
    const ctx = makeAuthCtx({ isConfigured: false })
    renderWithAuth(ctx, <CapCheck capability="configure" />)
    expect(screen.queryByTestId('msg')).toBeNull()
  })

  it('returns sign-in message when configured but not signed in', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: false })
    renderWithAuth(ctx, <CapCheck capability="read" />)
    expect(screen.getByTestId('msg').textContent).toMatch(/sign in/i)
  })

  it('returns role message when signed in but lacking capability', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: true, principal: analystPrincipal })
    renderWithAuth(ctx, <CapCheck capability="approveRemediation" />)
    expect(screen.getByTestId('msg').textContent).toMatch(/Approver/i)
  })

  it('returns null when user has the capability', () => {
    const ctx = makeAuthCtx({ isConfigured: true, isSignedIn: true, principal: analystPrincipal })
    renderWithAuth(ctx, <CapCheck capability="validateFinding" />)
    expect(screen.queryByTestId('msg')).toBeNull()
  })
})

describe('apiFetch token injection', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends no Authorization header when token provider returns null', async () => {
    const { setTokenProvider, apiFetch } = await import('../api/auth-fetch')
    setTokenProvider(undefined)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/api/test')
    const callArgs = fetchMock.mock.calls[0]
    const headers = callArgs?.[1] === undefined ? new Headers() : new Headers(callArgs[1]?.headers)
    expect(headers.get('Authorization')).toBeNull()
  })

  it('injects the selected estate ID while preserving caller-provided headers', async () => {
    const { setEstateIdProvider, apiFetch } = await import('../api/auth-fetch')
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    setEstateIdProvider(() => 'authorized-estate')

    await apiFetch('/api/test', { headers: { 'x-request-id': 'request-1' } })

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-agent-sentinel-estate-id')).toBe('authorized-estate')
    expect(headers.get('x-request-id')).toBe('request-1')
    setEstateIdProvider(undefined)
  })

  it('injects Bearer token when token provider is set', async () => {
    const { setTokenProvider, apiFetch } = await import('../api/auth-fetch')
    setTokenProvider(() => Promise.resolve('test-access-token'))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/api/test')
    const callArgs = fetchMock.mock.calls[0]
    const headers = new Headers(callArgs?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-access-token')
    setTokenProvider(undefined)
  })

  it('does not overwrite an explicit Authorization header', async () => {
    const { setTokenProvider, apiFetch } = await import('../api/auth-fetch')
    setTokenProvider(() => Promise.resolve('provider-token'))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await apiFetch('/api/auth/me', {
      headers: { Authorization: 'Bearer explicit-token' },
    })

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer explicit-token')
    setTokenProvider(undefined)
  })

  it('preserves Authorization embedded in a Request object', async () => {
    const { setTokenProvider, apiFetch } = await import('../api/auth-fetch')
    setTokenProvider(() => Promise.resolve('provider-token'))
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const request = new Request('http://localhost/api/auth/me', {
      headers: { Authorization: 'Bearer request-token' },
    })

    await apiFetch(request)

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
    expect(headers.get('Authorization')).toBe('Bearer request-token')
    setTokenProvider(undefined)
  })
})
