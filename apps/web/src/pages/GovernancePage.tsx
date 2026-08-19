import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  LockClosedRegular,
  ShieldErrorRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import type { GovernancePosture } from '@agent-sentinel/domain'

import { governanceApi } from '../api/governance-api'
import { PageHeading } from '../components/PageHeading'

function formatDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function GovernancePage() {
  const [posture, setPosture] = useState<GovernancePosture>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setPosture(await governanceApi.getPosture())
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Governance posture could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  return (
    <>
      <PageHeading
        section="Governance"
        title="Policy governance"
        description="Deterministic policy posture, control coverage, and evidence-backed exceptions across the agent estate."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={loading}
            onClick={() => void load()}
          >
            Refresh posture
          </Button>
        }
      />

      {loading && posture === undefined ? (
        <div className="governance-state" role="status">
          <Spinner size="medium" label="Evaluating governance posture…" />
        </div>
      ) : error ? (
        <div className="governance-state governance-state--error" role="alert">
          <AlertRegular />
          <div>
            <strong>Governance posture unavailable</strong>
            <span>{error}</span>
          </div>
          <Button appearance="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : posture ? (
        <>
          <section className="governance-summary" aria-label="Governance summary">
            <GovernanceMetric
              label="Deterministic policies"
              value={posture.summary.totalPolicies}
              detail={
                posture.evaluationCoverage === 'complete'
                  ? 'Policy-as-code controls evaluated'
                  : 'Catalog policies with findings coverage'
              }
              tone="neutral"
            />
            <GovernanceMetric
              label="Need attention"
              value={posture.summary.policiesNeedingAttention}
              detail={`${posture.summary.openFindings} open findings`}
              tone={posture.summary.policiesNeedingAttention > 0 ? 'danger' : 'success'}
            />
            <GovernanceMetric
              label="Compliant policies"
              value={posture.summary.compliantPolicies}
              detail={
                posture.evaluationCoverage === 'complete'
                  ? 'No active finding after complete evaluation'
                  : 'Not asserted from findings-only data'
              }
              tone="success"
            />
            <GovernanceMetric
              label="Affected agents"
              value={posture.summary.affectedAgents}
              detail="Require owner or control action"
              tone={posture.summary.affectedAgents > 0 ? 'warning' : 'success'}
            />
          </section>

          <section className="governance-provenance">
            <LockClosedRegular />
            <div>
              <strong>Declared-configuration evidence</strong>
              <span>
                {posture.evaluationCoverage === 'complete'
                  ? 'Complete deterministic evaluation'
                  : 'Findings-only posture; absence does not imply compliance'}{' '}
                · {posture.sourceMode === 'foundry' ? 'Foundry' : 'Mock'} source
                {posture.latestEvidenceAt
                  ? ` · Latest finding evidence ${formatDateTime(posture.latestEvidenceAt)}`
                  : ' · No finding evidence available'}
              </span>
            </div>
          </section>

          <section className="governance-table-card" aria-labelledby="policy-library-title">
            <div className="governance-table-card__header">
              <div>
                <span className="eyebrow">POLICY LIBRARY</span>
                <h2 id="policy-library-title">Active controls</h2>
              </div>
              <span>{posture.policies.length} policies</span>
            </div>
            <div className="governance-table-wrapper">
              <table className="governance-table">
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Category</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Findings</th>
                    <th>Affected agents</th>
                    <th>Evidence</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {posture.policies.map((policy) => (
                    <tr key={policy.id}>
                      <td>
                        <strong>{policy.name}</strong>
                        <span>{policy.id}</span>
                        <small>{policy.description}</small>
                      </td>
                      <td>{policy.category}</td>
                      <td>
                        <Badge className={`severity-badge severity-badge--${policy.severity}`}>
                          {policy.severity}
                        </Badge>
                      </td>
                      <td>
                        <span className={`governance-status governance-status--${policy.status}`}>
                          {policy.status === 'compliant' ? (
                            <CheckmarkCircleRegular />
                          ) : (
                            <ShieldErrorRegular />
                          )}
                          {policy.status === 'compliant'
                            ? 'Compliant'
                            : policy.status === 'needs-attention'
                              ? 'Needs attention'
                              : 'Not evaluated'}
                        </span>
                      </td>
                      <td>{policy.openFindings}</td>
                      <td>{policy.affectedAgents}</td>
                      <td>Declared configuration</td>
                      <td>
                        <Link to={`/exposure?policyId=${encodeURIComponent(policy.id)}`}>
                          View findings
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </>
  )
}

function GovernanceMetric({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: number
  detail: string
  tone: 'neutral' | 'danger' | 'warning' | 'success'
}) {
  return (
    <article className={`governance-metric governance-metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}
