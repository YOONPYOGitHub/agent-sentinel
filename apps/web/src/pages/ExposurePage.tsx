import {
  Badge,
  Button,
  Input,
  Select,
  Spinner,
} from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowClockwiseRegular,
  BotRegular,
  SearchRegular,
  ShieldCheckmarkRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type {
  ExposureFindingSeverity,
  ExposureFindingStatus,
  ExposurePage as ExposurePageDto,
} from '@agent-sentinel/domain'

import { exposureApi, type ExposureListParams } from '../api/exposure-api'
import { PageHeading } from '../components/PageHeading'

const severityOrder: ExposureFindingSeverity[] = ['critical', 'high', 'medium', 'low']

type SortKey = 'riskScore' | 'severity' | 'affectedAgentName' | 'policyId' | 'lastSeen'

function severityRank(severity: ExposureFindingSeverity): number {
  return severityOrder.indexOf(severity)
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function isStale(generatedAt: string | undefined): boolean {
  if (!generatedAt) return false
  const generated = new Date(generatedAt).getTime()
  if (Number.isNaN(generated)) return false
  return Date.now() - generated > 10 * 60 * 1000
}

export function ExposurePage() {
  const [data, setData] = useState<ExposurePageDto | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [severity, setSeverity] = useState<ExposureFindingSeverity | ''>('')
  const [status, setStatus] = useState<ExposureFindingStatus | ''>('')
  const [policyId, setPolicyId] = useState('')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('riskScore')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    const params: ExposureListParams = {}
    if (severity) params.severity = severity
    if (status) params.status = status
    if (policyId) params.policyId = policyId
    if (search.trim().length > 0) params.search = search.trim()
    try {
      const page = await exposureApi.list(params)
      setData(page)
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Unable to load exposures.')
    } finally {
      setLoading(false)
    }
  }, [policyId, search, severity, status])

  useEffect(() => {
    void fetchData()
  }, [fetchData])

  const findings = useMemo(() => {
    const list = data?.findings ?? []
    return [...list].sort((left, right) => {
      const direction = sortDir === 'asc' ? 1 : -1
      switch (sortKey) {
        case 'severity':
          return (severityRank(right.severity) - severityRank(left.severity)) * direction
        case 'affectedAgentName':
          return left.affectedAgentName.localeCompare(right.affectedAgentName) * direction
        case 'policyId':
          return left.policyId.localeCompare(right.policyId) * direction
        case 'lastSeen':
          return left.lastSeen.localeCompare(right.lastSeen) * direction
        case 'riskScore':
        default:
          return (left.riskScore - right.riskScore) * direction
      }
    })
  }, [data?.findings, sortDir, sortKey])

  const kpis = useMemo(() => {
    const list = data?.findings ?? []
    const criticalCount = list.filter((finding) => finding.severity === 'critical').length
    const highCount = list.filter((finding) => finding.severity === 'high').length
    const openCount = list.filter((finding) => finding.status === 'open').length
    const affectedAgents = new Set(list.map((finding) => finding.affectedAgentId)).size
    return { criticalCount, highCount, openCount, affectedAgents }
  }, [data?.findings])

  const policyOptions = useMemo(() => {
    const set = new Set<string>()
    for (const finding of data?.findings ?? []) set.add(finding.policyId)
    return [...set].sort()
  }, [data?.findings])

  const stale = isStale(data?.freshness?.generatedAt)

  function toggleSort(next: SortKey) {
    if (next === sortKey) {
      setSortDir((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(next)
      setSortDir('desc')
    }
  }

  return (
    <>
      <PageHeading
        section="Exposure management"
        title="Exposure findings"
        description="Declared-configuration policy violations across your agent estate."
      />

      <div className="exposure-kpis" role="group" aria-label="Exposure summary">
        <KpiCard label="Critical" value={kpis.criticalCount} tone="critical" />
        <KpiCard label="High" value={kpis.highCount} tone="high" />
        <KpiCard label="Open" value={kpis.openCount} tone="neutral" />
        <KpiCard label="Affected agents" value={kpis.affectedAgents} tone="neutral" />
        <KpiCard
          label="Last snapshot"
          value={data?.freshness?.generatedAt ? formatDateTime(data.freshness.generatedAt) : '—'}
          tone={stale ? 'warning' : 'neutral'}
          compact
        />
      </div>

      {data?.freshness ? (
        <div className={`exposure-source ${stale ? 'exposure-source--stale' : ''}`}>
          <span className="exposure-source-badge">
            Source: {data.freshness.sourceMode === 'foundry' ? 'Live (Foundry)' : 'Mock'}
          </span>
          {stale ? <span className="exposure-stale">Data is more than 10 minutes old</span> : null}
        </div>
      ) : null}

      <div className="exposure-filters">
        <div className="exposure-search">
          <SearchRegular aria-hidden="true" />
          <Input
            appearance="underline"
            aria-label="Search exposure findings"
            placeholder="Search title, summary, agent, policy"
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
          />
        </div>
        <label>
          <span>Severity</span>
          <Select
            value={severity}
            onChange={(_event, data) =>
              setSeverity((data.value as ExposureFindingSeverity) || '')
            }
          >
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </label>
        <label>
          <span>Status</span>
          <Select
            value={status}
            onChange={(_event, data) =>
              setStatus((data.value as ExposureFindingStatus) || '')
            }
          >
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="validated">Validated</option>
            <option value="mitigated">Mitigated</option>
            <option value="resolved">Resolved</option>
          </Select>
        </label>
        <label>
          <span>Policy</span>
          <Select value={policyId} onChange={(_event, data) => setPolicyId(data.value)}>
            <option value="">All</option>
            {policyOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </label>
        <Button
          appearance="subtle"
          icon={<ArrowClockwiseRegular />}
          onClick={() => void fetchData()}
          aria-label="Refresh exposures"
        >
          Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="exposure-skeleton" data-testid="exposure-loading">
          <Spinner size="medium" label="Loading exposure findings…" />
        </div>
      ) : null}

      {error ? (
        <div className="exposure-error" role="alert">
          <AlertRegular aria-hidden="true" />
          <div>
            <strong>Unable to load exposures</strong>
            <p>{error}</p>
            <Button appearance="primary" onClick={() => void fetchData()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}

      {!loading && !error && findings.length === 0 ? (
        <div className="exposure-empty">
          <ShieldCheckmarkRegular />
          <h2>No exposures found</h2>
          <p>No findings match the current filters.</p>
        </div>
      ) : null}

      {findings.length > 0 ? (
        <div className="exposure-table-wrapper">
          <table className="exposure-table">
            <thead>
              <tr>
                <th>
                  <button type="button" onClick={() => toggleSort('severity')}>
                    Severity
                  </button>
                </th>
                <th>
                  <button type="button" onClick={() => toggleSort('affectedAgentName')}>
                    Agent
                  </button>
                </th>
                <th>Policy</th>
                <th>Title</th>
                <th>
                  <button type="button" onClick={() => toggleSort('riskScore')}>
                    Risk
                  </button>
                </th>
                <th>Status</th>
                <th>
                  <button type="button" onClick={() => toggleSort('lastSeen')}>
                    Last seen
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {findings.map((finding) => (
                <tr key={finding.id}>
                  <td>
                    <SeverityBadge severity={finding.severity} />
                  </td>
                  <td>
                    <span className="agent-cell">
                      <BotRegular aria-hidden="true" />
                      {finding.affectedAgentName}
                    </span>
                  </td>
                  <td>
                    <Badge appearance="outline">{finding.policyId}</Badge>
                  </td>
                  <td>
                    <Link to={`/exposure/${finding.id}`}>{finding.title}</Link>
                  </td>
                  <td>{finding.riskScore}</td>
                  <td>
                    <StatusBadge status={finding.status} />
                  </td>
                  <td>{formatDateTime(finding.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  )
}

function KpiCard({
  label,
  value,
  tone,
  compact = false,
}: {
  label: string
  value: number | string
  tone: 'critical' | 'high' | 'warning' | 'neutral'
  compact?: boolean
}) {
  return (
    <div className={`exposure-kpi exposure-kpi--${tone}${compact ? ' exposure-kpi--compact' : ''}`}>
      <span className="exposure-kpi-label">{label}</span>
      <strong className="exposure-kpi-value">{value}</strong>
    </div>
  )
}

function SeverityBadge({ severity }: { severity: ExposureFindingSeverity }) {
  return <Badge className={`severity-badge severity-badge--${severity}`}>{severity}</Badge>
}

function StatusBadge({ status }: { status: ExposureFindingStatus }) {
  return <Badge className={`status-badge status-badge--${status}`}>{status}</Badge>
}
