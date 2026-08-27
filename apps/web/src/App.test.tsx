/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { connectorApi, demoApi } from './api'
import { connectorsApi } from './api/connectors-api'
import { governanceApi } from './api/governance-api'
import { exposureApi } from './api/exposure-api'
import { governancePostureFixture, testState } from './test-fixture'

vi.mock('./api')
vi.mock('./api/connectors-api')
vi.mock('./api/governance-api')
vi.mock('./api/exposure-api')
vi.mock('./components/ExposureGraph', () => ({ ExposureGraph: () => <div /> }))

afterEach(cleanup)

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

describe('application routing', () => {
  it('redirects root to overview and uses functional active navigation', async () => {
    await renderRoute('/')
    expect(await screen.findByRole('heading', { name: 'Agent operations overview' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
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
