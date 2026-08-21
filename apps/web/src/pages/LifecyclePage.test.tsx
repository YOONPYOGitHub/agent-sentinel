/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { salesExposureFinding, testState } from '../test-fixture'
import { LifecyclePage } from './LifecyclePage'
import { exposureApi } from '../api/exposure-api'

vi.mock('../api/exposure-api')

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(exposureApi.listAll).mockResolvedValue([])
})

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

  it('marks missing owner and version evidence as attention', async () => {
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
    // Wait for liveExposures to resolve so the exposure check counts correctly
    await waitFor(() => expect(row).toHaveTextContent('2/5'))
  })

  it('distinguishes failed validation and ignores mitigated findings as active gaps', async () => {
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
    // Wait for liveExposures to resolve so exposure check passes ([] = no active exposures)
    await waitFor(() => expect(row).toHaveTextContent('Checks complete'))
    expect(row).toHaveTextContent('5/5')
    expect(row).toHaveTextContent('1 · validated')
  })

  it('marks the exposure check as unknown and prevents complete when exposures are loading', () => {
    vi.mocked(exposureApi.listAll).mockReturnValue(new Promise<never>(() => undefined))
    renderPage()

    // Sales agent: owner + version + fresh evidence + no-exposure(unknown) + no-validation = 3/5
    // hr-policy-agent: owner + version + fresh evidence + no-exposure(unknown) + no-validation = 3/5
    const salesRow = screen.getByText('Sales Research Agent').closest('tr')
    expect(salesRow).toHaveTextContent('Needs attention')
    expect(salesRow).toHaveTextContent('3/5')
    expect(salesRow).toHaveTextContent('1 not evaluated')
  })

  it('marks attention for agent with active live exposure', () => {
    vi.mocked(exposureApi.listAll).mockResolvedValue([salesExposureFinding])
    renderPage()

    const salesRow = screen.getByText('Sales Research Agent').closest('tr')
    expect(salesRow).toHaveTextContent('Needs attention')
    // exposure check fails; sales agent: owner=true, version=true, evidence=true, exposure=false, validation=false -> 3/5
    expect(salesRow).toHaveTextContent('3/5')
  })
})
