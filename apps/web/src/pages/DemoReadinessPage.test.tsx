// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectorsCollectionResponse } from '@agent-sentinel/connector-sdk'
import type { ConnectorSourceReadModel } from '@agent-sentinel/domain'

import { testState } from '../test-fixture'
import { DemoReadinessPage } from './DemoReadinessPage'

const observedAt = '2026-09-12T00:00:00.000Z'
const connectors: ConnectorsCollectionResponse = {
  active: {
    id: 'foundry',
    mode: 'foundry',
    source: 'foundry',
    lifecycleState: 'connected',
    writeEnabled: false,
  },
  catalog: [
    {
      id: 'm365-agent-registry',
      name: 'Agent 365',
      description: 'Catalog.',
      lifecycleState: 'degraded',
      capabilities: ['discovery'],
      sourceOfTruth: true,
      ownershipModel: 'consumes',
    },
  ],
  health: {
    overall: 'degraded',
    partial: true,
    sourceSetFingerprint: 'a'.repeat(64),
    sources: [
      {
        id: 'agent365:primary',
        name: 'Agent 365',
        role: 'discovery',
        enabled: true,
        configured: true,
        readiness: 'ready',
        dataState: 'empty',
        pages: 1,
        records: 0,
        checkedAt: observedAt,
        provenance: {
          estateTenantId: 'test',
          estateEnvironment: 'test',
          sourceConnectorId: 'primary',
          sourceTenantId: 'test',
          sourceEnvironment: 'test',
          provider: 'microsoft-graph-agent365-package-catalog',
          providerObjectId: '/v1.0/copilot/admin/catalog/packages',
        },
      },
    ],
  },
}

const source: ConnectorSourceReadModel = {
  estateId: 'default',
  tenantId: 'test',
  environment: 'test',
  sourceId: 'agent365-primary',
  connectorType: 'agent365',
  displayName: 'Agent 365',
  enabled: true,
  origin: 'deployment',
  configuration: {
    type: 'agent365',
    graphBaseUrl: 'https://graph.microsoft.com',
    limits: {
      maxPages: 20,
      maxItems: 5000,
      requestTimeoutMs: 15000,
      maxRetries: 2,
      maxRetryAfterMs: 30000,
      maxResponseBytes: 2000000,
    },
  },
  credential: {
    mode: 'managed-identity',
    managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
  },
  runtimeBinding: { bindingSourceId: 'primary' },
  testStatus: { status: 'not-tested' },
  version: 1,
  etag: 'etag',
  createdBy: { type: 'deployment', id: 'deployment' },
  updatedBy: { type: 'deployment', id: 'deployment' },
  createdAt: observedAt,
  updatedAt: observedAt,
}

afterEach(cleanup)

describe('DemoReadinessPage', () => {
  it('shows truthful blocked and partial categories without sensitive identity values', () => {
    render(
      <DemoReadinessPage
        state={testState}
        connectors={connectors}
        connectorSources={[source]}
        loading={false}
        onRefresh={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Demo readiness' })).toBeVisible()
    expect(screen.getByLabelText('Overall demo readiness')).toHaveTextContent('Blocked')
    expect(screen.getByText('Exact Agent 365 live package evidence is not ready.')).toBeVisible()
    expect(screen.getByText('Live OTel evidence is insufficient for demo readiness.')).toBeVisible()
    expect(screen.getByText('redacted')).toBeVisible()
    expect(document.body).not.toHaveTextContent('59dbea72-1e91-403a-89cf-e02cdb8da350')
  })

  it('shows unavailable evidence instead of a mock success fallback', () => {
    const refresh = vi.fn()
    render(<DemoReadinessPage state={testState} loading={false} onRefresh={refresh} />)

    expect(screen.getByText('Readiness is unavailable')).toBeVisible()
    expect(screen.getByText(/No mock success fallback/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh readiness' }))
    expect(refresh).toHaveBeenCalledOnce()
  })
})
