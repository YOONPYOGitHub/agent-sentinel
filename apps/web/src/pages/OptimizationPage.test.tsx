/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import type { ExposureFinding, ExposurePage } from '@agent-sentinel/domain'

import { exposureApi } from '../api/exposure-api'
import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { useTokenEconomics } from '../hooks/useTokenEconomics'
import { testState } from '../test-fixture'
import { OptimizationPage } from './OptimizationPage'

vi.mock('../api/exposure-api')
vi.mock('../hooks/useTokenEconomics')

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
  vi.mocked(useTokenEconomics).mockReturnValue({ status: 'loading' })
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

    expect(screen.getByText('Ranking evidence-backed recommendations…')).toBeVisible()
    expect(
      await screen.findByRole('heading', { name: 'Require approval before external transfer.' }),
    ).toBeVisible()
    expect(screen.getByText(/risk-score 91 finding/i)).toBeVisible()
    expect(screen.getByText('Simulation available')).toBeVisible()
    expect(screen.getByText('Review only')).toBeVisible()
    expect(screen.queryByText(/\$|cost savings|latency improvement/i)).not.toBeInTheDocument()
  })

  it('shows token economics section with synthetic label in mock mode', async () => {
    const mockReport = {
      reportId: 'te-abc',
      tenantId: 'tenant-demo',
      agentId: 'hr-policy-agent',
      environment: 'production',
      source: 'mock-synthetic' as const,
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-23T23:59:59.000Z',
      computedAt: '2026-08-23T23:59:59.000Z',
      status: 'ready' as const,
      coverage: {
        totalObservations: 20,
        deduplicatedObservations: 20,
        duplicatesRemoved: 0,
        successCount: 20,
        measuredSuccessCount: 20,
        inputTokenMeasuredCount: 20,
        outputTokenMeasuredCount: 20,
        totalTokenMeasuredCount: 20,
        costMeasuredCount: 20,
        costCoverage: 1,
      },
      totalInputTokens: 5200,
      totalOutputTokens: 3760,
      totalTokens: 8960,
      medianInputTokens: 260,
      medianOutputTokens: 188,
      medianTotalTokens: 448,
      measuredCostUsd: 0.44,
      medianCostUsd: 0.022,
      costPerSuccessUsd: 0.022,
      anomalies: [],
    }
    vi.mocked(useTokenEconomics).mockImplementation((agentId) =>
      agentId === 'hr-policy-agent'
        ? { status: 'done', report: mockReport }
        : { status: 'loading' },
    )
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Token Economics' })).toBeVisible()
    expect(
      screen.getAllByText('[SYNTHETIC] Mock demonstration — no live telemetry connected').length,
    ).toBeGreaterThan(0)
    expect(screen.getByText(/100% coverage/)).toBeVisible()
  })

  it('shows connector-not-connected in live mode for token economics', async () => {
    const unavailableReport = {
      reportId: 'te-unavail',
      tenantId: 'tenant-demo',
      agentId: 'hr-policy-agent',
      environment: 'unknown',
      source: 'azure-monitor-otel' as const,
      windowStart: '1970-01-01T00:00:00.000Z',
      windowEnd: '2026-08-23T12:00:00.000Z',
      computedAt: '2026-08-23T12:00:00.000Z',
      status: 'connector-not-connected' as const,
      unavailableReason: 'Runtime telemetry connector is not connected.',
    }
    vi.mocked(useTokenEconomics).mockImplementation((agentId) =>
      agentId === 'hr-policy-agent'
        ? { status: 'done', report: unavailableReport }
        : { status: 'loading' },
    )
    renderPage()
    await screen.findByRole('heading', { name: 'Token Economics' })
    expect(screen.getAllByText(/Connector not connected/i).length).toBeGreaterThan(0)
  })

  it('renders a ready live OTel report without a synthetic label', async () => {
    const readyLiveReport = {
      reportId: 'te-live',
      tenantId: 'tenant-demo',
      agentId: 'hr-policy-agent',
      environment: 'production',
      source: 'azure-monitor-otel' as const,
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-23T23:59:59.000Z',
      computedAt: '2026-08-23T23:59:59.000Z',
      status: 'ready' as const,
      baselineEvidenceId: 'te-baseline-evidence',
      observedEvidenceId: 'te-observed-evidence',
      coverage: {
        totalObservations: 20,
        deduplicatedObservations: 20,
        duplicatesRemoved: 0,
        successCount: 20,
        measuredSuccessCount: 20,
        inputTokenMeasuredCount: 20,
        outputTokenMeasuredCount: 20,
        totalTokenMeasuredCount: 20,
        costMeasuredCount: 20,
        costCoverage: 1,
      },
      totalInputTokens: 5200,
      totalOutputTokens: 3760,
      totalTokens: 8960,
      medianInputTokens: 260,
      medianOutputTokens: 188,
      medianTotalTokens: 448,
      measuredCostUsd: 0.44,
      medianCostUsd: 0.022,
      costPerSuccessUsd: 0.022,
      anomalies: [],
    }
    vi.mocked(useTokenEconomics).mockImplementation((agentId) =>
      agentId === 'hr-policy-agent'
        ? { status: 'done', report: readyLiveReport }
        : { status: 'loading' },
    )
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Token Economics' })).toBeVisible()
    const card = screen.getByRole('article', { name: 'Token economics for Hr Policy Agent' })
    expect(within(card).queryByText(/Connector not connected/i)).not.toBeInTheDocument()
    expect(within(card).queryByText(/\[SYNTHETIC\]/)).not.toBeInTheDocument()
    expect(within(card).getByText(/\$0\.4400/)).toBeVisible()
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
