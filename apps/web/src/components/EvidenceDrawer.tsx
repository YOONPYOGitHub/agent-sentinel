import { Badge, Button } from '@fluentui/react-components'
import { DismissRegular, KeyRegular } from '@fluentui/react-icons'
import type { KeyboardEventHandler, RefObject } from 'react'

import type { Evidence } from '@agent-sentinel/domain'

import { formatEvidenceTypes } from '../evidence-types'

interface EvidenceDrawerProps {
  evidence: Evidence | undefined
  drawerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onKeyDown: KeyboardEventHandler<HTMLElement>
}

export function EvidenceDrawer({ evidence, drawerRef, onClose, onKeyDown }: EvidenceDrawerProps) {
  if (evidence === undefined) return null

  return (
    <div className="evidence-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={drawerRef}
        className="evidence-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="evidence-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="evidence-drawer__header">
          <div>
            <span className="eyebrow">EVIDENCE OBJECT</span>
            <h2 id="evidence-title">{evidence.source}</h2>
          </div>
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            aria-label="Close evidence"
            onClick={onClose}
          />
        </div>
        <Badge color={evidence.freshness === 'stale' ? 'warning' : 'success'} appearance="tint">
          {evidence.freshness} · {Math.round(evidence.confidence * 100)}% confidence
        </Badge>
        <Badge appearance="outline">{formatEvidenceTypes(evidence.evidenceTypes)}</Badge>
        <p className="evidence-lead">{evidence.summary}</p>
        <dl>
          <div>
            <dt>Source object</dt>
            <dd>{evidence.sourceObjectId}</dd>
          </div>
          <div>
            <dt>Evidence type</dt>
            <dd>{formatEvidenceTypes(evidence.evidenceTypes)}</dd>
          </div>
          <div>
            <dt>Observed</dt>
            <dd>{new Date(evidence.observedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Evidence ID</dt>
            <dd>{evidence.id}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{Math.round(evidence.confidence * 100)}% from the cited source</dd>
          </div>
        </dl>
        <div className="evidence-note">
          <KeyRegular />
          <div>
            <strong>Evidence-first decision</strong>
            <span>
              This object contributes only the claims stated above. Missing or stale evidence lowers
              confidence; source presence alone does not establish health, trust, or compliance.
            </span>
          </div>
        </div>
      </aside>
    </div>
  )
}
