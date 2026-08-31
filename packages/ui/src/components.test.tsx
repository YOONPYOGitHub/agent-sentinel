import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DataFreshnessIndicator } from './DataFreshnessIndicator.js'
import { DataState } from './DataState.js'
import { KpiCard } from './KpiCard.js'
import { StatusBadge } from './StatusBadge.js'

describe('shared UI primitives', () => {
  it('renders a semantic KPI card', () => {
    render(<KpiCard label="Evidence objects" value="539" detail="9 sources" tone="success" />)
    expect(screen.getByText('Evidence objects').closest('article')).toHaveClass(
      'as-kpi-card--success',
    )
  })

  it('uses alert semantics for denied and error states', () => {
    render(<DataState variant="denied" title="Access denied" description="Role required." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Access denied')
  })

  it('renders status and freshness without relying on color alone', () => {
    render(
      <>
        <StatusBadge status="degraded" />
        <DataFreshnessIndicator freshness="stale" observedAt="2026-08-31T01:00:00.000Z" />
      </>,
    )
    expect(screen.getByText('degraded')).toBeVisible()
    expect(screen.getByText('stale')).toBeVisible()
  })

  it('does not use time semantics when the observation timestamp is unavailable', () => {
    const { container } = render(<DataFreshnessIndicator freshness="unknown" />)
    expect(screen.getByText('Observation time unavailable').tagName).toBe('SPAN')
    expect(container.querySelector('time')).not.toBeInTheDocument()
  })
})
