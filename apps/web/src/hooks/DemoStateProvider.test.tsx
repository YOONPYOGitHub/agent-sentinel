// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  demoApi: {
    getState: vi.fn(),
  },
  connectorApi: {
    getConnectorStatus: vi.fn(),
  },
}))

import { connectorApi, demoApi } from '../api'
import { DemoStateProvider } from './DemoStateProvider'
import { useDemoState } from './useDemoState'

function Probe() {
  const { state, load } = useDemoState()
  return (
    <div>
      <span data-testid="tenant">{state?.snapshot?.tenantId ?? 'none'}</span>
      <button onClick={() => void load()}>reload</button>
    </div>
  )
}

describe('DemoStateProvider', () => {
  it('ignores stale results from an earlier load', async () => {
    const staleState = {
      snapshot: {
        tenantId: 'stale-tenant',
        environment: 'validation',
        generatedAt: '2026-09-04T00:00:00.000Z',
        nodes: [],
        edges: [],
        evidence: [],
      },
      findings: [],
      validations: [],
      remediations: [],
    }
    const freshState = {
      snapshot: {
        tenantId: 'fresh-tenant',
        environment: 'production',
        generatedAt: '2026-09-04T00:00:01.000Z',
        nodes: [],
        edges: [],
        evidence: [],
      },
      findings: [],
      validations: [],
      remediations: [],
    }

    vi.mocked(demoApi.getState)
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(staleState), 30)),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(freshState), 0)),
      )
    vi.mocked(connectorApi.getConnectorStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ source: 'mock', connectorId: 'stale', mode: 'mock' }),
              30,
            ),
          ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ source: 'mock', connectorId: 'fresh', mode: 'mock' }),
              0,
            ),
          ),
      )

    render(
      <DemoStateProvider>
        <Probe />
      </DemoStateProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'reload' }))

    await waitFor(() => expect(screen.getByTestId('tenant')).toHaveTextContent('fresh-tenant'))
  })
})
