/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'

import type { ExposureFinding, ExposurePage as ExposurePageDto } from '@agent-sentinel/domain'

import { ExposurePage } from './ExposurePage'
import { ExposureDetailPage } from './ExposureDetailPage'
import { exposureApi } from '../api/exposure-api'
import { AuthContext, type AuthContextValue } from '../hooks/AuthContext'

const disabledAuth: AuthContextValue = {
  isConfigured: false,
  spaConfig: null,
  isLoading: false,
  isSignedIn: false,
  principal: null,
  authError: null,
  signIn: () => Promise.resolve({ status: 'success' }),
  signOut: () => Promise.resolve(),
  getAccessToken: () => Promise.resolve(null),
}

vi.mock('../api/exposure-api')
vi.mock('../components/ExposureGraph', () => ({
  ExposureGraph: ({ title, pathStatus }: { title: string; pathStatus: string }) => (
    <div data-testid="exposure-graph">{`${title}:${pathStatus}`}</div>
  ),
}))

const sampleFinding: ExposureFinding = {
  id: 'exposure-as-pol-001-agent-1',
  policyId: 'AS-POL-001',
  policyName: 'Unapproved external transfer or send',
  severity: 'critical',
  status: 'open',
  riskScore: 91,
  title: 'Agent one can transfer data externally',
  summary: 'Summary text',
  recommendation: 'Require approval before external send.',
  affectedAgentId: 'foundry-agent-agent-1',
  affectedAgentName: 'Agent One',
  declaredTools: ['external_send'],
  affectedNodeIds: ['foundry-agent-agent-1'],
  affectedEdgeIds: ['edge'],
  evidenceIds: ['ev-1'],
  evidenceTypes: ['declared_configuration'],
  blastRadiusCount: 3,
  blastRadiusNodeIds: ['n1', 'n2', 'n3'],
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
  sourceMode: 'mock',
  validationStatus: 'theoretical',
  tenantId: 'tenant-demo',
  snapshotId: 'snap-1',
}

const samplePage: ExposurePageDto = {
  findings: [sampleFinding],
  total: 1,
  facets: { severity: { critical: 1 }, status: { open: 1 }, policyId: { 'AS-POL-001': 1 } },
  freshness: {
    snapshotId: 'snap-1',
    generatedAt: new Date().toISOString(),
    sourceMode: 'mock',
    agentCount: 6,
  },
}

const sampleGraph = {
  tenantId: 'tenant-demo',
  environment: 'validation',
  generatedAt: new Date().toISOString(),
  nodes: [
    {
      id: sampleFinding.affectedAgentId,
      kind: 'agent' as const,
      name: sampleFinding.affectedAgentName,
      description: 'Synthetic agent',
      environment: 'validation',
      evidenceIds: ['ev-1'],
      metadata: {},
    },
  ],
  edges: [],
  evidence: [
    {
      id: 'ev-1',
      source: 'Synthetic connector',
      sourceObjectId: sampleFinding.affectedAgentId,
      observedAt: new Date().toISOString(),
      freshness: 'live' as const,
      confidence: 1,
      evidenceTypes: ['synthetic_validation' as const],
      summary: 'Synthetic evidence',
    },
  ],
}

const samplePreview = {
  findingId: sampleFinding.id,
  actionId: `preview-block-route-${sampleFinding.id}`,
  actionType: 'block-route' as const,
  title: 'Block route to External send',
  description: 'Simulate a Sentinel policy-layer route block.',
  targetEdgeIds: ['edge'],
  simulationOnly: true as const,
  before: { riskScore: 91, blastRadiusCount: 3 },
  after: { riskScore: 0, blastRadiusCount: 2 },
  impact: {
    riskReduction: 91,
    blastRadiusReduction: 1,
    businessDisruption: 'unknown' as const,
    workflowImpact: 'unknown' as const,
    rollbackAvailable: true,
  },
  residualFindings: [],
  residualRoutes: [],
  uncertainty: [],
  beforeGraph: sampleGraph,
  afterGraph: sampleGraph,
}

const sampleNarrative = {
  findingId: sampleFinding.id,
  model: 'gpt-5.6-terra',
  generatedAt: new Date().toISOString(),
  summary: 'Evidence-grounded summary.',
  attackPathExplanation: 'Evidence-grounded attack path.',
  impactExplanation: 'Evidence-grounded impact.',
  recommendationExplanation: 'Evidence-grounded recommendation.',
  sectionCitations: {
    summary: ['ev-1'],
    attackPathExplanation: ['ev-1'],
    impactExplanation: ['ev-1'],
    recommendationExplanation: ['ev-1'],
    uncertainty: ['ev-1'],
  },
  uncertainty: ['Runtime behavior is not observed.'],
  citations: [{ evidenceId: 'ev-1', claim: 'Declared configuration supports this claim.' }],
  advisoryOnly: true as const,
}

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(exposureApi.list).mockResolvedValue(samplePage)
  vi.mocked(exposureApi.get).mockResolvedValue(sampleFinding)
  vi.mocked(exposureApi.getGraph).mockResolvedValue(sampleGraph)
  vi.mocked(exposureApi.getRemediationPreview).mockResolvedValue(samplePreview)
  vi.mocked(exposureApi.generateNarrative).mockResolvedValue(sampleNarrative)
})

describe('ExposurePage', () => {
  it('renders KPIs and the finding row', async () => {
    render(
      <MemoryRouter>
        <ExposurePage />
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText('Agent one can transfer data externally')).toBeInTheDocument(),
    )
    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0)
    expect(screen.getByText('Affected agents')).toBeInTheDocument()
  })

  it('shows a loading state before data arrives', () => {
    vi.mocked(exposureApi.list).mockImplementation(() => new Promise(() => undefined))
    render(
      <MemoryRouter>
        <ExposurePage />
      </MemoryRouter>,
    )
    expect(screen.getByTestId('exposure-loading')).toBeInTheDocument()
  })

  it('renders an empty state when there are no findings', async () => {
    vi.mocked(exposureApi.list).mockResolvedValue({
      findings: [],
      total: 0,
      facets: { severity: {}, status: {}, policyId: {} },
      freshness: samplePage.freshness,
    })
    render(
      <MemoryRouter>
        <ExposurePage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('No exposures found')).toBeInTheDocument())
  })

  it('renders an error state when the API fails', async () => {
    vi.mocked(exposureApi.list).mockRejectedValue(new Error('boom'))
    render(
      <MemoryRouter>
        <ExposurePage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Unable to load exposures')).toBeInTheDocument())
  })

  it('filters by severity via the select', async () => {
    render(
      <MemoryRouter>
        <ExposurePage />
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByLabelText('Refresh exposures')).toBeInTheDocument())
    const severitySelect = screen.getByRole('combobox', { name: /severity/i })
    fireEvent.change(severitySelect, { target: { value: 'high' } })
    await waitFor(() =>
      expect(vi.mocked(exposureApi.list)).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'high' }),
      ),
    )
  })

  it('applies a policy filter from the deep-link query string', async () => {
    render(
      <MemoryRouter initialEntries={['/exposure?policyId=AS-POL-001']}>
        <ExposurePage />
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(vi.mocked(exposureApi.list)).toHaveBeenCalledWith(
        expect.objectContaining({ policyId: 'AS-POL-001' }),
      ),
    )
    expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveValue('AS-POL-001')
  })
})

describe('ExposureDetailPage', () => {
  it('renders the finding detail', async () => {
    render(
      <AuthContext.Provider value={disabledAuth}>
        <MemoryRouter initialEntries={[`/exposure/${sampleFinding.id}`]}>
          <Routes>
            <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Agent one can transfer data externally' }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('Recommendation')).toBeInTheDocument()
    expect(screen.getByTestId('exposure-graph')).toHaveTextContent(
      `${sampleFinding.title}:theoretical`,
    )
    expect(exposureApi.getGraph).toHaveBeenCalledWith(sampleFinding.id)
  })

  it('previews remediation impact and compares the after graph', async () => {
    render(
      <AuthContext.Provider value={disabledAuth}>
        <MemoryRouter initialEntries={[`/exposure/${sampleFinding.id}`]}>
          <Routes>
            <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    await waitFor(() => expect(screen.getByText('Preview response')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Preview response' }))

    await waitFor(() => expect(screen.getByText('Simulation only')).toBeInTheDocument())
    expect(screen.getByText('91 → 0')).toBeInTheDocument()
    expect(screen.getByText('Workflow preservation unverified')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'After remediation' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByTestId('exposure-graph')).toHaveTextContent(
      `${sampleFinding.title}:mitigated`,
    )
    expect(exposureApi.getRemediationPreview).toHaveBeenCalledWith(sampleFinding.id)
  })

  it('generates an advisory narrative and opens cited evidence', async () => {
    render(
      <AuthContext.Provider value={disabledAuth}>
        <MemoryRouter initialEntries={[`/exposure/${sampleFinding.id}`]}>
          <Routes>
            <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    await waitFor(() => expect(screen.getByText('Generate AI narrative')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI narrative' }))

    expect(
      await screen.findByRole('heading', { name: 'Evidence-grounded incident narrative' }),
    ).toBeVisible()
    expect(screen.getByText('gpt-5.6-terra')).toBeVisible()
    expect(
      screen.getByText(/Deterministic policies and graph calculations remain authoritative/i),
    ).toBeVisible()
    const citationButton = screen.getByLabelText('Summary citations').querySelector('button')
    expect(citationButton).not.toBeNull()
    fireEvent.click(citationButton!)
    expect(await screen.findByRole('dialog', { name: 'Synthetic connector' })).toBeVisible()
  })

  it('renders finding details while the attack path is still loading', async () => {
    vi.mocked(exposureApi.getGraph).mockImplementation(() => new Promise(() => undefined))
    render(
      <MemoryRouter initialEntries={[`/exposure/${sampleFinding.id}`]}>
        <Routes>
          <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Agent one can transfer data externally' }),
      ).toBeInTheDocument(),
    )
    expect(screen.getByText('Recommendation')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading attack path')
  })

  it('ignores a stale remediation preview after navigating to another finding', async () => {
    let resolvePreview: ((value: typeof samplePreview) => void) | undefined
    vi.mocked(exposureApi.getRemediationPreview).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve
        }),
    )
    vi.mocked(exposureApi.get).mockImplementation((findingId) =>
      Promise.resolve(
        findingId === sampleFinding.id
          ? sampleFinding
          : { ...sampleFinding, id: 'finding-2', title: 'Second exposure finding' },
      ),
    )
    const router = createMemoryRouter(
      [{ path: '/exposure/:findingId', element: <ExposureDetailPage /> }],
      { initialEntries: [`/exposure/${sampleFinding.id}`] },
    )
    render(<RouterProvider router={router} />)

    await waitFor(() => expect(screen.getByText('Preview response')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Preview response' }))
    await act(async () => router.navigate('/exposure/finding-2'))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Second exposure finding' })).toBeInTheDocument(),
    )
    await act(async () => {
      resolvePreview?.(samplePreview)
      await Promise.resolve()
    })

    expect(screen.queryByText('Simulation only')).not.toBeInTheDocument()
  })

  it('ignores a stale advisory narrative after navigating to another finding', async () => {
    let resolveNarrative: ((value: typeof sampleNarrative) => void) | undefined
    vi.mocked(exposureApi.generateNarrative).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNarrative = resolve
        }),
    )
    vi.mocked(exposureApi.get).mockImplementation((findingId) =>
      Promise.resolve(
        findingId === sampleFinding.id
          ? sampleFinding
          : { ...sampleFinding, id: 'finding-2', title: 'Second exposure finding' },
      ),
    )
    const router = createMemoryRouter(
      [{ path: '/exposure/:findingId', element: <ExposureDetailPage /> }],
      { initialEntries: [`/exposure/${sampleFinding.id}`] },
    )
    render(<RouterProvider router={router} />)

    await waitFor(() => expect(screen.getByText('Generate AI narrative')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Generate AI narrative' }))
    await act(async () => router.navigate('/exposure/finding-2'))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Second exposure finding' })).toBeInTheDocument(),
    )
    await act(async () => {
      resolveNarrative?.(sampleNarrative)
      await Promise.resolve()
    })

    expect(
      screen.queryByRole('heading', { name: 'Evidence-grounded incident narrative' }),
    ).not.toBeInTheDocument()
  })

  it('renders a 404 state', async () => {
    vi.mocked(exposureApi.get).mockRejectedValue(new Error('not found'))
    render(
      <MemoryRouter initialEntries={['/exposure/missing']}>
        <Routes>
          <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Exposure not found')).toBeInTheDocument())
  })
})
