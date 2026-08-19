// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { testState } from '../test-fixture'
import { TrustCatalogPage } from './TrustCatalogPage'

afterEach(cleanup)

function renderPage() {
  const value: DemoStateValue = {
    state: testState,
    connectorStatus: {
      source: 'mock',
      connectorId: 'mock-agent-connector',
      mode: 'mock',
      writeEnabled: true,
    },
    operation: undefined,
    error: undefined,
    clearError: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <MemoryRouter>
      <DemoStateContext.Provider value={value}>
        <TrustCatalogPage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
}

describe('TrustCatalogPage', () => {
  it('renders discovered agents and MCP servers with honest metadata', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Agent, MCP, and tool catalog' })).toBeVisible()
    expect(
      screen.getByText('Discovered capabilities, not a marketplace approval system'),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'HR SharePoint MCP' })).toBeVisible()
    expect(screen.getAllByText('Not provided by source').length).toBeGreaterThan(0)
  })

  it('filters by kind and trust, and renders an empty state', () => {
    renderPage()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter catalog by type' }), {
      target: { value: 'mcp' },
    })
    expect(screen.getByRole('heading', { name: 'HR SharePoint MCP' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Sales Research Agent' })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter catalog by trust' }), {
      target: { value: 'untrusted' },
    })
    expect(screen.getByRole('heading', { name: 'No catalog items found' })).toBeVisible()
  })

  it('opens trust evidence and keeps missing source metadata explicit', async () => {
    renderPage()

    const mcpCard = screen.getByRole('heading', { name: 'HR SharePoint MCP' }).closest('article')
    expect(mcpCard).not.toBeNull()
    const trigger = screen
      .getAllByRole('button', { name: 'View trust evidence' })
      .find((button) => mcpCard?.contains(button))!
    fireEvent.click(trigger)

    expect(screen.getByRole('dialog', { name: 'HR SharePoint MCP' })).toBeVisible()
    expect(screen.getAllByText('Not provided by source').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'HR Policy Assistant' })).toHaveAttribute(
      'href',
      '/agent-estate/hr-policy-agent',
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'HR SharePoint MCP' })).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })
})
