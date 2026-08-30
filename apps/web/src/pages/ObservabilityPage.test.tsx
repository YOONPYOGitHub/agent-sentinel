// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { useAgentDrift } from '../hooks/useAgentDrift'
import { testState } from '../test-fixture'
import { ObservabilityPage } from './ObservabilityPage'

vi.mock('../hooks/useAgentDrift')

beforeEach(() => {
  vi.mocked(useAgentDrift).mockReturnValue(null)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPage(overrides: Partial<DemoStateValue> = {}) {
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
    ...overrides,
  }
  render(
    <MemoryRouter>
      <DemoStateContext.Provider value={value}>
        <ObservabilityPage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
  return value
}

describe('ObservabilityPage', () => {
  it('renders evidence freshness, confidence, and source coverage', () => {
    renderPage()

    expect(screen.getByRole('heading', { name: 'Evidence operations' })).toBeVisible()
    expect(screen.getByText('Evidence observability, not runtime APM')).toBeVisible()
    expect(screen.getByText('10')).toBeVisible()
    expect(screen.getByText('100%')).toBeVisible()
    expect(screen.getByText('No validation run recorded')).toBeVisible()
    expect(screen.getByText('Copilot Studio')).toBeVisible()
    expect(screen.getByText('Latest evidence observed')).toBeVisible()
  })

  it('reports safe validation activity without inventing runtime metrics', () => {
    renderPage({
      state: {
        ...testState,
        validations: [
          {
            id: 'validation-1',
            findingId: 'finding-1',
            status: 'validated',
            startedAt: '2026-08-19T09:00:00.000Z',
            completedAt: '2026-08-19T09:01:00.000Z',
            syntheticCanary: 'synthetic-canary',
            observedAtTarget: true,
            trace: ['Canary reached the simulated external endpoint.'],
          },
        ],
      },
    })

    expect(screen.getByText('Safe validation validated')).toBeVisible()
    expect(screen.getByText('Canary reached the simulated external endpoint.')).toBeVisible()
    expect(screen.queryByText(/p95 latency/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/uptime/i)).not.toBeInTheDocument()
  })

  it('shows unavailable states when no evidence exists', () => {
    renderPage({
      state: {
        ...testState,
        snapshot: { ...testState.snapshot, evidence: [] },
      },
    })

    expect(screen.getAllByText('No evidence available').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Unavailable')).toHaveLength(2)
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('does not render failed validation activity as success', () => {
    renderPage({
      state: {
        ...testState,
        validations: [
          {
            id: 'validation-failed',
            findingId: 'finding-1',
            status: 'failed',
            startedAt: '2026-08-19T09:00:00.000Z',
            completedAt: '2026-08-19T09:01:00.000Z',
            syntheticCanary: 'synthetic-canary',
            trace: ['Validation stopped before reaching the target.'],
          },
          {
            id: 'validation-older-success',
            findingId: 'finding-1',
            status: 'validated',
            startedAt: '2026-08-18T09:00:00.000Z',
            completedAt: '2026-08-18T09:01:00.000Z',
            syntheticCanary: 'older-synthetic-canary',
            observedAtTarget: true,
            trace: ['Older validation succeeded.'],
          },
        ],
      },
    })

    expect(screen.getByText('Latest validation did not confirm the finding')).toBeVisible()
    expect(screen.getByText('Safe validation failed')).toBeVisible()
    expect(screen.getByText('Validation stopped before reaching the target.')).toBeVisible()
  })

  it('does not invent a validation trace when none was captured', () => {
    renderPage({
      state: {
        ...testState,
        validations: [
          {
            id: 'validation-running',
            findingId: 'finding-1',
            status: 'running',
            startedAt: '2026-08-19T09:00:00.000Z',
            syntheticCanary: 'synthetic-canary',
            trace: [],
          },
        ],
      },
    })

    expect(screen.getByText('No validation trace available.')).toBeVisible()
    expect(screen.queryByText('Synthetic trace captured.')).not.toBeInTheDocument()
  })

  it('warns when refresh fails while retaining last-known evidence', () => {
    const value = renderPage({ error: 'connector timeout' })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Operational warning; showing last-known evidence',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('connector timeout')
    expect(screen.getByText('Copilot Studio')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(value.clearError).toHaveBeenCalled()
  })

  it('queries drift for authoritative snapshot agents instead of fixed mock ids', () => {
    const liveAgent = {
      ...testState.snapshot.nodes.find((node) => node.id === 'hr-policy-agent')!,
      id: 'foundry-primary--agent-provider-id',
      name: 'Live Foundry Agent',
    }
    renderPage({
      state: {
        ...testState,
        snapshot: {
          ...testState.snapshot,
          nodes: [liveAgent],
        },
      },
      connectorStatus: {
        source: 'foundry',
        connectorId: 'azure-ai-foundry-agent-service',
        mode: 'foundry',
        writeEnabled: false,
      },
    })

    expect(useAgentDrift).toHaveBeenCalledWith('foundry-primary--agent-provider-id')
    expect(useAgentDrift).not.toHaveBeenCalledWith('hr-policy-agent')
    expect(screen.getByText('Live telemetry evaluation')).toBeVisible()
  })

  it('reports explicit runtime, synthetic, and unclassified evidence coverage', () => {
    renderPage({
      state: {
        ...testState,
        runtimeEvidence: {
          status: 'partial',
          queriedAt: '2026-08-30T01:00:00.000Z',
          agentCount: 3,
          eligibleAgentCount: 2,
          queriedAgentCount: 1,
          enrichedAgentCount: 1,
          evidenceCount: 1,
          failures: [{ agentId: 'agent-2', reason: 'query-failed' }],
        },
        manifestRuntimeVerification: {
          status: 'partial',
          checkedAt: '2026-08-30T01:00:00.000Z',
          counts: {
            verified: 1,
            noObservation: 1,
            ambiguous: 0,
            notCorrelatable: 1,
            unavailable: 0,
          },
          claims: [],
        },
        manifestConfigurationReconciliation: {
          status: 'partial',
          checkedAt: '2026-08-30T01:00:00.000Z',
          counts: {
            matched: 2,
            ambiguous: 1,
            notCorrelatable: 1,
            valueMatched: 3,
            valueMismatched: 1,
            valueUnavailable: 1,
            freeFormUnverified: 2,
          },
          claims: [],
        },
        snapshot: {
          ...testState.snapshot,
          evidence: [
            ...testState.snapshot.evidence,
            {
              id: 'runtime-evidence',
              source: 'Azure Monitor OpenTelemetry',
              sourceObjectId: 'window-1',
              observedAt: '2026-08-30T00:30:00.000Z',
              freshness: 'live',
              confidence: 1,
              evidenceTypes: ['observed_runtime'],
              summary: 'Measured runtime invocation.',
            },
            {
              id: 'synthetic-evidence',
              source: 'Azure Monitor OpenTelemetry',
              sourceObjectId: 'window-2',
              observedAt: '2026-08-30T00:45:00.000Z',
              freshness: 'live',
              confidence: 1,
              evidenceTypes: ['synthetic_validation'],
              summary: 'Measured synthetic canary.',
            },
          ],
        },
      },
    })

    expect(screen.getByText('Runtime evidence')).toBeVisible()
    expect(screen.getByText(/partial · 10 declared · 1 synthetic · 0 unclassified/)).toBeVisible()
    expect(screen.getByText(/Observed runtime · Synthetic validation/)).toBeVisible()
    expect(screen.getByText('Manifest runtime claims')).toBeVisible()
    expect(
      screen.getByText(/partial · 1 not observed · 0 ambiguous · 1 not correlatable/),
    ).toBeVisible()
    expect(screen.getByText('Manifest typed values')).toBeVisible()
    expect(
      screen.getByText(
        /partial · 2 objects matched · 1 values mismatched · 1 values unavailable · 2 free-form unverified · 1 ambiguous · 1 not correlatable/,
      ),
    ).toBeVisible()
  })

  it('shows why manifest verification is unavailable', () => {
    renderPage({
      state: {
        ...testState,
        manifestRuntimeVerification: {
          status: 'unavailable',
          reason: 'source-limit-exceeded',
          checkedAt: '2026-08-30T01:00:00.000Z',
          counts: {
            verified: 0,
            noObservation: 0,
            ambiguous: 0,
            notCorrelatable: 0,
            unavailable: 0,
          },
          claims: [],
        },
      },
    })

    expect(screen.getByText(/unavailable \(source-limit-exceeded\)/)).toBeVisible()
  })
})
