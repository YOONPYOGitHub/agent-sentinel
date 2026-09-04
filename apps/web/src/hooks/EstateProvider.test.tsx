/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'

import type { DriftAnalysisResult } from '@agent-sentinel/domain'

import {
  EstateApiError,
  estateApi,
  type AuthorizedEstate,
  type EstatesResponse,
} from '../api/estate-api'
import { behaviorApi } from '../api/behavior-api'
import { getActiveEstateId, setActiveEstateId } from '../api/auth-fetch'
import { ESTATE_STORAGE_KEY, EstateProvider } from './EstateProvider'
import { clearAgentDriftCache, loadAgentDrift } from './useAgentDrift'
import { useEstate } from './useEstate'

const primary: AuthorizedEstate = {
  id: 'estate-primary',
  name: 'Primary estate',
  tenantId: 'tenant-primary',
  environment: 'production',
  isDefault: true,
}
const research: AuthorizedEstate = {
  id: 'estate-research',
  name: 'Research estate',
  tenantId: 'tenant-research',
  environment: 'research',
  isDefault: false,
}
const response: EstatesResponse = {
  defaultEstateId: primary.id,
  estates: [primary, research],
}

function Probe() {
  const { reload, selectEstate, state } = useEstate()
  const [draft, setDraft] = useState('clean')
  if (state.status !== 'ready') {
    return (
      <>
        <span data-testid="status">{state.status}</span>
        {'message' in state ? <span>{state.message}</span> : null}
        <button type="button" onClick={() => void reload()}>
          Retry
        </button>
      </>
    )
  }
  return (
    <>
      <span data-testid="selected">{state.selectedEstate.id}</span>
      <span data-testid="draft">{draft}</span>
      <button type="button" onClick={() => setDraft('dirty')}>
        Edit
      </button>
      <button
        type="button"
        onClick={() =>
          selectEstate(state.selectedEstate.id === primary.id ? research.id : primary.id)
        }
      >
        Switch
      </button>
    </>
  )
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function StaleProbe({ requests }: { requests: ReadonlyMap<string, Deferred<string>> }) {
  const { selectEstate, state } = useEstate()
  const estateId = state.status === 'ready' ? state.selectedEstate.id : undefined
  const [result, setResult] = useState('loading')
  useEffect(() => {
    if (estateId === undefined) return
    let current = true
    void requests.get(estateId)?.promise.then((value) => {
      if (current) setResult(value)
    })
    return () => {
      current = false
    }
  }, [estateId, requests])
  if (state.status !== 'ready') return null
  return (
    <>
      <span data-testid="result">{result}</span>
      <button type="button" onClick={() => selectEstate(research.id)}>
        Switch
      </button>
    </>
  )
}

beforeEach(() => {
  clearAgentDriftCache()
  vi.spyOn(estateApi, 'list').mockResolvedValue(response)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  setActiveEstateId(undefined)
  clearAgentDriftCache()
})

describe('EstateProvider', () => {
  it('selects valid storage, then the valid server default, and stores only the opaque ID', async () => {
    localStorage.setItem('agent-sentinel.estate-id', research.id)
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    expect(await screen.findByTestId('selected')).toHaveTextContent(research.id)
    expect(getActiveEstateId()).toBe(research.id)
    expect(localStorage).toHaveLength(1)
    cleanup()

    localStorage.setItem('agent-sentinel.estate-id', 'stale')
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    expect(await screen.findByTestId('selected')).toHaveTextContent(primary.id)
    expect(localStorage.getItem('agent-sentinel.estate-id')).toBe(primary.id)
  })

  it('falls back to the first authorized estate when the server default is unavailable', async () => {
    vi.mocked(estateApi.list).mockResolvedValue({
      defaultEstateId: 'global-default',
      estates: [research],
    })
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    expect(await screen.findByTestId('selected')).toHaveTextContent(research.id)
  })

  it('clears descendant state immediately on a valid switch', async () => {
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    await screen.findByText(primary.id)
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('draft')).toHaveTextContent('dirty')
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    expect(screen.getByTestId('selected')).toHaveTextContent(research.id)
    expect(screen.getByTestId('draft')).toHaveTextContent('clean')
  })

  it('ignores a prior estate response after switching', async () => {
    const oldRequest = deferred<string>()
    const newRequest = deferred<string>()
    render(
      <EstateProvider>
        <StaleProbe
          requests={
            new Map([
              [primary.id, oldRequest],
              [research.id, newRequest],
            ])
          }
        />
      </EstateProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Switch' }))
    newRequest.resolve('new estate')
    expect(await screen.findByTestId('result')).toHaveTextContent('new estate')
    oldRequest.resolve('stale estate')
    await waitFor(() => expect(screen.getByTestId('result')).toHaveTextContent('new estate'))
  })

  it('discards completed drift cache entries when switching away and back', async () => {
    const driftResult: DriftAnalysisResult = {
      analysisId: 'drift-agent-a',
      tenantId: primary.tenantId,
      agentId: 'agent-a',
      environment: primary.environment,
      source: 'azure-monitor-otel',
      status: 'insufficient-data',
      computedAt: '2026-09-04T00:00:00.000Z',
      dimensions: [],
      anyDrift: false,
      unavailableReason: 'Minimum sample count not met.',
    }
    vi.spyOn(behaviorApi, 'getDrift').mockResolvedValue(driftResult)
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    await screen.findByText(primary.id)
    await loadAgentDrift('agent-a')

    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    expect(screen.getByTestId('selected')).toHaveTextContent(research.id)
    fireEvent.click(screen.getByRole('button', { name: 'Switch' }))
    expect(screen.getByTestId('selected')).toHaveTextContent(primary.id)
    await loadAgentDrift('agent-a')

    expect(behaviorApi.getDrift).toHaveBeenCalledTimes(2)
  })

  it('represents an empty authorization set explicitly', async () => {
    localStorage.setItem(ESTATE_STORAGE_KEY, research.id)
    vi.mocked(estateApi.list).mockResolvedValue({ defaultEstateId: primary.id, estates: [] })
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    expect(await screen.findByTestId('status')).toHaveTextContent('empty')
    expect(localStorage.getItem(ESTATE_STORAGE_KEY)).toBeNull()
  })

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['unavailable', 503],
  ] as const)('represents %s failures explicitly', async (kind, status) => {
    vi.mocked(estateApi.list).mockRejectedValue(new EstateApiError(kind, `${kind} estates`, status))
    render(
      <EstateProvider>
        <Probe />
      </EstateProvider>,
    )
    expect(await screen.findByTestId('status')).toHaveTextContent(kind)
    expect(screen.getByText(`${kind} estates`)).toBeVisible()
  })

  it.each([
    ['network', new Error('network failed'), 'unavailable'],
    ['HTTP 5xx', new EstateApiError('unavailable', 'service failed', 503), 'unavailable'],
    ['HTTP 401', new EstateApiError('unauthorized', 'sign in again', 401), 'unauthorized'],
    ['HTTP 403', new EstateApiError('forbidden', 'access denied', 403), 'forbidden'],
    [
      'response validation',
      new EstateApiError('unavailable', 'authorized estates response was invalid', 200),
      'unavailable',
    ],
  ] as const)(
    'preserves the persisted estate through a %s failure and restores it on retry',
    async (_failure, error, status) => {
      localStorage.setItem(ESTATE_STORAGE_KEY, research.id)
      vi.mocked(estateApi.list).mockRejectedValueOnce(error).mockResolvedValueOnce(response)

      render(
        <EstateProvider>
          <Probe />
        </EstateProvider>,
      )

      expect(await screen.findByTestId('status')).toHaveTextContent(status)
      expect(localStorage.getItem(ESTATE_STORAGE_KEY)).toBe(research.id)

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(await screen.findByTestId('selected')).toHaveTextContent(research.id)
      expect(localStorage.getItem(ESTATE_STORAGE_KEY)).toBe(research.id)
      expect(estateApi.list).toHaveBeenCalledTimes(2)
    },
  )
})
