// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import type { AgentSentinelState, Evidence, GraphNode } from '@agent-sentinel/domain'
import { DemoStateContext, type DemoStateValue } from '../hooks/DemoStateContext'
import { testState } from '../test-fixture'
import { AgentCatalogPage } from './AgentCatalogPage'

const observedAt = '2026-09-15T00:00:00.000Z'

function agent365Node(index: number): GraphNode {
  return {
    id: `agent365-${index}`,
    kind: 'agent',
    name: `Agent 365 package ${index}`,
    description: `Authoritative package record ${index}.`,
    environment: 'production',
    evidenceIds: [`agent365-evidence-${index}`],
    metadata: {
      platform: 'Microsoft Agent 365 package catalog',
      packagePlatform: index % 2 === 0 ? 'teams' : 'web',
      sourceConnector: 'agent365-package-catalog',
      sourceOfTruth: 'true',
      inventoryEntityType: 'agent-package',
      publisher: 'Contoso',
    },
  }
}

function foundryNode(index: number): GraphNode {
  return {
    id: `foundry-${index}`,
    kind: 'agent',
    name: `Foundry validation ${index}`,
    description: 'Synthetic validation agent.',
    environment: 'validation',
    evidenceIds: [`foundry-evidence-${index}`],
    metadata: {
      platform: 'Azure AI Foundry Agent Service',
      sourceOfTruth: 'true',
      ...(index < 3 ? { syntheticOnly: 'true', testOnly: 'true' } : {}),
    },
  }
}

function foundryEvidence(index: number): Evidence {
  return {
    id: `foundry-evidence-${index}`,
    source: 'Azure AI Foundry Agent Service',
    sourceObjectId: `foundry-${index}`,
    observedAt,
    freshness: 'live',
    confidence: 1,
    evidenceTypes: index < 3 ? ['declared_configuration'] : ['synthetic_validation'],
    summary: 'Synthetic validation evidence.',
  }
}

function catalogState(): AgentSentinelState {
  return {
    ...testState,
    snapshot: {
      ...testState.snapshot,
      generatedAt: observedAt,
      nodes: [
        ...Array.from({ length: 302 }, (_value, index) => agent365Node(index + 1)),
        ...Array.from({ length: 6 }, (_value, index) => foundryNode(index + 1)),
        ...Array.from({ length: 6 }, (_value, index) => ({
          id: `extension-${index + 1}`,
          kind: 'control' as const,
          name: `Extension control ${index + 1}`,
          description: 'Non-agent extension package.',
          environment: 'production',
          evidenceIds: [],
          metadata: {
            platform: 'Microsoft Agent 365 package catalog',
            inventoryEntityType: 'extension-package',
          },
        })),
      ],
      evidence: Array.from({ length: 6 }, (_value, index) => foundryEvidence(index + 1)),
    },
  }
}

function renderCatalog() {
  const value: DemoStateValue = {
    state: catalogState(),
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
        <AgentCatalogPage />
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

describe('AgentCatalogPage', () => {
  it('shows all agent nodes with production boundary counts and excludes extension controls', () => {
    renderCatalog()

    expect(screen.getByRole('heading', { name: 'Agent assurance catalog' })).toBeVisible()
    const summary = screen.getByLabelText('Agent catalog summary')
    expect(within(summary).getByText('308')).toBeVisible()
    expect(within(summary).getByText('302')).toBeVisible()
    expect(within(summary).getAllByText('6')).toHaveLength(2)
    expect(screen.getAllByText('Synthetic / test')).toHaveLength(7)
    expect(screen.queryByText('Extension control 1')).not.toBeInTheDocument()
    expect(
      screen.getByText(/not proof of entitlement, installation, trust, or runtime use/i),
    ).toBeVisible()
  })

  it('filters by source and platform without relabeling packages as running agents', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by source' }),
      'Agent 365',
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by platform' }), 'teams')

    expect(screen.getByText('151 of 308 records')).toBeVisible()
    expect(screen.getAllByText('Package record')).toHaveLength(151)
    expect(document.body).not.toHaveTextContent(/running agents/i)
  })

  it('searches the organization-wide catalog and keeps Foundry records visibly synthetic', async () => {
    const user = userEvent.setup()
    renderCatalog()

    await user.type(screen.getByRole('textbox', { name: 'Search agent catalog' }), 'validation 4')

    expect(screen.getByText('1 of 308 records')).toBeVisible()
    const heading = screen.getByRole('heading', { name: 'Foundry validation 4' })
    expect(heading).toBeVisible()
    const card = heading.closest('article')
    expect(card).not.toBeNull()
    expect(within(card!).getByText('Synthetic / test')).toBeVisible()
    expect(
      within(card!).getByText(/not production use or observed runtime behavior/i),
    ).toBeVisible()
  })
})
