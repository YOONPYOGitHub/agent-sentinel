/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import {
  connectorSourcesApi,
  connectorsApi,
  type ConnectorsCollection,
} from '../api/connectors-api'
import { ConnectorsPage } from './ConnectorsPage'

vi.mock('../api/connectors-api')

afterEach(cleanup)

const mockCollection: ConnectorsCollection = {
  active: {
    id: 'mock-agent-estate',
    mode: 'mock',
    source: 'mock',
    lifecycleState: 'connected',
    writeEnabled: true,
  },
  catalog: [
    {
      id: 'azure-ai-foundry',
      name: 'Azure AI Foundry',
      description: 'Discovers agents registered in Azure AI Foundry Agent Service.',
      lifecycleState: 'available-to-configure',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      prerequisiteNote: 'Requires FOUNDRY_PROJECT_ENDPOINT.',
      unlocksScorecard: ['security', 'governance', 'lifecycle'],
    },
    {
      id: 'm365-agent-registry',
      name: 'Microsoft Agent 365',
      description: 'Authoritative registry and admin surface for Microsoft 365 agents.',
      lifecycleState: 'authorization-required',
      capabilities: ['discovery', 'lifecycle-admin'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      prerequisiteNote:
        'API access requires tenant-level Microsoft 365 agent management permissions.',
    },
    {
      id: 'entra-agent-id',
      name: 'Microsoft Entra Agent ID & Entitlements',
      description: 'Agent-level identity principals and OAuth entitlement evidence.',
      lifecycleState: 'authorization-required',
      capabilities: ['identity', 'entitlement'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
      prerequisiteNote: 'Distinct from Entra sign-in authentication.',
    },
    {
      id: 'azure-monitor-otel',
      name: 'Azure Monitor & OpenTelemetry',
      description: 'Runtime telemetry via OpenTelemetry.',
      lifecycleState: 'planned',
      capabilities: ['runtime-telemetry'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
    {
      id: 'business-outcome-source',
      name: 'Business Outcome Source',
      description: 'Source-authored exact-correlated business outcomes.',
      lifecycleState: 'available-to-configure',
      capabilities: ['business-outcomes'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
  ],
}

const foundryCollection: ConnectorsCollection = {
  active: {
    id: 'foundry-connector',
    mode: 'foundry',
    source: 'foundry',
    lifecycleState: 'connected',
    writeEnabled: false,
    projectEndpoint: 'https://example.services.ai.azure.com/api/projects/test',
  },
  catalog: [
    {
      ...mockCollection.catalog[0]!,
      lifecycleState: 'connected',
    },
    ...mockCollection.catalog.slice(1),
  ],
}

const degradedFoundryCollection: ConnectorsCollection = {
  ...foundryCollection,
  active: { ...foundryCollection.active, lifecycleState: 'degraded' },
  catalog: foundryCollection.catalog.map((entry) =>
    entry.id === 'azure-ai-foundry' ? { ...entry, lifecycleState: 'degraded' } : entry,
  ),
  health: {
    overall: 'degraded',
    partial: true,
    sources: [
      {
        id: 'project-a',
        name: 'Project A',
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: 'ready',
      },
      {
        id: 'project-b',
        name: 'Project B',
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: 'unavailable',
        reason: 'authentication-or-access',
      },
    ],
  },
}

function renderPage() {
  render(
    <MemoryRouter>
      <ConnectorsPage />
    </MemoryRouter>,
  )
}

describe('ConnectorsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(connectorsApi.listConnectors).mockResolvedValue(mockCollection)
    vi.mocked(connectorSourcesApi.list).mockResolvedValue({
      items: [],
      page: { limit: 50, nextCursor: null },
      mutationPolicy: {
        enabled: false,
        requiresAuthentication: true,
        requiredCapability: 'configure',
      },
    })
  })

  it('shows loading state before data arrives', () => {
    vi.mocked(connectorsApi.listConnectors).mockReturnValue(new Promise<never>(() => undefined))
    renderPage()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders the page heading', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Data connectors' })).toBeVisible()
  })

  it('renders estate-scoped connector source configuration', async () => {
    renderPage()
    expect(
      await screen.findByRole('heading', { name: 'Connector source configuration' }),
    ).toBeVisible()
  })

  it('renders the active connector panel with mock details', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    expect(screen.getByRole('region', { name: 'Active connection status' })).toBeInTheDocument()
    expect(screen.getByText('Mock agent estate')).toBeVisible()
    expect(screen.getByText('Mock agent estate')).toBeVisible()
  })

  it('renders all catalog connector cards', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    expect(screen.getByRole('article', { name: 'Azure AI Foundry' })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'Microsoft Agent 365' })).toBeInTheDocument()
    expect(
      screen.getByRole('article', { name: 'Microsoft Entra Agent ID & Entitlements' }),
    ).toBeInTheDocument()
  })

  it('Azure AI Foundry shows available-to-configure in mock mode', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const foundryCard = screen.getByRole('article', { name: 'Azure AI Foundry' })
    expect(foundryCard).toHaveTextContent('Available to configure')
  })

  it('Azure AI Foundry shows Connected in foundry mode', async () => {
    vi.mocked(connectorsApi.listConnectors).mockResolvedValue(foundryCollection)
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const foundryCard = screen.getByRole('article', { name: 'Azure AI Foundry' })
    expect(foundryCard).toHaveTextContent('Connected')
  })

  it('shows degraded aggregate state and each Foundry source health', async () => {
    vi.mocked(connectorsApi.listConnectors).mockResolvedValue(degradedFoundryCollection)
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    expect(screen.getByText('Degraded · partial')).toBeVisible()
    expect(screen.getByText('Project A')).toBeVisible()
    expect(screen.getByText('Project B')).toBeVisible()
    expect(screen.getByText('unavailable · authentication-or-access')).toBeVisible()
  })

  it('Agent 365 shows authorization required, not connected', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const agent365Card = screen.getByRole('article', { name: 'Microsoft Agent 365' })
    expect(agent365Card).toHaveTextContent('Authorization required')
    expect(agent365Card).not.toHaveTextContent('Connected')
  })

  it('Agent 365 shows authority notice and prerequisite', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const agent365Card = screen.getByRole('article', { name: 'Microsoft Agent 365' })
    expect(agent365Card).toHaveTextContent('Authoritative source')
    expect(agent365Card).toHaveTextContent('API access requires tenant-level')
  })

  it('distinguishes Entra entitlement connector from Entra authentication', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    // The Entra notice banner explains the distinction
    expect(screen.getByRole('note')).toHaveTextContent(
      'Entra ID authentication vs. entitlement evidence',
    )
    expect(screen.getByRole('note')).toHaveTextContent('separate')
    // The Entra connector card exists with its own identity
    const entraCard = screen.getByRole('article', {
      name: 'Microsoft Entra Agent ID & Entitlements',
    })
    expect(entraCard).toHaveTextContent('Authorization required')
  })

  it('shows foundry active connector with project endpoint', async () => {
    vi.mocked(connectorsApi.listConnectors).mockResolvedValue(foundryCollection)
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    expect(screen.getByText('example.services.ai.azure.com', { exact: false })).toBeVisible()
  })

  it('shows error state and retry button on failure', async () => {
    vi.mocked(connectorsApi.listConnectors).mockRejectedValue(new Error('Network failure'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Network failure')
    vi.mocked(connectorsApi.listConnectors).mockResolvedValue(mockCollection)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Data connectors' })).toBeVisible()
  })

  it('connector cards do not expose secret field names', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const bodyText = document.body.textContent ?? ''
    const forbidden = ['password', 'client_secret', 'private_key']
    for (const term of forbidden) {
      expect(bodyText.toLowerCase()).not.toContain(term)
    }
  })

  it('shows unlocks scorecard chips for relevant connectors', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const foundryCard = screen.getByRole('article', { name: 'Azure AI Foundry' })
    expect(foundryCard).toHaveTextContent('Unlocks:')
    expect(foundryCard).toHaveTextContent('Security')
    expect(foundryCard).toHaveTextContent('Governance / Compliance')
  })

  it('renders capability chips for connector entries', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const foundryCard = screen.getByRole('article', { name: 'Azure AI Foundry' })
    expect(foundryCard).toHaveTextContent('Discovery')
    expect(foundryCard).not.toHaveTextContent('Runtime telemetry')
  })

  it('authorization-gated Entra connector shows its prerequisite without a dead action', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const entraCard = screen.getByRole('article', {
      name: 'Microsoft Entra Agent ID & Entitlements',
    })
    expect(entraCard).toHaveTextContent('Authorization & API availability required')
    expect(entraCard.querySelector('button')).toBeNull()
  })

  it('does not show configuration links before setup UI exists', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    const foundryCard = screen.getByRole('article', { name: 'Azure AI Foundry' })
    expect(foundryCard.querySelector('a')).toBeNull()
  })

  it('refresh button reloads data', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Data connectors' })
    expect(vi.mocked(connectorsApi.listConnectors)).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }))
    await waitFor(() => expect(vi.mocked(connectorsApi.listConnectors)).toHaveBeenCalledTimes(2))
  })
})
