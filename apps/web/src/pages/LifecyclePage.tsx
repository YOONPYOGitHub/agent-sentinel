import { Badge, ProgressBar, Select } from '@fluentui/react-components'
import {
  ArrowResetRegular,
  CheckmarkCircleRegular,
  ClockRegular,
  DesktopPulseRegular,
  WarningRegular,
} from '@fluentui/react-icons'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type {
  AgentSentinelState,
  ExposureFinding,
  GraphNode,
  ValidationRun,
} from '@agent-sentinel/domain'

import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'
import { useExposures } from '../hooks/useExposures'
import { agentLifecycleReadiness, type ExposureLoadState } from '../scorecard'

interface AgentLifecycleRow {
  agent: GraphNode
  version: string | undefined
  sourceLifecycle: string | undefined
  evidenceCount: number
  staleEvidence: number
  validationRuns: ValidationRun[]
  readinessChecks: number
  unknownChecks: number
  readinessStatus: 'complete' | 'attention'
}

function buildLifecycleRows(
  state: AgentSentinelState,
  liveExposures: ExposureFinding[] | ExposureLoadState,
): AgentLifecycleRow[] {
  const evidenceById = new Map(state.snapshot.evidence.map((item) => [item.id, item]))
  return state.snapshot.nodes
    .filter((node) => node.kind === 'agent')
    .map((agent) => {
      const evidence = agent.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is NonNullable<typeof item> => item !== undefined)
      const relatedFindings = state.findings.filter((finding) =>
        finding.path.nodeIds.includes(agent.id),
      )
      const relatedFindingIds = new Set(relatedFindings.map((finding) => finding.id))
      const validationRuns = state.validations.filter((validation) =>
        relatedFindingIds.has(validation.findingId),
      )
      const version = agent.metadata.version || undefined
      const staleEvidence = evidence.filter((item) => item.freshness === 'stale').length
      const { readinessChecks, unknownChecks, total } = agentLifecycleReadiness(
        agent,
        state,
        liveExposures,
      )
      const readinessStatus: AgentLifecycleRow['readinessStatus'] =
        readinessChecks === total ? 'complete' : 'attention'

      return {
        agent,
        version,
        sourceLifecycle: agent.metadata.lifecycle || agent.metadata.status || undefined,
        evidenceCount: evidence.length,
        staleEvidence,
        validationRuns,
        readinessChecks,
        unknownChecks,
        readinessStatus,
      }
    })
    .sort((left, right) => left.agent.name.localeCompare(right.agent.name))
}

export function LifecyclePage() {
  const { state } = useDemoState()
  const [environment, setEnvironment] = useState('')
  const [status, setStatus] = useState<'complete' | 'attention' | ''>('')
  const liveExposures = useExposures()
  const rows = useMemo(
    () => (state ? buildLifecycleRows(state, liveExposures) : []),
    [state, liveExposures],
  )
  const environments = useMemo(
    () => [...new Set(rows.map((row) => row.agent.environment))].sort(),
    [rows],
  )
  const filtered = rows.filter(
    (row) =>
      (!environment || row.agent.environment === environment) &&
      (!status || row.readinessStatus === status),
  )
  const summary = {
    agents: rows.length,
    versioned: rows.filter((row) => row.version).length,
    owned: rows.filter((row) => row.agent.owner).length,
    attention: rows.filter((row) => row.readinessStatus === 'attention').length,
  }

  return (
    <>
      <PageHeading
        section="Lifecycle"
        title="Lifecycle evidence"
        description="Version, ownership, environment, source lifecycle, and evidence readiness for every discovered agent."
        actions={
          <Link className="lifecycle-readiness-link" to="/release-readiness">
            <DesktopPulseRegular aria-hidden="true" />
            Review release readiness
          </Link>
        }
      />

      <section className="lifecycle-boundary">
        <ArrowResetRegular />
        <div>
          <strong>Current-version evidence, not full release orchestration</strong>
          <span>
            Version lineage, promotion approvals, canary history, rollback events, and retirement
            execution are not connected. Missing records lower readiness instead of implying release
            safety.
          </span>
        </div>
      </section>

      <section className="lifecycle-summary" aria-label="Lifecycle summary">
        <LifecycleMetric
          label="Discovered agents"
          value={summary.agents}
          detail="Current graph inventory"
        />
        <LifecycleMetric
          label="Version declared"
          value={summary.versioned}
          detail="Source-provided version metadata"
        />
        <LifecycleMetric
          label="Owner declared"
          value={summary.owned}
          detail="Accountable owner in evidence"
        />
        <LifecycleMetric
          label="Need attention"
          value={summary.attention}
          detail="One or more readiness gaps"
        />
      </section>

      <div className="lifecycle-toolbar">
        <label>
          <span>Environment</span>
          <Select
            aria-label="Filter lifecycle by environment"
            value={environment}
            onChange={(_event, data) => setEnvironment(data.value)}
          >
            <option value="">All</option>
            {environments.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>Evidence readiness</span>
          <Select
            aria-label="Filter lifecycle by readiness"
            value={status}
            onChange={(_event, data) => setStatus((data.value as 'complete' | 'attention') || '')}
          >
            <option value="">All</option>
            <option value="complete">Complete checks</option>
            <option value="attention">Needs attention</option>
          </Select>
        </label>
        <strong>{filtered.length} agents</strong>
      </div>

      <section className="lifecycle-table-card" aria-labelledby="lifecycle-table-title">
        <div className="lifecycle-table-card__header">
          <div>
            <span className="eyebrow">CURRENT VERSIONS</span>
            <h2 id="lifecycle-table-title">Agent readiness evidence</h2>
          </div>
          <span>5 evidence checks per agent</span>
        </div>
        <div className="lifecycle-table-wrapper">
          <table className="lifecycle-table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Version</th>
                <th>Environment</th>
                <th>Source lifecycle</th>
                <th>Owner</th>
                <th>Readiness</th>
                <th>Evidence</th>
                <th>Validation</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.agent.id}>
                  <td>
                    <strong>{row.agent.name}</strong>
                    <span>{row.agent.metadata.platform ?? 'Platform not provided'}</span>
                  </td>
                  <td>{row.version ?? 'Not provided'}</td>
                  <td>{row.agent.environment}</td>
                  <td>{row.sourceLifecycle ?? 'Not provided'}</td>
                  <td>{row.agent.owner ?? 'Unassigned'}</td>
                  <td>
                    <div className="lifecycle-readiness">
                      <div>
                        {row.readinessStatus === 'complete' ? (
                          <CheckmarkCircleRegular />
                        ) : (
                          <WarningRegular />
                        )}
                        <span>
                          {row.readinessStatus === 'complete'
                            ? 'Checks complete'
                            : 'Needs attention'}
                        </span>
                        <strong>{row.readinessChecks}/5</strong>
                        {row.unknownChecks > 0 ? (
                          <small>{row.unknownChecks} not evaluated</small>
                        ) : null}
                      </div>
                      <ProgressBar
                        aria-label={`${row.agent.name} evidence readiness ${row.readinessChecks} of 5 checks`}
                        value={row.readinessChecks / 5}
                        color={row.readinessStatus === 'complete' ? 'success' : 'warning'}
                        thickness="medium"
                      />
                    </div>
                  </td>
                  <td>
                    {row.evidenceCount} objects
                    {row.staleEvidence > 0 ? ` · ${row.staleEvidence} stale` : ''}
                  </td>
                  <td>
                    {row.validationRuns.length > 0 ? (
                      <Badge
                        color={
                          row.validationRuns[0]?.status === 'validated'
                            ? 'success'
                            : row.validationRuns[0]?.status === 'failed' ||
                                row.validationRuns[0]?.status === 'not-reproduced'
                              ? 'danger'
                              : 'warning'
                        }
                        appearance="tint"
                      >
                        {row.validationRuns.length} · {row.validationRuns[0]?.status}
                      </Badge>
                    ) : (
                      <span className="lifecycle-unavailable">
                        <ClockRegular /> Not recorded
                      </span>
                    )}
                  </td>
                  <td>
                    <Link to={`/agent-inventory/${row.agent.id}`}>View agent</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

function LifecycleMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <article className="lifecycle-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}
