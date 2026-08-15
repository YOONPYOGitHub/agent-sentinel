// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import { connectorApi, demoApi } from '../api'
import { testState } from '../test-fixture'

vi.mock('../api')
afterEach(cleanup)
beforeEach(() => {
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'mock',
    connectorId: 'mock-agent-estate',
    mode: 'mock',
  })
})

function renderDetail(agentId: string) {
  render(
    <MemoryRouter initialEntries={[`/agent-estate/${agentId}`]}>
      <App />
    </MemoryRouter>,
  )
}

describe('AgentDetailPage', () => {
  it('shows profile, identity, data and MCP dependencies, and evidence coverage', async () => {
    renderDetail('hr-policy-agent')
    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    expect(screen.getAllByText('hr-policy-agent-prod')).toHaveLength(2)
    expect(screen.getAllByText('Azure OpenAI Service')).toHaveLength(2)
    expect(screen.getByText('12')).toBeVisible()
    expect(screen.getByText('Published')).toBeVisible()
    expect(screen.getAllByText('People & Culture').length).toBeGreaterThan(0)
    expect(screen.getAllByText('production').length).toBeGreaterThan(0)
    expect(screen.getAllByText('trusted').length).toBeGreaterThan(0)
    expect(screen.getByText('HR Policy Knowledge Base')).toBeVisible()
    expect(screen.getByText('HR SharePoint MCP')).toBeVisible()
    expect(screen.getByText(/4 evidence objects cover 3 observed relationships/)).toBeVisible()
    expect(screen.getByText('No active findings')).toBeVisible()
    expect(
      screen
        .getAllByRole('link', { name: /Agent estate/ })
        .some((link) => link.getAttribute('href') === '/agent-estate'),
    ).toBe(true)
  })

  it('opens accessible evidence and links an affected agent to its finding', async () => {
    const user = userEvent.setup()
    renderDetail('sales-research-agent')
    expect(await screen.findByText('Sales exposure')).toBeVisible()
    expect(screen.getByRole('link', { name: 'View finding in overview' })).toHaveAttribute(
      'href',
      '/overview',
    )
    await user.click(screen.getByRole('button', { name: /Copilot Studio/ }))
    expect(screen.getByRole('dialog', { name: 'Copilot Studio' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders a useful state for an unknown direct link', async () => {
    renderDetail('missing-agent')
    expect(await screen.findByRole('heading', { name: 'Agent not found' })).toBeVisible()
  })
})
