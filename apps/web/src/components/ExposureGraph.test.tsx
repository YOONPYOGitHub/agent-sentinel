// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { EstateSnapshot } from '@agent-sentinel/domain'

import { ExposureGraph } from './ExposureGraph'

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => null,
  MarkerType: { ArrowClosed: 'arrow-closed' },
  MiniMap: () => null,
  ReactFlow: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

vi.mock('./AgentGraphNode', () => ({
  AgentGraphNode: () => null,
}))

const snapshot: EstateSnapshot = {
  tenantId: 'tenant-demo',
  environment: 'validation',
  generatedAt: '2026-08-18T09:00:00.000Z',
  nodes: [
    {
      id: 'agent',
      kind: 'agent',
      name: 'Sales agent',
      description: 'Synthetic sales agent',
      environment: 'validation',
      evidenceIds: ['evidence'],
      metadata: {},
    },
    {
      id: 'tool',
      kind: 'tool',
      name: 'External send',
      description: 'Synthetic external transfer',
      environment: 'validation',
      evidenceIds: ['evidence'],
      metadata: {},
    },
    {
      id: 'supporting-tool',
      kind: 'tool',
      name: 'CRM read',
      description: 'Synthetic supporting capability',
      environment: 'validation',
      evidenceIds: ['evidence'],
      metadata: {},
    },
  ],
  edges: [
    {
      id: 'edge',
      from: 'agent',
      to: 'tool',
      relationship: 'CAN_CALL',
      evidenceIds: ['evidence'],
      active: true,
      removable: false,
    },
    {
      id: 'supporting-edge',
      from: 'agent',
      to: 'supporting-tool',
      relationship: 'CAN_CALL',
      evidenceIds: ['evidence'],
      active: false,
      removable: false,
    },
  ],
  evidence: [
    {
      id: 'evidence',
      source: 'Synthetic connector',
      sourceObjectId: 'agent',
      observedAt: '2026-08-18T09:00:00.000Z',
      freshness: 'live',
      confidence: 1,
      summary: 'Synthetic graph evidence',
    },
  ],
}

describe('ExposureGraph', () => {
  it('renders a keyboard-operable path list and opens edge evidence', () => {
    const onEvidenceSelect = vi.fn()
    const { rerender } = render(
      <ExposureGraph
        snapshot={snapshot}
        pathStatus="theoretical"
        title="Sales agent external egress"
        highlightedEdgeIds={['edge']}
        onEvidenceSelect={onEvidenceSelect}
      />,
    )

    expect(screen.getByText('3 assets')).toBeInTheDocument()
    const relationship = screen.getByRole('button', {
      name: /Sales agent CAN CALL External send Active exposure/i,
    })
    expect(
      screen.getByRole('button', {
        name: /Sales agent CAN CALL CRM read Inactive supporting route/i,
      }),
    ).toBeInTheDocument()
    fireEvent.click(relationship)
    expect(onEvidenceSelect).toHaveBeenCalledWith(snapshot.evidence[0])

    rerender(
      <ExposureGraph
        snapshot={{
          ...snapshot,
          edges: snapshot.edges.map((edge) =>
            edge.id === 'edge' ? { ...edge, active: false } : edge,
          ),
        }}
        pathStatus="mitigated"
        title="Sales agent external egress"
        highlightedEdgeIds={['edge']}
        onEvidenceSelect={onEvidenceSelect}
      />,
    )
    expect(
      screen.getByRole('button', {
        name: /Sales agent CAN CALL External send Blocked/i,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /Sales agent CAN CALL CRM read Inactive supporting route/i,
      }),
    ).toBeInTheDocument()
  })
})
