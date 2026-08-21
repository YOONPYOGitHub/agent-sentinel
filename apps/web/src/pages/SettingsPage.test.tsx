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
})
