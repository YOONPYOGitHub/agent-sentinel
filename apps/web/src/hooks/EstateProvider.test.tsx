/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { estateApi } from '../api/estate-api'
import { AppLayout } from '../components/AppLayout'
import { DemoStateContext, type DemoStateValue } from './DemoStateContext'
import { EstateProvider } from './EstateProvider'
import { useEstate } from './useEstate'

vi.mock('../api/estate-api')

const estates = [
  {
    id: 'default-estate',
    name: 'Default estate',
    tenantId: 'tenant-a',
    environment: 'production',
    isDefault: true,
  },
  {
    id: 'other-estate',
    name: 'Other estate',
    tenantId: 'tenant-b',
    environment: 'production',
    isDefault: false,
  },
]

function EstateValue() {
  const { selectedEstateId } = useEstate()
  return <span data-testid="estate-id">{selectedEstateId}</span>
}

const demoState: DemoStateValue = {
  state: undefined,
  connectorStatus: undefined,
  operation: undefined,
  error: undefined,
  clearError: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
}

function renderLayout() {
  return render(
    <MemoryRouter>
      <DemoStateContext.Provider value={demoState}>
        <EstateProvider>
          <AppLayout />
          <EstateValue />
        </EstateProvider>
      </DemoStateContext.Provider>
    </MemoryRouter>,
  )
}

afterEach(cleanup)

beforeEach(() => {
  localStorage.clear()
  vi.mocked(estateApi.listAuthorized).mockResolvedValue({
    defaultEstateId: 'default-estate',
    estates,
  })
})

describe('EstateProvider', () => {
  it('selects the server default and persists only an authorized opaque estate ID', async () => {
    render(
      <EstateProvider>
        <EstateValue />
      </EstateProvider>,
    )

    expect(await screen.findByTestId('estate-id')).toHaveTextContent('default-estate')
    expect(localStorage.getItem('agent-sentinel.selected-estate-id')).toBeNull()
  })

  it('ignores an invalid persisted selection and uses the server default', async () => {
    localStorage.setItem('agent-sentinel.selected-estate-id', '<invalid>')
    render(
      <EstateProvider>
        <EstateValue />
      </EstateProvider>,
    )

    expect(await screen.findByTestId('estate-id')).toHaveTextContent('default-estate')
  })

  it('shows a selector only when multiple estates are authorized', async () => {
    renderLayout()
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Selected estate' })).toBeVisible(),
    )

    fireEvent.change(screen.getByRole('combobox', { name: 'Selected estate' }), {
      target: { value: 'other-estate' },
    })
    expect(localStorage.getItem('agent-sentinel.selected-estate-id')).toBe('other-estate')

    cleanup()
    vi.mocked(estateApi.listAuthorized).mockResolvedValueOnce({
      defaultEstateId: 'default-estate',
      estates: [estates[0]!],
    })
    renderLayout()
    await screen.findByTestId('estate-id')
    expect(screen.queryByRole('combobox', { name: 'Selected estate' })).toBeNull()
  })
})
