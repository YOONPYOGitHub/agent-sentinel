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
  localStorage.clear()
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'mock',
    connectorId: 'mock-agent-estate',
    mode: 'mock',
  })
})

async function renderInventory() {
  render(
    <MemoryRouter initialEntries={['/agent-inventory']}>
      <App />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name: 'Agent inventory' })).toBeVisible()
}

describe('AgentInventoryPage', () => {
  it('renders the organization inventory with readiness and version columns', async () => {
    await renderInventory()

    expect(screen.getByText('3 of 3 agents')).toBeVisible()
    expect(screen.getByRole('columnheader', { name: 'Version' })).toBeVisible()
    expect(screen.getByRole('columnheader', { name: 'Readiness' })).toBeVisible()
  })

  it('filters independently by platform, environment, owner, and trust', async () => {
    const user = userEvent.setup()
    await renderInventory()

    const platform = screen.getByRole('combobox', { name: 'Filter agents by platform' })
    const environment = screen.getByRole('combobox', { name: 'Filter agents by environment' })
    const owner = screen.getByRole('combobox', { name: 'Filter agents by owner' })
    const trust = screen.getByRole('combobox', { name: 'Filter agents by trust' })

    await user.selectOptions(platform, 'Azure OpenAI Service')
    expect(screen.getByText('HR Policy Assistant')).toBeVisible()
    expect(screen.getByText('1 of 3 agents')).toBeVisible()

    await user.selectOptions(platform, 'All')
    await user.selectOptions(environment, 'development')
    expect(screen.getByText('Code Review Copilot')).toBeVisible()

    await user.selectOptions(environment, 'All')
    await user.selectOptions(owner, 'Sales AI Platform')
    expect(screen.getByText('Sales Research Agent')).toBeVisible()

    await user.selectOptions(owner, 'All')
    await user.selectOptions(trust, 'conditional')
    expect(screen.getByText('Sales Research Agent')).toBeVisible()
    expect(screen.getByText('1 of 3 agents')).toBeVisible()
  })

  it('searches inventory text and links to the canonical detail route', async () => {
    const user = userEvent.setup()
    await renderInventory()

    await user.type(screen.getByRole('textbox', { name: 'Filter agents by text' }), 'policy')
    await waitFor(() => expect(screen.getByText('1 of 3 agents')).toBeVisible())
    expect(screen.getByRole('link', { name: /HR Policy Assistant/ })).toHaveAttribute(
      'href',
      '/agent-inventory/hr-policy-agent',
    )
  })
})
