// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Evidence } from '@agent-sentinel/domain'
import { EvidenceDrawer } from './EvidenceDrawer'

const evidence: Evidence = {
  id: 'e-1',
  source: 'Microsoft Entra ID',
  sourceObjectId: 'object-1',
  observedAt: '2026-08-14T12:00:00.000Z',
  freshness: 'live',
  confidence: 1,
  summary: 'Verified assignment.',
}

function DrawerHarness({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLElement>(null)
  return (
    <EvidenceDrawer
      evidence={evidence}
      drawerRef={ref}
      onClose={onClose}
      onKeyDown={() => undefined}
    />
  )
}

describe('EvidenceDrawer', () => {
  it('renders evidence and closes from its accessible button', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<DrawerHarness onClose={onClose} />)
    expect(screen.getByRole('dialog', { name: 'Microsoft Entra ID' })).toBeVisible()
    expect(screen.getByText('Verified assignment.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close evidence' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
