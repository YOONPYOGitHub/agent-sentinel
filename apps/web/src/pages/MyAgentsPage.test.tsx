/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { employeeCatalogApi } from '../api/employee-catalog-api'
import { AuthContext, type AuthContextValue } from '../hooks/AuthContext'
import { EstateContext, type EstateContextValue } from '../hooks/EstateContext'
import { MyAgentsPage } from './MyAgentsPage'

vi.mock('../api/employee-catalog-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  employeeCatalogApi: { get: vi.fn() },
}))

const estate: EstateContextValue = {
  state: {
    status: 'ready',
    estates: [
      {
        id: 'default',
        name: 'Default estate',
        tenantId: 'test',
        environment: 'test',
        isDefault: true,
      },
    ],
    selectedEstate: {
      id: 'default',
      name: 'Default estate',
      tenantId: 'test',
      environment: 'test',
      isDefault: true,
    },
  },
  reload: vi.fn().mockResolvedValue(undefined),
  selectEstate: vi.fn(),
}

function auth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    isConfigured: true,
    spaConfig: null,
    isLoading: false,
    isSignedIn: true,
    principal: {
      subject: 'subject',
      tenantId: 'test',
      roles: ['Viewer'],
      capabilities: ['read'],
    },
    authError: null,
    signIn: vi.fn().mockResolvedValue({ status: 'success' }),
    signOut: vi.fn().mockResolvedValue(undefined),
    getAccessToken: vi.fn().mockResolvedValue('token'),
    ...overrides,
  }
}

function renderPage(authValue = auth()) {
  render(
    <AuthContext.Provider value={authValue}>
      <EstateContext.Provider value={estate}>
        <MemoryRouter initialEntries={['/my-agents']}>
          <Routes>
            <Route path="/my-agents" element={<MyAgentsPage />} />
            <Route path="/agent-catalog" element={<h1>Agent assurance catalog</h1>} />
          </Routes>
        </MemoryRouter>
      </EstateContext.Provider>
    </AuthContext.Provider>,
  )
}

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(employeeCatalogApi.get).mockReset()
})

describe('MyAgentsPage', () => {
  it('renders only the agents returned by the personalized endpoint', async () => {
    vi.mocked(employeeCatalogApi.get).mockResolvedValue({
      status: 'available',
      authority: 'microsoft-agent-365',
      observedAt: '2026-09-14T06:00:00.000Z',
      agents: [
        {
          id: 'visible-agent',
          name: 'Payroll assistant',
          description: 'Answers payroll questions.',
          platform: 'Microsoft Agent 365',
        },
      ],
    })

    renderPage()

    expect(await screen.findByRole('heading', { name: 'Agents available to you' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Payroll assistant' })).toBeVisible()
    expect(screen.getByText('1 available agent')).toBeVisible()
  })

  it('fails closed without rendering operational inventory or evidence diagnostics', async () => {
    vi.mocked(employeeCatalogApi.get).mockResolvedValue({
      status: 'unknown',
      reason: 'ambiguous-evidence',
      agents: [],
    })

    renderPage()

    expect(
      await screen.findByRole('heading', { name: 'Agent access cannot be confirmed' }),
    ).toBeVisible()
    expect(screen.getByText(/fails closed and shows no agents/i)).toBeVisible()
    expect(screen.queryByText('ambiguous-evidence')).not.toBeInTheDocument()
  })

  it('prompts sign-in without querying entitlements when auth is configured but unsigned', () => {
    const signIn = vi.fn().mockResolvedValue({ status: 'success' as const })
    renderPage(auth({ isSignedIn: false, principal: null, signIn }))

    expect(screen.getByRole('heading', { name: 'Sign in to view My agents' })).toBeVisible()
    expect(employeeCatalogApi.get).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with Microsoft' }))
    expect(signIn).toHaveBeenCalledOnce()
  })

  it('redirects to the organization catalog when authentication is disabled', () => {
    renderPage(auth({ isConfigured: false, isSignedIn: false, principal: null }))

    expect(screen.getByRole('heading', { name: 'Agent assurance catalog' })).toBeVisible()
    expect(employeeCatalogApi.get).not.toHaveBeenCalled()
  })
})
