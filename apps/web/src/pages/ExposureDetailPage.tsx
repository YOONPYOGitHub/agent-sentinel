import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowLeftRegular,
  BotRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'

import type { ExposureFinding } from '@agent-sentinel/domain'
import type { EstateSnapshot } from '@agent-sentinel/domain'

import { exposureApi } from '../api/exposure-api'
import { EvidenceDrawer } from '../components/EvidenceDrawer'
import { ExposureGraph } from '../components/ExposureGraph'
import { PageHeading } from '../components/PageHeading'
import { useEvidenceDrawer } from '../hooks/useEvidenceDrawer'

export function ExposureDetailPage() {
  const { findingId } = useParams<{ findingId: string }>()
  const navigate = useNavigate()
  const [finding, setFinding] = useState<ExposureFinding | undefined>(undefined)
  const [graph, setGraph] = useState<EstateSnapshot | undefined>(undefined)
  const [graphLoading, setGraphLoading] = useState(true)
  const [graphError, setGraphError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const { selectedEvidence, setSelectedEvidence, drawerRef, trapFocus } = useEvidenceDrawer()

  useEffect(() => {
    if (!findingId) return
    let cancelled = false
    setLoading(true)
      setNotFound(false)
      setError(undefined)
      setFinding(undefined)
      setGraph(undefined)
      setGraphLoading(true)
      setGraphError(undefined)
      exposureApi
        .get(findingId)
        .then((value) => {
          if (!cancelled) setFinding(value)
        })
        .catch((fetchError: unknown) => {
        if (cancelled) return
        const message = fetchError instanceof Error ? fetchError.message : String(fetchError)
        if (message.toLowerCase().includes('not found') || message.includes('404')) {
          setNotFound(true)
        } else {
          setError(message)
        }
      })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      exposureApi
        .getGraph(findingId)
        .then((value) => {
          if (!cancelled) setGraph(value)
        })
        .catch((fetchError: unknown) => {
          if (cancelled) return
          setGraphError(fetchError instanceof Error ? fetchError.message : String(fetchError))
        })
        .finally(() => {
          if (!cancelled) setGraphLoading(false)
        })
    return () => {
      cancelled = true
    }
  }, [findingId])

  if (loading) {
    return (
      <div className="exposure-detail-loading" data-testid="exposure-detail-loading">
        <Spinner size="medium" label="Loading exposure finding…" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="exposure-empty">
        <ShieldCheckmarkRegular />
        <h2>Exposure not found</h2>
        <p>The requested finding is not available.</p>
        <Button appearance="primary" onClick={() => { void navigate('/exposure') }}>
          Back to exposures
        </Button>
      </div>
    )
  }

  if (error || !finding) {
    return (
      <div className="exposure-error" role="alert">
        <AlertRegular aria-hidden="true" />
        <div>
          <strong>Unable to load finding</strong>
          <p>{error ?? 'The exposure finding could not be loaded.'}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      <PageHeading
        section="Exposure management"
        title={finding.title}
        description={finding.summary}
      />

      <div className="exposure-detail-actions">
        <Button
          appearance="subtle"
          icon={<ArrowLeftRegular />}
          onClick={() => { void navigate('/exposure') }}
        >
          Back to exposures
        </Button>
        <Link to={`/agent-estate/${finding.affectedAgentId}`} className="exposure-agent-link">
          <BotRegular aria-hidden="true" /> View agent in estate
        </Link>
      </div>

      <section className="exposure-detail-summary">
        <div className="exposure-detail-badges">
          <Badge className={`severity-badge severity-badge--${finding.severity}`}>
            {finding.severity}
          </Badge>
          <Badge className={`status-badge status-badge--${finding.status}`}>{finding.status}</Badge>
          <Badge appearance="outline">Risk {finding.riskScore}</Badge>
          <Badge appearance="outline">{finding.policyId}</Badge>
        </div>
        <p>{finding.summary}</p>
        <h3>Recommendation</h3>
        <p>{finding.recommendation}</p>
      </section>

        <section className="exposure-detail-grid">
        <div>
          <h4>Declared tools</h4>
          <ul>
            {finding.declaredTools.map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Blast radius</h4>
          <p>{finding.blastRadiusCount} downstream nodes reachable.</p>
        </div>
        <div>
          <h4>Evidence provenance</h4>
          <p>Types: {finding.evidenceTypes.join(', ')}</p>
          <ul>
            {finding.evidenceIds.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        </div>
        </section>

        <section className="exposure-path-section" aria-labelledby="exposure-path-title">
          <div className="exposure-path-heading">
            <div>
              <span className="eyebrow">EVIDENCE GRAPH</span>
              <h2 id="exposure-path-title">Affected attack path</h2>
            </div>
            <span>{finding.blastRadiusCount} downstream nodes reachable</span>
          </div>
          {graphLoading ? (
            <div className="exposure-graph-loading" role="status">
              <Spinner size="medium" label="Loading attack path…" />
            </div>
          ) : graph === undefined ? (
            <div className="exposure-graph-unavailable" role={graphError ? 'alert' : 'status'}>
              <AlertRegular aria-hidden="true" />
              <div>
                <strong>Graph evidence unavailable</strong>
                <p>{graphError ?? 'The snapshot graph could not be loaded.'}</p>
              </div>
            </div>
          ) : (
            <ExposureGraph
              snapshot={graph}
              pathStatus={finding.validationStatus}
              title={finding.title}
              onEvidenceSelect={setSelectedEvidence}
            />
          )}
        </section>

        <section className="exposure-disclaimer">
        <p>
          <strong>Declared configuration only.</strong> This finding is derived from the agent's
          declared platform configuration. It does not confirm observed runtime behavior; validate
          with a synthetic run before remediation.
          </p>
        </section>
        <EvidenceDrawer
          evidence={selectedEvidence}
          drawerRef={drawerRef}
          onClose={() => setSelectedEvidence(undefined)}
          onKeyDown={trapFocus}
        />
      </>
  )
}
