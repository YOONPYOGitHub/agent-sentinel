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
    render(
      <ExposureGraph
        snapshot={snapshot}
        pathStatus="theoretical"
        title="Sales agent external egress"
        onEvidenceSelect={onEvidenceSelect}
      />,
    )

    expect(screen.getByText('2 assets')).toBeInTheDocument()
    const relationship = screen.getByRole('button', {
      name: /Sales agent CAN CALL External send Active/i,
    })
    fireEvent.click(relationship)
    expect(onEvidenceSelect).toHaveBeenCalledWith(snapshot.evidence[0])
  })
})
