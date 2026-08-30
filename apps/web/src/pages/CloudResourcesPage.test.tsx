// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import type { AgentSentinelState, Evidence, GraphNode } from '@agent-sentinel/domain'

import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { testState } from '../test-fixture'
import { CloudResourcesPage } from './CloudResourcesPage'

afterEach(cleanup)

const resourceEvidence: Evidence = {
  id: 'arg-resource-evidence',
  source: 'Azure Resource Graph REST 2022-10-01 · Primary Azure subscription',
  sourceObjectId:
    'primary:/subscriptions/subscription-a/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/ai-account',
  observedAt: '2026-08-29T14:00:00.000Z',
  freshness: 'live',
  confidence: 1,
  evidenceTypes: ['declared_configuration'],
  summary: 'Direct Azure resource inventory only.',
  metadata: {
    sourceConnector: 'azure-resource-graph',
  },
}

const resourceNode: GraphNode = {
  id: 'arg-resource-control',
  kind: 'control',
  name: 'ai-account',
  description: 'Direct Azure Resource Graph inventory observation.',
  environment: 'validation',
  evidenceIds: [resourceEvidence.id],
  metadata: {
    sourceConnector: 'azure-resource-graph',
    providerResourceId:
      '/subscriptions/subscription-a/resourceGroups/rg-ai/providers/Microsoft.CognitiveServices/accounts/ai-account',
    providerResourceType: 'microsoft.cognitiveservices/accounts',
    resourceGroup: 'rg-ai',
    location: 'koreacentral',
    subscriptionId: 'subscription-a',
    resourceKind: 'AIServices',
    skuName: 'S0',
    identityType: 'SystemAssigned',
  },
}

function renderPage(state: AgentSentinelState) {
  const value: DemoStateValue = {
    state,
    connectorStatus: {
      source: 'foundry',
      connectorId: 'azure-ai-foundry-agent-service',
      mode: 'foundry',
      writeEnabled: false,
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
        <CloudResourcesPage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
  return value
}

describe('CloudResourcesPage', () => {
  it('renders direct Azure Resource Graph inventory without agent or health claims', () => {
    renderPage({
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: [...testState.snapshot.nodes, resourceNode],
        evidence: [...testState.snapshot.evidence, resourceEvidence],
      },
    })

    expect(screen.getByRole('heading', { name: 'Cloud resources' })).toBeVisible()
    expect(screen.getByText('1 of 1 resources')).toBeVisible()
    expect(screen.getByText('ai-account')).toBeVisible()
    expect(screen.getAllByText('microsoft.cognitiveservices/accounts').length).toBeGreaterThan(0)
    expect(screen.getByText('AIServices · S0 · SystemAssigned')).toBeVisible()
    expect(screen.getByRole('note')).toHaveTextContent(
      'Resource presence is direct evidence, not agent classification.',
    )
    expect(screen.queryByText(/healthy|trusted agent/i)).not.toBeInTheDocument()
  })

  it('filters independently and opens the cited evidence', async () => {
    const user = userEvent.setup()
    renderPage({
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: [...testState.snapshot.nodes, resourceNode],
        evidence: [...testState.snapshot.evidence, resourceEvidence],
      },
    })

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter cloud resources by location' }),
      'koreacentral',
    )
    expect(screen.getByText('1 of 1 resources')).toBeVisible()
    await user.type(screen.getByRole('textbox', { name: 'Filter cloud resources by text' }), 'none')
    expect(screen.getByText('0 of 1 resources')).toBeVisible()
    await user.clear(screen.getByRole('textbox', { name: 'Filter cloud resources by text' }))
    await user.click(screen.getByRole('button', { name: 'View evidence' }))
    expect(screen.getByRole('dialog', { name: /Azure Resource Graph/ })).toBeVisible()
    expect(screen.getByText('Direct Azure resource inventory only.')).toBeVisible()
  })

  it('shows an authorization-aware empty state without implying absence', () => {
    renderPage(testState)
    expect(screen.getByRole('heading', { name: 'No authorized resources observed' })).toBeVisible()
    expect(screen.getByText(/review the connector identity RBAC scope/i)).toBeVisible()
  })

  it('labels persisted-state reload accurately', async () => {
    const user = userEvent.setup()
    const value = renderPage(testState)
    await user.click(screen.getByRole('button', { name: 'Reload snapshot' }))
    expect(value.load).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Refresh inventory' })).not.toBeInTheDocument()
  })
})
