// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

async function renderEstate() {
  render(
    <MemoryRouter initialEntries={['/agent-inventory']}>
      <App />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name: 'Agent inventory' })).toBeVisible()
}

describe('AgentInventoryPage legacy coverage', () => {
  it('filters independently by platform, environment, owner, and trust', async () => {
    const user = userEvent.setup()
    await renderEstate()
    expect(screen.getByText('3 of 3 agents')).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter agents by platform' }),
      'Azure OpenAI Service',
    )
    expect(screen.getByText('HR Policy Assistant')).toBeVisible()
    expect(screen.getByText('1 of 3 agents')).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter agents by environment' }),
      'development',
    )
    expect(screen.getByText('0 of 3 agents')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'No agents match these filters' })).toBeVisible()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter agents by platform' }),
      'All',
    )
    expect(screen.getByText('Code Review Copilot')).toBeVisible()
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter agents by owner' }),
      'Engineering Platform',
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter agents by trust' }),
      'trusted',
    )
    expect(screen.getByText('1 of 3 agents')).toBeVisible()
  })

  it('supports text search and links each result to its detail route', async () => {
    const user = userEvent.setup()
    await renderEstate()
    await user.type(screen.getByRole('textbox', { name: 'Filter agents by text' }), 'policy')
    const link = screen.getByRole('link', { name: /HR Policy Assistant/ })
    expect(link).toHaveAttribute('href', '/agent-inventory/hr-policy-agent')
    await waitFor(() => expect(screen.getByText('1 of 3 agents')).toBeVisible())
  })

  it('labels a Foundry endpoint as declared configuration', async () => {
    vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
      source: 'foundry',
      connectorId: 'azure-ai-foundry-agent-service',
      mode: 'foundry',
      projectEndpoint: 'https://example.services.ai.azure.com/api/projects/example',
    })
    await renderEstate()
    expect(screen.getByText('Declared configuration:')).toBeVisible()
  })
})
