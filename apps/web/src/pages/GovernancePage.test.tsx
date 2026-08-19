/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import { governanceApi } from '../api/governance-api'
import { governancePostureFixture } from '../test-fixture'
import { GovernancePage } from './GovernancePage'

vi.mock('../api/governance-api')

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(governanceApi.getPosture).mockResolvedValue(governancePostureFixture)
})

describe('GovernancePage', () => {
  it('renders policy posture and deep links to filtered findings', async () => {
    render(
      <MemoryRouter>
        <GovernancePage />
      </MemoryRouter>,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Evaluating governance posture')
    expect(await screen.findByRole('heading', { name: 'Active controls' })).toBeVisible()
    expect(screen.getByText('Unapproved external transfer or send')).toBeVisible()
    expect(screen.getByText('Needs attention')).toBeVisible()
    expect(screen.getByText('Compliant')).toBeVisible()
    expect(screen.getAllByRole('link', { name: 'View findings' })[0]).toHaveAttribute(
      'href',
      '/exposure?policyId=AS-POL-001',
    )
  })

  it('renders an error and retries posture loading', async () => {
    vi.mocked(governanceApi.getPosture)
      .mockRejectedValueOnce(new Error('policy service unavailable'))
      .mockResolvedValueOnce(governancePostureFixture)
    render(
      <MemoryRouter>
        <GovernancePage />
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('policy service unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Active controls' })).toBeVisible()
  })
})
