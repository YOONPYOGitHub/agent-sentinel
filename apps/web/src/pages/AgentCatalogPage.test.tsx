// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import { demoApi } from '../api'

vi.mock('../api')
const employeeCatalogGet = vi.hoisted(() => vi.fn())
vi.mock('../api/employee-catalog-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  employeeCatalogApi: { get: employeeCatalogGet },
}))

afterEach(cleanup)

beforeEach(() => {
  employeeCatalogGet.mockReset()
  vi.mocked(demoApi.getState).mockReset()
})

function renderEmployeeCatalog(path = '/agent-catalog') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
}

describe('AgentCatalogPage', () => {
  it('renders only the agents returned by the personalized endpoint', async () => {
    employeeCatalogGet.mockResolvedValue({
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

    renderEmployeeCatalog()

    expect(await screen.findByRole('heading', { name: 'Agents available to you' })).toBeVisible()
    expect(await screen.findByRole('heading', { name: 'Payroll assistant' })).toBeVisible()
    expect(screen.getByText('1 available agent')).toBeVisible()
    expect(screen.queryByText(/hidden-agent|legal investigation/i)).not.toBeInTheDocument()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('fails closed without rendering inventory or evidence diagnostics', async () => {
    employeeCatalogGet.mockResolvedValue({
      status: 'unknown',
      reason: 'ambiguous-evidence',
      agents: [],
    })

    renderEmployeeCatalog()

    expect(
      await screen.findByRole('heading', { name: 'Agent access cannot be confirmed' }),
    ).toBeVisible()
    expect(screen.getByText(/shows no agents/i)).toBeVisible()
    expect(screen.queryByText('ambiguous-evidence')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Personalized agent catalog')).not.toBeInTheDocument()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('labels synthetic fixtures as preview data rather than authoritative access', async () => {
    employeeCatalogGet.mockResolvedValue({
      status: 'mock',
      synthetic: true,
      agents: [
        {
          id: 'fixture-agent',
          name: 'Fixture assistant',
          description: 'Synthetic preview record.',
        },
      ],
    })

    renderEmployeeCatalog()

    expect(await screen.findByRole('heading', { name: 'Fixture assistant' })).toBeVisible()
    expect(screen.getByText('Synthetic preview')).toBeVisible()
    expect(screen.getByText(/not evidence of access/i)).toBeVisible()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('does not substitute operational inventory when the request fails', async () => {
    employeeCatalogGet.mockRejectedValue(new Error('request failed'))

    renderEmployeeCatalog()

    expect(
      await screen.findByRole('heading', { name: 'Personalized catalog unavailable' }),
    ).toBeVisible()
    expect(screen.getByText(/No agent inventory is shown/i)).toBeVisible()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })

  it('keeps a trailing-slash employee route outside the operational state provider', async () => {
    employeeCatalogGet.mockResolvedValue({
      status: 'denied',
      authority: 'microsoft-agent-365',
      observedAt: '2026-09-14T06:00:00.000Z',
      agents: [],
    })

    renderEmployeeCatalog('/agent-catalog/')

    expect(
      await screen.findByRole('heading', { name: 'No agents are available to you' }),
    ).toBeVisible()
    expect(demoApi.getState).not.toHaveBeenCalled()
  })
})
