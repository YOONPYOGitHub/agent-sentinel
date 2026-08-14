// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { Evidence } from '@agent-sentinel/domain'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { useEvidenceDrawer } from './useEvidenceDrawer'

const evidence: Evidence = {
  id: 'e-1',
  source: 'Copilot Studio',
  sourceObjectId: 'agent-1',
  observedAt: '2026-08-14T12:00:00.000Z',
  freshness: 'recent',
  confidence: 1,
  summary: 'Manifest.',
}

function Harness() {
  const [open, setOpen] = useState(false)
  const drawer = useEvidenceDrawer(open ? evidence : undefined)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open evidence
      </button>
      <EvidenceDrawer
        evidence={drawer.selectedEvidence}
        drawerRef={drawer.drawerRef}
        onKeyDown={drawer.trapFocus}
        onClose={() => {
          drawer.setSelectedEvidence(undefined)
          setOpen(false)
        }}
      />
    </>
  )
}

describe('useEvidenceDrawer', () => {
  it('focuses, closes on Escape, and restores trigger focus', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Open evidence' })
    await user.click(trigger)
    expect(screen.getByRole('dialog')).toHaveFocus()
    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(screen.getByRole('button', { name: 'Close evidence' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
