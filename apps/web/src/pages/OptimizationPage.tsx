import { Badge, Button, Select, Spinner } from '@fluentui/react-components'
import {
  AlertRegular,
  ArrowClockwiseRegular,
  ArrowTrendingRegular,
  CheckmarkCircleRegular,
  DataUsageRegular,
  LockClosedRegular,
  PersonRegular,
  WarningRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import type { ExposureFinding, ExposurePage } from '@agent-sentinel/domain'

import { exposureApi } from '../api/exposure-api'
import { PageHeading } from '../components/PageHeading'
import { useDemoState } from '../hooks/useDemoState'

type RecommendationCategory = 'security' | 'ownership' | 'lifecycle' | 'evidence'
type RecommendationPriority = 'critical' | 'high' | 'medium' | 'low'

interface OptimizationRecommendation {
  id: string
  category: RecommendationCategory
  priority: RecommendationPriority
  title: string
  rationale: string
  evidence: string
  impact: string
  approval: string
  approvalRequired: boolean
  verification: string
  actionLabel: string
  to: string
  simulationAvailable: boolean
}

function priorityForFinding(finding: ExposureFinding): RecommendationPriority {
  if (finding.severity === 'critical') return 'critical'
  if (finding.severity === 'high') return 'high'
  if (finding.severity === 'medium') return 'medium'
  return 'low'
}

function recommendationsFromFindings(findings: ExposureFinding[]): OptimizationRecommendation[] {
  return findings
    .filter((finding) => finding.status !== 'resolved' && finding.status !== 'mitigated')
    .map((finding) => ({
      id: `finding-${finding.id}`,
      category: 'security',
      priority: priorityForFinding(finding),
      title: finding.recommendation,
      rationale: finding.summary,
      evidence: `${finding.evidenceIds.length} cited evidence objects · ${finding.evidenceTypes
        .join(', ')
        .replaceAll('_', ' ')}`,
      impact: `Addresses a risk-score ${finding.riskScore} finding. Outcome remains unverified until validation is rerun.`,
      approval: 'Explicit approval required before any target-platform change.',
      approvalRequired: true,
      verification:
        'Re-run synthetic validation and confirm the intended business workflow still succeeds.',
      actionLabel: finding.affectedEdgeIds.length > 0 ? 'Preview response' : 'Review finding',
      to: `/exposure/${finding.id}`,
      simulationAvailable: finding.affectedEdgeIds.length > 0,
    }))
}

function recommendationIcon(category: RecommendationCategory) {
  if (category === 'security') return LockClosedRegular
  if (category === 'ownership') return PersonRegular
  if (category === 'lifecycle') return ArrowTrendingRegular
  return DataUsageRegular
}

export function OptimizationPage() {
  const { load: refreshState, state } = useDemoState()
  const [exposure, setExposure] = useState<ExposurePage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [category, setCategory] = useState<RecommendationCategory | ''>('')
  const [priority, setPriority] = useState<RecommendationPriority | ''>('')

  const loadFindings = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const findings: ExposureFinding[] = []
      let page = 1
      let total = Number.POSITIVE_INFINITY
      let firstPage: ExposurePage | undefined
      while (findings.length < total) {
        const result = await exposureApi.list({ page, pageSize: 200 })
        firstPage ??= result
        findings.push(...result.findings)
        total = result.total
        if (result.findings.length === 0) break
        page += 1
      }
      setExposure({
        findings,
        total: findings.length,
        facets: firstPage?.facets ?? { severity: {}, status: {}, policyId: {} },
        ...(firstPage?.freshness ? { freshness: firstPage.freshness } : {}),
      })
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Recommendations could not be generated.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void loadFindings(), [loadFindings])

  async function refreshAll() {
    await Promise.all([loadFindings(), refreshState()])
  }

  const recommendations = useMemo(() => {
    const items = recommendationsFromFindings(exposure?.findings ?? [])
    for (const agent of state?.snapshot.nodes.filter((node) => node.kind === 'agent') ?? []) {
      if (!agent.owner) {
        items.push({
          id: `owner-${agent.id}`,
          category: 'ownership',
          priority: 'high',
          title: `Assign an accountable owner to ${agent.name}`,
          rationale: 'The current graph contains no source-provided owner for this agent.',
          evidence: `${agent.evidenceIds.length} graph evidence references`,
          impact:
            'Improves accountability and lifecycle routing; operational outcome is not quantified.',
          approval: 'Owner assignment requires platform-governance review.',
          approvalRequired: true,
          verification:
            'Confirm the owner is present in the next authoritative discovery snapshot.',
          actionLabel: 'Review agent',
          to: `/agent-inventory/${agent.id}`,
          simulationAvailable: false,
        })
      }
      if (!agent.metadata.version) {
        items.push({
          id: `version-${agent.id}`,
          category: 'lifecycle',
          priority: 'medium',
          title: `Declare a version for ${agent.name}`,
          rationale: 'Version metadata is absent from the current source evidence.',
          evidence: `${agent.evidenceIds.length} graph evidence references`,
          impact: 'Enables future comparison and release evidence; no release outcome is claimed.',
          approval: 'Metadata correction follows the source platform release process.',
          approvalRequired: false,
          verification: 'Confirm version metadata appears in the next discovery snapshot.',
          actionLabel: 'Review lifecycle',
          to: '/lifecycle',
          simulationAvailable: false,
        })
      }
    }
    const staleBySource = new Map<string, number>()
    for (const evidence of state?.snapshot.evidence ?? []) {
      if (evidence.freshness === 'stale') {
        staleBySource.set(evidence.source, (staleBySource.get(evidence.source) ?? 0) + 1)
      }
    }
    for (const [source, count] of staleBySource) {
      items.push({
        id: `evidence-${source}`,
        category: 'evidence',
        priority: 'medium',
        title: `Refresh stale evidence from ${source}`,
        rationale: `${count} evidence objects are marked stale by the source model.`,
        evidence: `${count} stale evidence objects`,
        impact: 'Improves decision confidence; no security outcome is implied until reevaluation.',
        approval: 'Connector refresh follows configured read-only permissions.',
        approvalRequired: false,
        verification: 'Confirm freshness changes to live or recent after synchronization.',
        actionLabel: 'Open observability',
        to: '/observability',
        simulationAvailable: false,
      })
    }
    const order: Record<RecommendationPriority, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    }
    return items.sort((left, right) => order[left.priority] - order[right.priority])
  }, [exposure?.findings, state])

  const filtered = recommendations.filter(
    (recommendation) =>
      (!category || recommendation.category === category) &&
      (!priority || recommendation.priority === priority),
  )
  const summary = {
    total: recommendations.length,
    critical: recommendations.filter((item) => item.priority === 'critical').length,
    simulated: recommendations.filter((item) => item.simulationAvailable).length,
    approvals: recommendations.filter((item) => item.approvalRequired).length,
  }

  return (
    <>
      <PageHeading
        section="Optimization"
        title="Evidence-backed recommendations"
        description="Ranked security, ownership, lifecycle, and evidence actions generated from current findings and graph gaps."
        actions={
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={loading}
            onClick={() => void refreshAll()}
          >
            Refresh recommendations
          </Button>
        }
      />

      <section className="optimization-boundary">
        <WarningRegular />
        <div>
          <strong>Recommendation scope is bounded by available evidence</strong>
          <span>
            Cost, latency, reliability, quality, adoption, and sustainability recommendations are
            unavailable until their telemetry models are connected. No savings or outcome is
            estimated here.
          </span>
        </div>
      </section>

      {loading && exposure === undefined ? (
        <div className="optimization-state" role="status">
          <Spinner size="medium" label="Ranking evidence-backed recommendations…" />
        </div>
      ) : (
        <>
          {error ? (
            <div className="optimization-state optimization-state--error" role="alert">
              <AlertRegular />
              <div>
                <strong>Finding recommendations unavailable</strong>
                <span>
                  {error} · Graph-derived recommendations, when available, remain visible.
                </span>
              </div>
              <Button appearance="primary" onClick={() => void loadFindings()}>
                Try again
              </Button>
            </div>
          ) : null}
          <section className="optimization-summary" aria-label="Recommendation summary">
            <OptimizationMetric
              label="Recommendations"
              value={summary.total}
              detail="Evidence-backed actions"
            />
            <OptimizationMetric
              label="Critical priority"
              value={summary.critical}
              detail="Address first"
            />
            <OptimizationMetric
              label="What-if available"
              value={summary.simulated}
              detail="Non-destructive preview"
            />
            <OptimizationMetric
              label="Approval required"
              value={summary.approvals}
              detail="Before target changes"
            />
          </section>

          <div className="optimization-toolbar">
            <label>
              <span>Category</span>
              <Select
                aria-label="Filter recommendations by category"
                value={category}
                onChange={(_event, data) =>
                  setCategory((data.value as RecommendationCategory) || '')
                }
              >
                <option value="">All</option>
                <option value="security">Security</option>
                <option value="ownership">Ownership</option>
                <option value="lifecycle">Lifecycle</option>
                <option value="evidence">Evidence</option>
              </Select>
            </label>
            <label>
              <span>Priority</span>
              <Select
                aria-label="Filter recommendations by priority"
                value={priority}
                onChange={(_event, data) =>
                  setPriority((data.value as RecommendationPriority) || '')
                }
              >
                <option value="">All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </label>
            <strong>{filtered.length} actions</strong>
          </div>

          {filtered.length === 0 ? (
            <div className="optimization-empty">
              <CheckmarkCircleRegular />
              <h2>No recommendations match</h2>
              <p>No evidence-backed action matches the selected category and priority.</p>
            </div>
          ) : (
            <section className="recommendation-list" aria-label="Optimization recommendations">
              {filtered.map((recommendation) => {
                const Icon = recommendationIcon(recommendation.category)
                return (
                  <article className="recommendation-card" key={recommendation.id}>
                    <div className="recommendation-card__icon">
                      <Icon />
                    </div>
                    <div className="recommendation-card__body">
                      <div className="recommendation-card__title">
                        <div>
                          <span>{recommendation.category}</span>
                          <h2>{recommendation.title}</h2>
                        </div>
                        <Badge
                          appearance="tint"
                          color={
                            recommendation.priority === 'critical'
                              ? 'danger'
                              : recommendation.priority === 'high'
                                ? 'warning'
                                : 'informative'
                          }
                        >
                          {recommendation.priority}
                        </Badge>
                      </div>
                      <p>{recommendation.rationale}</p>
                      <div className="recommendation-evidence">
                        <div>
                          <span>Evidence</span>
                          <strong>{recommendation.evidence}</strong>
                        </div>
                        <div>
                          <span>Expected impact</span>
                          <strong>{recommendation.impact}</strong>
                        </div>
                        <div>
                          <span>Approval</span>
                          <strong>{recommendation.approval}</strong>
                        </div>
                        <div>
                          <span>Post-change verification</span>
                          <strong>{recommendation.verification}</strong>
                        </div>
                      </div>
                    </div>
                    <div className="recommendation-card__action">
                      {recommendation.simulationAvailable ? (
                        <Badge appearance="outline">Simulation available</Badge>
                      ) : (
                        <Badge appearance="outline">Review only</Badge>
                      )}
                      <Link to={recommendation.to}>{recommendation.actionLabel}</Link>
                    </div>
                  </article>
                )
              })}
            </section>
          )}
        </>
      )}
    </>
  )
}

function OptimizationMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <article className="optimization-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}
