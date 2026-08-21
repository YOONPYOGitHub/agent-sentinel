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

async function renderCatalog() {
  render(
    <MemoryRouter initialEntries={['/agent-catalog']}>
      <App />
    </MemoryRouter>,
  )
  expect(await screen.findByRole('heading', { name: 'Agent assurance catalog' })).toBeVisible()
}

describe('AgentCatalogPage', () => {
  it('renders the employee catalog with the Entra boundary and discovered agents', async () => {
    await renderCatalog()

    expect(screen.getByText('Entra ID not connected.')).toBeVisible()
    expect(screen.getByText('This is not a replacement agent store.')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    expect(screen.getByText('3 of 3 agents')).toBeVisible()
  })

  it('filters by availability', async () => {
    const user = userEvent.setup()
    await renderCatalog()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by availability' }),
      'Restricted',
    )
    expect(screen.getByRole('heading', { name: 'Code Review Copilot' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sales Research Agent' })).not.toBeInTheDocument()
    expect(screen.getByText('1 of 3 agents')).toBeVisible()
  })

  it('searches by agent name, owner, and platform', async () => {
    const user = userEvent.setup()
    await renderCatalog()

    await user.type(screen.getByRole('textbox', { name: 'Search agent catalog' }), 'People')
    await waitFor(() => expect(screen.getByText('1 of 3 agents')).toBeVisible())
    expect(screen.getByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sales Research Agent' })).not.toBeInTheDocument()
  })
})
