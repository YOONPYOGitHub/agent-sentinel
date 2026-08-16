// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from './App'
import { connectorApi, demoApi } from './api'
import { testState } from './test-fixture'

vi.mock('./api')
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

  it('renders coming-next routes and wildcard 404 without an evidence route', async () => {
    await renderRoute('/governance')
    expect(await screen.findByRole('heading', { name: 'Governance' })).toBeVisible()
    cleanup()
    await renderRoute('/agent-estate/hr-policy-agent/evidence/evidence-hr-agent-manifest')
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible()
  })

  it('renders connector status and metadata', async () => {
    await renderRoute('/connectors')
    expect(await screen.findByRole('heading', { name: 'Connector health' })).toBeVisible()
    expect(
      await screen.findByRole('heading', { name: 'azure-ai-foundry-agent-service' }),
    ).toBeVisible()
    expect(await screen.findByText('Project endpoint')).toBeVisible()
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
