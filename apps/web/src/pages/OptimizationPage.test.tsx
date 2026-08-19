/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import type { ExposureFinding, ExposurePage } from '@agent-sentinel/domain'

import { exposureApi } from '../api/exposure-api'
import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { testState } from '../test-fixture'
import { OptimizationPage } from './OptimizationPage'

vi.mock('../api/exposure-api')

const finding: ExposureFinding = {
  id: 'exposure-1',
  policyId: 'AS-POL-001',
  policyName: 'Unapproved external transfer or send',
  severity: 'critical',
  status: 'open',
  riskScore: 91,
  title: 'Agent can transfer data externally',
  summary: 'External transfer has no approval gate.',
  recommendation: 'Require approval before external transfer.',
  affectedAgentId: 'sales-research-agent',
  affectedAgentName: 'Sales Research Agent',
  declaredTools: ['external_send'],
  affectedNodeIds: ['sales-research-agent', 'external-send'],
  affectedEdgeIds: ['edge-external-send'],
  evidenceIds: ['evidence-sales'],
  evidenceTypes: ['declared_configuration'],
  blastRadiusCount: 1,
  blastRadiusNodeIds: ['external-send'],
  firstSeen: '2026-08-19T09:00:00.000Z',
  lastSeen: '2026-08-19T09:00:00.000Z',
  sourceMode: 'mock',
  validationStatus: 'theoretical',
  tenantId: 'tenant-demo',
  snapshotId: 'snapshot-1',
}

const exposurePage: ExposurePage = {
  findings: [
    finding,
    {
      ...finding,
      id: 'exposure-2',
      policyId: 'AS-POL-002',
      severity: 'high',
      riskScore: 76,
      recommendation: 'Restrict sensitive employee fields.',
      affectedEdgeIds: [],
    },
  ],
  total: 2,
  facets: {
    severity: { critical: 1, high: 1 },
    status: { open: 2 },
    policyId: { 'AS-POL-001': 1, 'AS-POL-002': 1 },
  },
}

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(exposureApi.list).mockResolvedValue(exposurePage)
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
        <OptimizationPage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
}

describe('OptimizationPage', () => {
  it('renders evidence-backed recommendations without fabricated telemetry', async () => {
    renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Ranking evidence-backed recommendations')
    expect(
      await screen.findByRole('heading', { name: 'Require approval before external transfer.' }),
    ).toBeVisible()
    expect(screen.getByText(/risk-score 91 finding/i)).toBeVisible()
    expect(screen.getByText('Simulation available')).toBeVisible()
    expect(screen.getByText('Review only')).toBeVisible()
    expect(screen.queryByText(/\$|cost savings|latency improvement/i)).not.toBeInTheDocument()
  })

  it('filters recommendations by priority and category', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Require approval before external transfer.' })

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter recommendations by priority' }), {
      target: { value: 'critical' },
    })
    expect(
      screen.getByRole('heading', { name: 'Require approval before external transfer.' }),
    ).toBeVisible()
    expect(
      screen.queryByRole('heading', { name: 'Restrict sensitive employee fields.' }),
    ).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter recommendations by category' }), {
      target: { value: 'evidence' },
    })
    expect(screen.getByRole('heading', { name: 'No recommendations match' })).toBeVisible()
  })

  it('renders an error and retries recommendation loading', async () => {
    vi.mocked(exposureApi.list)
      .mockRejectedValueOnce(new Error('finding service unavailable'))
      .mockResolvedValueOnce(exposurePage)
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('finding service unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(
      await screen.findByRole('heading', { name: 'Require approval before external transfer.' }),
    ).toBeVisible()
  })

  it('keeps graph-derived recommendations visible when findings fail', async () => {
    vi.mocked(exposureApi.list).mockRejectedValue(new Error('finding service unavailable'))
    const state = {
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: testState.snapshot.nodes.map((node) =>
          node.id === 'hr-policy-agent' ? { ...node, owner: undefined } : node,
        ),
      },
    }
    renderPage(state)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Finding recommendations unavailable',
    )
    expect(
      screen.getByRole('heading', { name: 'Assign an accountable owner to HR Policy Assistant' }),
    ).toBeVisible()
  })

  it('loads all paginated finding recommendations', async () => {
    vi.mocked(exposureApi.list)
      .mockResolvedValueOnce({ ...exposurePage, total: 3 })
      .mockResolvedValueOnce({
        ...exposurePage,
        findings: [
          {
            ...finding,
            id: 'exposure-3',
            severity: 'medium',
            recommendation: 'Review a third finding.',
          },
        ],
        total: 3,
      })
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Review a third finding.' })).toBeVisible()
    expect(exposureApi.list).toHaveBeenNthCalledWith(2, { page: 2, pageSize: 200 })
  })
})
