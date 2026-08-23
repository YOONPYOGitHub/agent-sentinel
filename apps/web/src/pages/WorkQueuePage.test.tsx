/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { WorkQueuePage } from './WorkQueuePage'
import { governanceQueueApi } from '../api/governance-queue-api'
import { governanceCaseDetailFixture, governanceQueueFixture } from '../test-fixture'
import { AuthContext, type AuthContextValue } from '../hooks/AuthContext'
import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'

vi.mock('../api/governance-queue-api')

const disabledAuth: AuthContextValue = {
  isConfigured: false,
  spaConfig: null,
  isLoading: false,
  isSignedIn: false,
  principal: null,
  authError: null,
  signIn: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  getAccessToken: () => Promise.resolve(null),
}

const viewerOnlyAuth: AuthContextValue = {
  ...disabledAuth,
  isConfigured: true,
  isSignedIn: true,
  principal: {
    subject: 'viewer-subject',
    tenantId: 'tenant-id',
    displayName: 'Viewer Only',
    roles: ['Viewer'],
    capabilities: ['read'],
  },
}

const analystAuth: AuthContextValue = {
  ...disabledAuth,
  isConfigured: true,
  isSignedIn: true,
  principal: {
    subject: 'analyst-subject',
    tenantId: 'tenant-id',
    displayName: 'Avery Planner',
    roles: ['Analyst'],
    capabilities: ['read', 'validateFinding', 'generateAdvisory', 'proposeRemediation'],
  },
}

const demoStateValue: DemoStateValue = {
  state: undefined,
  connectorStatus: {
    source: 'foundry',
    connectorId: 'azure-ai-foundry-agent-service',
    mode: 'foundry',
    projectEndpoint: 'https://contoso.services.ai.azure.com/api/projects/sentinel',
    writeEnabled: false,
  },
  operation: undefined,
  error: undefined,
  clearError: () => undefined,
  load: () => Promise.resolve(),
  run: () => Promise.resolve(),
}

function renderPage(
  authValue: AuthContextValue = disabledAuth,
  demoValue: DemoStateValue = demoStateValue,
  initialEntry = '/work-queue',
) {
  render(
    <AuthContext.Provider value={authValue}>
      <DemoStateContext.Provider value={demoValue}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <WorkQueuePage />
        </MemoryRouter>
      </DemoStateContext.Provider>
    </AuthContext.Provider>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(governanceQueueApi.list).mockImplementation((params) => {
    const filteredCases = governanceQueueFixture.cases.filter((caseRecord) => {
      if (params?.status && caseRecord.status !== params.status) return false
      if (params?.kind && caseRecord.kind !== params.kind) return false
      if (params?.search) {
        const haystack = `${caseRecord.title} ${caseRecord.description}`.toLocaleLowerCase()
        if (!haystack.includes(params.search.toLocaleLowerCase())) return false
      }
      return true
    })

    return Promise.resolve({
      ...governanceQueueFixture,
      cases: filteredCases,
      total: filteredCases.length,
      summary: {
        ...governanceQueueFixture.summary,
        total: filteredCases.length,
      },
    })
  })
  vi.mocked(governanceQueueApi.get).mockResolvedValue(governanceCaseDetailFixture)
  vi.mocked(governanceQueueApi.create).mockResolvedValue(governanceQueueFixture.cases[0]!)
  vi.mocked(governanceQueueApi.transition).mockResolvedValue(governanceCaseDetailFixture)
})

describe('WorkQueuePage', () => {
  it('renders the mock queue and its cases', async () => {
    renderPage(analystAuth)

    expect(screen.getByTestId('work-queue-loading')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Open governance cases' })).toBeVisible()
    expect(screen.getByText('[Mock] Deterministic queue data')).toBeVisible()
    expect(screen.getByText('[Mock] Review uncontrolled data egress finding')).toBeVisible()
    expect(screen.getByText('5 cases')).toBeVisible()
  })

  it('filters the displayed results by status', async () => {
    renderPage(analystAuth)

    expect(await screen.findByRole('heading', { name: 'Open governance cases' })).toBeVisible()
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'approved' },
    })

    await waitFor(() =>
      expect(vi.mocked(governanceQueueApi.list)).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'approved' }),
      ),
    )
    expect(screen.getByText('[Mock] Close documented exception after control update')).toBeVisible()
    expect(
      screen.queryByText('[Mock] Review uncontrolled data egress finding'),
    ).not.toBeInTheDocument()
  })

  it('prefills a remediation case from an exposure deep link', async () => {
    renderPage(
      analystAuth,
      demoStateValue,
      '/work-queue?create=remediation-proposal&findingId=finding-1&agentId=agent-1&policyId=AS-POL-001&snapshotId=snapshot-1',
    )

    expect(await screen.findByRole('region', { name: 'Create governance case' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Finding ID' })).toHaveValue('finding-1')
    expect(screen.getByRole('textbox', { name: 'Agent ID' })).toHaveValue('agent-1')
    expect(screen.getByRole('textbox', { name: 'Policy ID' })).toHaveValue('AS-POL-001')
    expect(screen.getByRole('textbox', { name: 'Evidence snapshot ID' })).toHaveValue('snapshot-1')
  })

  it('shows an SLA warning for overdue cases', async () => {
    renderPage(analystAuth)

    expect(await screen.findAllByText('Overdue')).not.toHaveLength(0)
  })

  it('shows the separation-of-duties note', async () => {
    renderPage(analystAuth)

    expect(await screen.findByText(/Separation of duties:/i)).toBeVisible()
  })

  it('shows the live persistence unavailable banner', async () => {
    vi.mocked(governanceQueueApi.list).mockResolvedValueOnce({
      ...governanceQueueFixture,
      summary: {
        ...governanceQueueFixture.summary,
        sourceMode: 'foundry',
        persistenceAvailable: false,
        persistenceNote:
          'Live persistence unavailable – workflow state requires a dedicated Cosmos container. Cases shown are synthetic.',
      },
    })
    renderPage(analystAuth)

    expect(
      await screen.findByText(
        /Live persistence unavailable – workflow state requires a dedicated Cosmos container/i,
      ),
    ).toBeVisible()
  })

  it('disables the create case action without permission', async () => {
    renderPage(viewerOnlyAuth)

    const createButton = await screen.findByRole('button', { name: 'Create case' })
    expect(createButton).toBeDisabled()
  })

  it('renders loading and error states', async () => {
    vi.mocked(governanceQueueApi.list).mockImplementationOnce(() => new Promise(() => undefined))
    renderPage(analystAuth)
    expect(screen.getByTestId('work-queue-loading')).toBeInTheDocument()
    cleanup()

    vi.mocked(governanceQueueApi.list).mockRejectedValueOnce(new Error('queue unavailable'))
    renderPage(analystAuth)
    expect(await screen.findByRole('alert')).toHaveTextContent('queue unavailable')
  })
})
