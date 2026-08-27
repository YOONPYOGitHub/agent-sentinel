// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import { connectorApi, demoApi } from '../api'
import { testState } from '../test-fixture'
import { AuthContext, type AuthContextValue } from '../hooks/AuthContext'
import { DemoStateContext } from '../hooks/DemoStateContext'
import { SettingsPage } from './SettingsPage'

vi.mock('../api')
afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'foundry',
    connectorId: 'azure-ai-foundry-agent-service',
    mode: 'foundry',
    writeEnabled: false,
  })
})

async function renderSettings() {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name: 'Application settings' })).toBeVisible()
}

describe('SettingsPage', () => {
  it('provides editable landing page and density preferences', async () => {
    const user = userEvent.setup()
    await renderSettings()

    expect(screen.getByText('Interface preferences')).toBeVisible()
    const landingPage = screen.getByRole('combobox', { name: 'Default landing page' })
    const density = screen.getByRole('combobox', { name: 'Display density' })
    expect(landingPage).toHaveValue('/overview')
    expect(density).toHaveValue('comfortable')

    await user.selectOptions(landingPage, '/agent-inventory')
    await user.selectOptions(density, 'compact')

    expect(landingPage).toHaveValue('/agent-inventory')
    expect(density).toHaveValue('compact')
    expect(document.querySelector('.app-shell')).toHaveClass('app-shell--compact')
  })

  it('shows deployment configuration as read-only', async () => {
    await renderSettings()

    expect(screen.getByText('Deployment configuration')).toBeVisible()
    expect(screen.getAllByText('Read only')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Microsoft Foundry' })).toBeVisible()
  })

  it('states that authentication is not configured and the user is not signed in', async () => {
    await renderSettings()

    expect(screen.getByRole('heading', { name: 'Authentication not configured' })).toBeVisible()
    expect(screen.getAllByText('Not signed in').length).toBeGreaterThan(0)
    expect(screen.getByText(/Microsoft Entra ID is the intended identity provider/i)).toBeVisible()
  })

  it('shows configured-but-not-signed-in state truthfully', () => {
    const configuredCtx: AuthContextValue = {
      isConfigured: true,
      spaConfig: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        clientId: '22222222-2222-4222-8222-222222222222',
        authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
        scopes: ['api://agent-sentinel/AgentSentinel.Read'],
        redirectUri: 'https://sentinel.example/auth/callback',
        postLogoutRedirectUri: 'https://sentinel.example/',
      },
      isLoading: false,
      isSignedIn: false,
      principal: null,
      authError: null,
      signIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getAccessToken: vi.fn().mockResolvedValue(null),
    }
    render(
      <AuthContext.Provider value={configuredCtx}>
        <DemoStateContext.Provider
          value={{
            state: testState,
            connectorStatus: {
              source: 'mock',
              connectorId: 'mock-agent-estate',
              mode: 'mock',
              writeEnabled: true,
            },
            operation: undefined,
            error: undefined,
            clearError: vi.fn(),
            load: vi.fn().mockResolvedValue(undefined),
            run: vi.fn().mockResolvedValue(undefined),
          }}
        >
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </DemoStateContext.Provider>
      </AuthContext.Provider>,
    )
    expect(screen.getByRole('heading', { name: /Authentication configured/i })).toBeVisible()
    expect(screen.getAllByText('Not signed in').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /Sign in with Microsoft/i })).toBeVisible()
  })

  it('shows signed-in principal truthfully', () => {
    const signedInCtx: AuthContextValue = {
      isConfigured: true,
      spaConfig: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        clientId: '22222222-2222-4222-8222-222222222222',
        authority: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111',
        scopes: ['api://agent-sentinel/AgentSentinel.Read'],
        redirectUri: 'https://sentinel.example/auth/callback',
        postLogoutRedirectUri: 'https://sentinel.example/',
      },
      isLoading: false,
      isSignedIn: true,
      principal: {
        subject: 'sub',
        tenantId: 'tenant-id',
        displayName: 'Alice Analyst',
        preferredUsername: 'alice@contoso.com',
        roles: ['Analyst'],
        capabilities: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
      },
      authError: null,
      signIn: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
      getAccessToken: vi.fn().mockResolvedValue(null),
    }
    render(
      <AuthContext.Provider value={signedInCtx}>
        <DemoStateContext.Provider
          value={{
            state: testState,
            connectorStatus: {
              source: 'mock',
              connectorId: 'mock-agent-estate',
              mode: 'mock',
              writeEnabled: true,
            },
            operation: undefined,
            error: undefined,
            clearError: vi.fn(),
            load: vi.fn().mockResolvedValue(undefined),
            run: vi.fn().mockResolvedValue(undefined),
          }}
        >
          <MemoryRouter>
            <SettingsPage />
          </MemoryRouter>
        </DemoStateContext.Provider>
      </AuthContext.Provider>,
    )
    expect(screen.getByText('Signed in')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Alice Analyst' })).toBeVisible()
  })
})
