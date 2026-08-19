// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { testState } from '../test-fixture'
import { LifecyclePage } from './LifecyclePage'

afterEach(cleanup)

function renderPage(state = testState) {
  const value: DemoStateValue = {
    state,
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
        <LifecyclePage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
}

describe('LifecyclePage', () => {
  it('renders current version evidence without inventing lineage', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Lifecycle evidence' })).toBeVisible()
    expect(
      screen.getByText('Current-version evidence, not full release orchestration'),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Agent readiness evidence' })).toBeVisible()
    expect(screen.getByText('Sales Research Agent')).toBeVisible()
    expect(screen.getByText('17')).toBeVisible()
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(0)
    expect(screen.queryByText(/promoted by/i)).not.toBeInTheDocument()
  })

  it('filters lifecycle evidence by environment and readiness', () => {
    renderPage()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter lifecycle by environment' }), {
      target: { value: 'production' },
    })
    expect(screen.getByText('HR Policy Assistant')).toBeVisible()
    expect(screen.queryByText('Sales Research Agent')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter lifecycle by readiness' }), {
      target: { value: 'attention' },
    })
    expect(screen.getByText('HR Policy Assistant')).toBeVisible()
  })

  it('marks missing owner and version evidence as attention', () => {
    const incomplete = {
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: testState.snapshot.nodes.map((node) =>
          node.id === 'hr-policy-agent'
            ? { ...node, owner: undefined, metadata: { ...node.metadata, version: '' } }
            : node,
        ),
      },
    }
    renderPage(incomplete)

    const row = screen.getByText('HR Policy Assistant').closest('tr')
    expect(row).toHaveTextContent('Unassigned')
    expect(row).toHaveTextContent('Needs attention')
    expect(row).toHaveTextContent('2/5')
  })

  it('distinguishes failed validation and ignores mitigated findings as active gaps', () => {
    const state = {
      ...testState,
      findings: testState.findings.map((finding) => ({
        ...finding,
        path: { ...finding.path, status: 'mitigated' as const },
      })),
      validations: [
        {
          id: 'validation-1',
          findingId: 'finding-1',
          status: 'validated' as const,
          startedAt: '2026-08-19T09:00:00.000Z',
          completedAt: '2026-08-19T09:01:00.000Z',
          syntheticCanary: 'synthetic-canary',
          observedAtTarget: true,
          trace: ['Synthetic canary observed.'],
        },
      ],
    }
    renderPage(state)

    const row = screen.getByText('Sales Research Agent').closest('tr')
    expect(row).toHaveTextContent('Checks complete')
    expect(row).toHaveTextContent('5/5')
    expect(row).toHaveTextContent('1 · validated')
  })
})
