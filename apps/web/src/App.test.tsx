/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { connectorApi, demoApi } from './api'
import { governanceApi } from './api/governance-api'
import { governancePostureFixture, testState } from './test-fixture'

vi.mock('./api')
vi.mock('./api/governance-api')
vi.mock('./components/ExposureGraph', () => ({ ExposureGraph: () => <div /> }))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'foundry',
    connectorId: 'azure-ai-foundry-agent-service',
    mode: 'foundry',
    projectEndpoint: 'https://contoso.services.ai.azure.com/api/projects/sentinel',
    writeEnabled: true,
  })
  vi.mocked(governanceApi.getPosture).mockResolvedValue(governancePostureFixture)
})

async function renderRoute(route: string) {
  render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  )
  await waitFor(() => expect(demoApi.getState).toHaveBeenCalled())
}

describe('application routing', () => {
  it('redirects root to overview and uses functional active navigation', async () => {
    await renderRoute('/')
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })

  it('renders the exact estate and direct detail routes', async () => {
    await renderRoute('/agent-estate')
    expect(await screen.findByText('3 of 3 agents')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Agent estate' })).toHaveAttribute(
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

  it('renders connector status and metadata', async () => {
    await renderRoute('/connectors')
    expect(await screen.findByRole('heading', { name: 'Connector health' })).toBeVisible()
    expect(
      await screen.findByRole('heading', { name: 'azure-ai-foundry-agent-service' }),
    ).toBeVisible()
    expect(await screen.findByText('Project endpoint')).toBeVisible()
  })

  it('opens global search with Ctrl+K and navigates to an agent result', async () => {
    await renderRoute('/overview')
    await screen.findByRole('heading', { name: 'Agent operations overview' })

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: /Find an agent/i })).toBeVisible()
    const shellSearch = screen.getByRole('textbox', {
      name: 'Search agents, identities, tools, and evidence',
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(shellSearch).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: /Find an agent/i })).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search Agent Sentinel' }), {
      target: { value: 'Sales Research Agent' },
    })
    fireEvent.click(screen.getByRole('link', { name: /^Sales Research Agent agent/i }))

    expect(await screen.findByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: /Find an agent/i })).not.toBeInTheDocument()
  })

  it('makes scope, environment, overflow, and user shell controls informative', async () => {
    await renderRoute('/overview')

    fireEvent.click(screen.getByRole('button', { name: 'Scope information' }))
    expect(screen.getByText(/Synthetic demo scope/i)).toBeVisible()
    expect(screen.getAllByText('test').length).toBeGreaterThanOrEqual(2)
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'Environment information' }))
    expect(screen.getByText(/Environment changes are deployment-controlled/i)).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.getByRole('link', { name: 'Connector diagnostics' })).toBeVisible()
    fireEvent.keyDown(document, { key: 'Escape' })

    fireEvent.click(screen.getByRole('button', { name: 'User menu' }))
    expect(screen.getByText('Simulated Agent Security Analyst')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Profile and preferences' })).toBeVisible()
  })

  it('renders real settings and links to connector management', async () => {
    await renderRoute('/settings')

    expect(await screen.findByRole('heading', { name: 'Application settings' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Contoso AI Lab · synthetic demo' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Microsoft Foundry' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Manage connectors' }))
    expect(await screen.findByRole('heading', { name: 'Connector health' })).toBeVisible()
  })

  it('shows read-only mode and disables mutations when writes are blocked', async () => {
    vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
      source: 'foundry',
      connectorId: 'azure-ai-foundry-agent-service',
      mode: 'foundry',
      writeEnabled: false,
    })
    await renderRoute('/overview')
    expect(await screen.findByText(/Read-only mode active/i)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run safe validation' })).toBeDisabled()
  })
})
