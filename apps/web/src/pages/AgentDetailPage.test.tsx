// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import App from '../App'
import { connectorApi, demoApi } from '../api'
import { exposureApi } from '../api/exposure-api'
import { useTokenEconomics } from '../hooks/useTokenEconomics'
import { useBusinessValue } from '../hooks/useBusinessValue'
import { salesExposureFinding, testState } from '../test-fixture'

vi.mock('../api')
vi.mock('../api/exposure-api')
vi.mock('../hooks/useTokenEconomics')
vi.mock('../hooks/useBusinessValue')
afterEach(cleanup)
beforeEach(() => {
  vi.mocked(demoApi.getState).mockResolvedValue(testState)
  vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
    source: 'mock',
    connectorId: 'mock-agent-estate',
    mode: 'mock',
  })
  vi.spyOn(exposureApi, 'listAll').mockResolvedValue([])
  vi.mocked(useTokenEconomics).mockReturnValue({ status: 'loading' })
  vi.mocked(useBusinessValue).mockReturnValue({
    status: 'done',
    assessment: {
      assessmentId: 'business-value-unknown',
      tenantId: 'test',
      agentId: 'unknown',
      environment: 'unknown',
      status: 'unknown',
      reason: 'no-outcome-source-configured',
      computedAt: '2026-08-31T00:00:00.000Z',
      sourcesChecked: [],
      claims: [],
      evidence: [],
    },
  })
})

function renderDetail(agentId: string) {
  render(
    <MemoryRouter initialEntries={[`/agent-inventory/${agentId}`]}>
      <App />
    </MemoryRouter>,
  )
}

describe('AgentDetailPage', () => {
  it('shows profile, identity, data and MCP dependencies, and evidence coverage', async () => {
    renderDetail('hr-policy-agent')
    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    expect(screen.getAllByText('hr-policy-agent-prod')).toHaveLength(2)
    expect(screen.getAllByText('Azure OpenAI Service')).toHaveLength(2)
    expect(screen.getByText('12')).toBeVisible()
    expect(screen.getByText('Published')).toBeVisible()
    expect(screen.getAllByText('People & Culture').length).toBeGreaterThan(0)
    expect(screen.getAllByText('production').length).toBeGreaterThan(0)
    expect(screen.getAllByText('trusted').length).toBeGreaterThan(0)
    expect(screen.getByText('HR Policy Knowledge Base')).toBeVisible()
    expect(screen.getByText('HR SharePoint MCP')).toBeVisible()
    expect(screen.getByText(/4 evidence objects cover 3 observed relationships/)).toBeVisible()
    expect(await screen.findByText('No active findings')).toBeVisible()

    expect(
      screen
        .getAllByRole('link', { name: /Agent inventory/ })
        .some((link) => link.getAttribute('href') === '/agent-inventory'),
    ).toBe(true)
  })

  it('shows token economics section in agent detail', async () => {
    const mockReport = {
      reportId: 'te-abc',
      tenantId: 'test',
      agentId: 'hr-policy-agent',
      environment: 'production',
      source: 'mock-synthetic' as const,
      windowStart: '2026-08-01T00:00:00.000Z',
      windowEnd: '2026-08-23T23:59:59.000Z',
      computedAt: '2026-08-23T23:59:59.000Z',
      status: 'ready' as const,
      attribution: {
        status: 'sourced' as const,
        owner: { value: 'People Platform', evidenceIds: ['agent-evidence'] },
        businessUnit: { value: 'People', evidenceIds: ['agent-evidence'] },
      },
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
        exactCorrelationCount: 15,
        exactCorrelationCoverage: 0.75,
      },
      totalInputTokens: 5200,
      totalOutputTokens: 3760,
      totalTokens: 8960,
      medianTotalTokens: 448,
      measuredCostUsd: 0.44,
      medianCostUsd: 0.022,
      costPerSuccessUsd: 0.022,
      anomalies: [],
    }
    vi.mocked(useTokenEconomics).mockReturnValue({ status: 'done', report: mockReport })
    renderDetail('hr-policy-agent')
    expect(await screen.findByRole('heading', { name: 'Token economics', level: 2 })).toBeVisible()
    expect(
      screen.getByText('[SYNTHETIC] Mock demonstration — no live telemetry connected'),
    ).toBeVisible()
    expect(screen.getAllByText(/\$0\.4400/).length).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText(
        /15 of 20 observations · 75% run\/correlation coverage · matching outcome source required/,
      ),
    ).toBeVisible()
    expect(screen.getByText(/People Platform · 1 cited evidence/)).toBeVisible()
    expect(screen.getByText(/People · 1 cited evidence/)).toBeVisible()
    const costCard = screen.getByRole('heading', { name: 'Cost / Efficiency' }).closest('article')
    expect(costCard).not.toBeNull()
    expect(within(costCard!).getByText('Healthy')).toBeVisible()
    expect(within(costCard!).getByText(/\[SYNTHETIC\]/)).toBeVisible()
  })

  it('shows source-cited synthetic business outcomes without estimating value', async () => {
    vi.mocked(useBusinessValue).mockReturnValue({
      status: 'done',
      assessment: {
        assessmentId: 'business-value-1',
        tenantId: 'test',
        agentId: 'hr-policy-agent',
        environment: 'production',
        status: 'sourced',
        computedAt: '2026-08-31T00:00:00.000Z',
        sourcesChecked: ['mock-business-outcomes'],
        claims: [
          {
            id: 'outcome-1',
            outcomeName: 'Resolved policy inquiries',
            value: 18,
            unit: 'count',
            source: 'Synthetic business outcome fixture',
            sourceObjectId: 'batch-12',
            observedAt: '2026-08-30T12:00:00.000Z',
            correlation: { kind: 'agent-version', value: '12' },
            evidenceId: 'outcome-evidence-1',
            confidence: 1,
            freshness: 'recent',
            synthetic: true,
          },
        ],
        evidence: [
          {
            id: 'outcome-evidence-1',
            source: 'Synthetic business outcome fixture',
            sourceObjectId: 'batch-12',
            observedAt: '2026-08-30T12:00:00.000Z',
            freshness: 'recent',
            confidence: 1,
            evidenceTypes: ['synthetic_validation'],
            summary: 'Synthetic business outcome.',
          },
        ],
      },
    })
    renderDetail('hr-policy-agent')

    expect(await screen.findByRole('heading', { name: 'Business outcome evidence' })).toBeVisible()
    expect(screen.getByText('[SYNTHETIC] Demonstration outcome evidence only')).toBeVisible()
    expect(screen.getByText('18 Resolved policy inquiries')).toBeVisible()
    expect(screen.getByText(/Exact agent-version: 12/)).toBeVisible()
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it('keeps business value unknown without an outcome source', async () => {
    renderDetail('hr-policy-agent')
    expect(await screen.findByText('Business value unknown')).toBeVisible()
    expect(
      screen.getByText('No authoritative business outcome source is configured.'),
    ).toBeVisible()
  })

  it('shows token economics anomaly evidence in agent detail', async () => {
    vi.mocked(useTokenEconomics).mockReturnValue({
      status: 'done',
      report: {
        reportId: 'te-anomaly',
        tenantId: 'test',
        agentId: 'hr-policy-agent',
        environment: 'production',
        source: 'mock-synthetic',
        windowStart: '2026-08-01T00:00:00.000Z',
        windowEnd: '2026-08-23T23:59:59.000Z',
        computedAt: '2026-08-23T23:59:59.000Z',
        status: 'ready',
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
          exactCorrelationCount: 15,
          exactCorrelationCoverage: 0.75,
        },
        totalInputTokens: 5200,
        totalOutputTokens: 3760,
        totalTokens: 8960,
        measuredCostUsd: 0.88,
        medianCostUsd: 0.044,
        costPerSuccessUsd: 0.044,
        anomalies: [
          {
            anomalyId: 'te-anomaly-cost',
            dimension: 'cost',
            severity: 'high',
            baselineMedian: 0.022,
            observedMedian: 0.044,
            evidenceIds: ['te-baseline-evidence', 'te-observed-evidence'],
            explanation: 'Measured cost exceeded the deterministic threshold.',
          },
        ],
      },
    })
    renderDetail('hr-policy-agent')

    const list = await screen.findByRole('list', { name: 'Agent token economics anomalies' })
    expect(within(list).getByText('high')).toBeVisible()
    expect(within(list).getByText(/Measured cost exceeded/)).toBeVisible()
  })

  it('shows assurance scorecard with critical security dimension for agent with active finding', async () => {
    vi.spyOn(exposureApi, 'listAll').mockResolvedValue([salesExposureFinding])
    renderDetail('sales-research-agent')

    expect(
      await screen.findByRole('heading', { name: 'Assurance scorecard', level: 2 }),
    ).toBeVisible()
    const securityCard = screen.getByRole('heading', { name: 'Security' }).closest('article')
    expect(securityCard).not.toBeNull()
    expect(await within(securityCard!).findByText('Critical')).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Quality' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Reliability' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Cost / Efficiency' })).toBeVisible()
    expect(screen.getByText(/Azure AI Foundry Evaluation/)).toBeVisible()
    expect(
      within(securityCard!).getByRole('link', {
        name: /^Sales exposure - finding risk score 82\/100$/,
      }),
    ).toHaveAttribute('href', '/exposure/finding-1')
  })

  it('shows assurance scorecard with healthy security dimension for clean agent', async () => {
    renderDetail('hr-policy-agent')

    expect(
      await screen.findByRole('heading', { name: 'Assurance scorecard', level: 2 }),
    ).toBeVisible()
    const securityCard = screen.getByRole('heading', { name: 'Security' }).closest('article')
    expect(securityCard).not.toBeNull()
    expect(await within(securityCard!).findByText('Healthy')).toBeVisible()
    expect(
      within(securityCard!).getByText(
        'No active exposures in connected evidence affect this agent.',
      ),
    ).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Quality' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Reliability' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'Cost / Efficiency' })).toBeVisible()
  })

  it('shows unknown security while live exposures are loading', async () => {
    vi.spyOn(exposureApi, 'listAll').mockReturnValue(new Promise<never>(() => undefined))
    renderDetail('sales-research-agent')

    expect(
      await screen.findByRole('heading', { name: 'Assurance scorecard', level: 2 }),
    ).toBeVisible()
    const securityCard = screen.getByRole('heading', { name: 'Security' }).closest('article')!
    expect(within(securityCard).getByText('Unknown')).toBeVisible()
    expect(within(securityCard).getByText(/Live exposure evidence is loading/)).toBeVisible()
    expect(within(securityCard).queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows unknown security when live exposures fail to load', async () => {
    vi.spyOn(exposureApi, 'listAll').mockRejectedValue(new Error('offline'))
    renderDetail('sales-research-agent')

    const explanation = await screen.findByText(
      'Live exposure data could not be loaded, so the security posture is unknown. Check connector health.',
    )
    const securityCard = screen.getByRole('heading', { name: 'Security' }).closest('article')!
    expect(explanation).toBeVisible()
    expect(within(securityCard).getByText('Unknown')).toBeVisible()
    expect(within(securityCard).queryByRole('link')).not.toBeInTheDocument()
  })

  it('shows live finding linkage with direct link to exposure detail', async () => {
    vi.spyOn(exposureApi, 'listAll').mockResolvedValue([salesExposureFinding])
    renderDetail('sales-research-agent')
    expect(await screen.findByText('Sales exposure')).toBeVisible()

    expect(screen.getByRole('link', { name: 'View finding detail' })).toHaveAttribute(
      'href',
      '/exposure/finding-1',
    )
  })

  it('opens accessible evidence drawer and closes on Escape', async () => {
    const user = userEvent.setup()
    renderDetail('sales-research-agent')
    expect(await screen.findByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Copilot Studio/ }))
    expect(screen.getByRole('dialog', { name: 'Copilot Studio' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('labels runtime evidence from its explicit type instead of the source name', async () => {
    const runtimeEvidence = {
      id: 'runtime-evidence',
      source: 'Custom telemetry source',
      sourceObjectId: 'window-1',
      observedAt: '2026-08-29T12:00:00.000Z',
      freshness: 'live' as const,
      confidence: 1,
      evidenceTypes: ['observed_runtime' as const],
      summary: 'Measured runtime invocation evidence.',
    }
    const nodes = testState.snapshot.nodes.map((node) =>
      node.id === 'hr-policy-agent'
        ? { ...node, evidenceIds: [...node.evidenceIds, runtimeEvidence.id] }
        : node,
    )
    vi.mocked(demoApi.getState).mockResolvedValue({
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes,
        evidence: [...testState.snapshot.evidence, runtimeEvidence],
      },
    })

    renderDetail('hr-policy-agent')

    expect(await screen.findByText(/Observed runtime · live · 100% confidence/)).toBeVisible()
  })

  it('shows Unknown header badge while live exposures are loading', async () => {
    vi.spyOn(exposureApi, 'listAll').mockReturnValue(new Promise<never>(() => undefined))
    renderDetail('hr-policy-agent')

    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    const heading = screen.getByRole('heading', { name: 'HR Policy Assistant' }).closest('section')!
    expect(within(heading).getByText('Unknown')).toBeVisible()
  })

  it('shows Healthy header badge after clean exposure load', async () => {
    renderDetail('hr-policy-agent')

    expect(await screen.findByRole('heading', { name: 'HR Policy Assistant' })).toBeVisible()
    const heading = screen.getByRole('heading', { name: 'HR Policy Assistant' }).closest('section')!
    expect(await within(heading).findByText('Healthy')).toBeVisible()
  })

  it('shows Critical header badge for agent with critical live exposure', async () => {
    vi.spyOn(exposureApi, 'listAll').mockResolvedValue([salesExposureFinding])
    renderDetail('sales-research-agent')

    expect(await screen.findByRole('heading', { name: 'Sales Research Agent' })).toBeVisible()
    const heading = screen
      .getByRole('heading', { name: 'Sales Research Agent' })
      .closest('section')!
    expect(await within(heading).findByText('Critical')).toBeVisible()
  })

  it('shows loading state in finding linkage while exposures are loading', async () => {
    vi.spyOn(exposureApi, 'listAll').mockReturnValue(new Promise<never>(() => undefined))
    renderDetail('sales-research-agent')

    expect(await screen.findByRole('heading', { name: 'Finding linkage' })).toBeVisible()
    expect(screen.getByText(/Loading exposure data/)).toBeVisible()
  })

  it('shows error state in finding linkage when exposures fail to load', async () => {
    vi.spyOn(exposureApi, 'listAll').mockRejectedValue(new Error('offline'))
    renderDetail('sales-research-agent')

    expect(await screen.findByText(/Exposure data could not be loaded/)).toBeVisible()
  })

  it('discards stale exposure results when the agent component is remounted', async () => {
    // First exposure load is slow (never resolves in this test)
    vi.spyOn(exposureApi, 'listAll').mockReturnValue(new Promise<never>(() => undefined))
    const { unmount } = render(
      <MemoryRouter initialEntries={['/agent-inventory/sales-research-agent']}>
        <App />
      </MemoryRouter>,
    )
    // Sales agent header shows Unknown while loading
    await screen.findByRole('heading', { name: 'Sales Research Agent' })
    const salesSection = screen
      .getByRole('heading', { name: 'Sales Research Agent' })
      .closest('section')!
    expect(within(salesSection).getByText('Unknown')).toBeVisible()

    // Unmount (simulates leaving the route) and remount for a different agent
    unmount()
    vi.spyOn(exposureApi, 'listAll').mockResolvedValue([])
    render(
      <MemoryRouter initialEntries={['/agent-inventory/hr-policy-agent']}>
        <App />
      </MemoryRouter>,
    )
    // New agent gets a fresh load - should show Healthy once resolved
    await screen.findByRole('heading', { name: 'HR Policy Assistant' })
    const hrSection = screen
      .getByRole('heading', { name: 'HR Policy Assistant' })
      .closest('section')!
    expect(await within(hrSection).findByText('Healthy')).toBeVisible()
  })

  it('renders a useful state for an unknown direct link', async () => {
    renderDetail('missing-agent')
    expect(await screen.findByRole('heading', { name: 'Agent not found' })).toBeVisible()
  })
})
