/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import type { ExposureFinding, ExposurePage as ExposurePageDto } from '@agent-sentinel/domain'

import { ExposurePage } from './ExposurePage'
import { ExposureDetailPage } from './ExposureDetailPage'
import { exposureApi } from '../api/exposure-api'

vi.mock('../api/exposure-api')

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

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(exposureApi.list).mockResolvedValue(samplePage)
  vi.mocked(exposureApi.get).mockResolvedValue(sampleFinding)
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
})

describe('ExposureDetailPage', () => {
  it('renders the finding detail', async () => {
    render(
      <MemoryRouter initialEntries={[`/exposure/${sampleFinding.id}`]}>
        <Routes>
          <Route path="/exposure/:findingId" element={<ExposureDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() =>
      expect(screen.getByText('Agent one can transfer data externally')).toBeInTheDocument(),
    )
    expect(screen.getByText('Recommendation')).toBeInTheDocument()
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
