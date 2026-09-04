// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { connectorApi, demoApi } from '../api'
import { testState } from '../test-fixture'
import { DemoStateProvider } from './DemoStateProvider'
import { DemoStateContext } from './DemoStateContext'
import { EstateContext } from './EstateContext'

vi.mock('../api')

function StateValue() {
  const value = DemoStateContext
  return (
    <value.Consumer>
      {(state) => (
        <span data-testid="state-id">{state?.state?.snapshot.generatedAt ?? 'empty'}</span>
      )}
    </value.Consumer>
  )
}

function renderForEstate(estateId: string) {
  return render(
    <EstateContext.Provider
      value={{
        estates: [],
        selectedEstateId: estateId,
        isLoading: false,
        error: undefined,
        selectEstate: vi.fn(),
      }}
    >
      <DemoStateProvider>
        <StateValue />
      </DemoStateProvider>
    </EstateContext.Provider>,
  )
}

afterEach(cleanup)

describe('DemoStateProvider estate switches', () => {
  it('aborts stale requests and reloads state for the selected estate', async () => {
    let firstSignal: AbortSignal | undefined
    vi.mocked(demoApi.getState)
      .mockImplementationOnce((signal) => {
        firstSignal = signal
        return new Promise(() => undefined)
      })
      .mockResolvedValueOnce({
        ...testState,
        snapshot: { ...testState.snapshot, generatedAt: 'estate-b' },
      })
    vi.mocked(connectorApi.getConnectorStatus).mockResolvedValue({
      source: 'mock',
      connectorId: 'mock-agent-estate',
      mode: 'mock',
    })

    const { rerender } = renderForEstate('estate-a')
    await waitFor(() => expect(firstSignal).toBeDefined())
    rerender(
      <EstateContext.Provider
        value={{
          estates: [],
          selectedEstateId: 'estate-b',
          isLoading: false,
          error: undefined,
          selectEstate: vi.fn(),
        }}
      >
        <DemoStateProvider>
          <StateValue />
        </DemoStateProvider>
      </EstateContext.Provider>,
    )

    expect(firstSignal?.aborted).toBe(true)
    expect(screen.getByTestId('state-id')).toHaveTextContent('empty')
    await waitFor(() => expect(screen.getByTestId('state-id')).toHaveTextContent('estate-b'))
  })
})
