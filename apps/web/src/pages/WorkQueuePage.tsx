import {
  Badge,
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  Tooltip,
} from '@fluentui/react-components'
import { AlertRegular, ArrowClockwiseRegular, SearchRegular } from '@fluentui/react-icons'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import {
  computeOverdue,
  validTransitionsForCase,
  type GovernanceActorCapability,
  type GovernanceCase,
  type GovernanceCaseDetail,
  type GovernanceCaseKind,
  type GovernanceCaseStatus,
  type GovernanceCaseTransitionOp,
  type GovernanceLifecycleAction,
  type GovernanceQueuePage,
} from '@agent-sentinel/domain'

import {
  governanceQueueApi,
  type GovernanceQueueCreateBody,
  type GovernanceQueueListParams,
} from '../api/governance-queue-api'
import { PageHeading } from '../components/PageHeading'
import { useAuth } from '../hooks/useAuth'
import { useDemoState } from '../hooks/useDemoState'
import { usePermission, usePermissionMessage } from '../hooks/usePermission'

const operationCapabilityMap: Record<GovernanceCaseTransitionOp, GovernanceActorCapability> = {
  create: 'proposeRemediation',
  'pick-up': 'validateFinding',
  propose: 'proposeRemediation',
  'reject-finding': 'validateFinding',
  withdraw: 'configure',
  approve: 'approveRemediation',
  reject: 'approveRemediation',
  close: 'executeRemediation',
  reopen: 'proposeRemediation',
  're-evaluate': 'validateFinding',
  expire: 'configure',
  promote: 'executeRemediation',
  'acknowledge-drift': 'validateFinding',
  rollback: 'executeRemediation',
  retire: 'executeRemediation',
}

const statusOptions: GovernanceCaseStatus[] = [
  'open',
  'in-review',
  'pending-approval',
  'approved',
  'rejected',
  'expired',
  'closed',
]

const kindOptions: GovernanceCaseKind[] = [
  'finding-review',
  'remediation-proposal',
  'policy-exception',
  'lifecycle-review',
]

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

function formatAge(value: string): string {
  const createdAt = Date.parse(value)
  if (Number.isNaN(createdAt)) {
    return value
  }

  const ageMs = Date.now() - createdAt
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000))
  if (ageDays >= 1) {
    return `${ageDays}d`
  }

  const ageHours = Math.max(0, Math.floor(ageMs / (60 * 60 * 1000)))
  return `${ageHours}h`
}

function humanizeKind(kind: GovernanceCaseKind): string {
  switch (kind) {
    case 'finding-review':
      return 'Finding review'
    case 'remediation-proposal':
      return 'Remediation proposal'
    case 'policy-exception':
      return 'Policy exception'
    case 'lifecycle-review':
      return 'Lifecycle review'
  }
}

function humanizeStatus(status: GovernanceCaseStatus): string {
  switch (status) {
    case 'open':
      return 'Open'
    case 'in-review':
      return 'In review'
    case 'pending-approval':
      return 'Pending approval'
    case 'approved':
      return 'Approved'
    case 'rejected':
      return 'Rejected'
    case 'expired':
      return 'Expired'
    case 'closed':
      return 'Closed'
  }
}

function humanizeOperation(operation: GovernanceCaseTransitionOp): string {
  switch (operation) {
    case 'create':
      return 'Created'
    case 'pick-up':
      return 'Pick up'
    case 'propose':
      return 'Propose'
    case 'reject-finding':
      return 'Reject finding'
    case 'withdraw':
      return 'Withdraw'
    case 'approve':
      return 'Approve'
    case 'reject':
      return 'Reject'
    case 'close':
      return 'Close'
    case 'reopen':
      return 'Reopen'
    case 're-evaluate':
      return 'Re-evaluate'
    case 'expire':
      return 'Expire'
    case 'promote':
      return 'Promote'
    case 'acknowledge-drift':
      return 'Acknowledge drift'
    case 'rollback':
      return 'Rollback'
    case 'retire':
      return 'Retire'
  }
}

function createIdempotencyKey(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}`
}

export function WorkQueuePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { connectorStatus } = useDemoState()
  const { principal } = useAuth()
  const canCreate = usePermission('proposeRemediation')
  const canValidate = usePermission('validateFinding')
  const canPropose = usePermission('proposeRemediation')
  const canApprove = usePermission('approveRemediation')
  const canExecute = usePermission('executeRemediation')
  const canConfigure = usePermission('configure')
  const createPermissionMessage = usePermissionMessage('proposeRemediation')
  const validatePermissionMessage = usePermissionMessage('validateFinding')
  const proposePermissionMessage = usePermissionMessage('proposeRemediation')
  const approvePermissionMessage = usePermissionMessage('approveRemediation')
  const executePermissionMessage = usePermissionMessage('executeRemediation')
  const configurePermissionMessage = usePermissionMessage('configure')

  const [statusFilter, setStatusFilter] = useState<GovernanceCaseStatus | ''>('')
  const [kindFilter, setKindFilter] = useState<GovernanceCaseKind | ''>('')
  const [search, setSearch] = useState('')
  const [queuePage, setQueuePage] = useState<GovernanceQueuePage | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [expandedCaseIds, setExpandedCaseIds] = useState<string[]>([])
  const [detailsById, setDetailsById] = useState<Record<string, GovernanceCaseDetail>>({})
  const [detailLoadingById, setDetailLoadingById] = useState<Record<string, boolean>>({})
  const [detailErrorById, setDetailErrorById] = useState<Record<string, string>>({})
  const [actionCaseId, setActionCaseId] = useState<string | undefined>(undefined)
  const [reEvaluationById, setReEvaluationById] = useState<
    Record<string, { expiresAt: string; evidenceSnapshotId: string }>
  >({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createKind, setCreateKind] = useState<GovernanceCaseKind>('remediation-proposal')
  const [createTitle, setCreateTitle] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [createFindingId, setCreateFindingId] = useState('')
  const [createAgentId, setCreateAgentId] = useState('')
  const [createPolicyId, setCreatePolicyId] = useState('')
  const [createAssigneeIdentity, setCreateAssigneeIdentity] = useState('')
  const [createExpiresAt, setCreateExpiresAt] = useState('')
  const [createLifecycleAction, setCreateLifecycleAction] =
    useState<GovernanceLifecycleAction>('promote')
  const [createEvidenceSnapshotIds, setCreateEvidenceSnapshotIds] = useState<string[]>([])
  const [createError, setCreateError] = useState<string | undefined>(undefined)

  const viewerIdentity = useMemo(
    () =>
      principal?.preferredUsername ??
      principal?.displayName ??
      principal?.objectId ??
      principal?.subject,
    [principal],
  )
  const writeEnabled = connectorStatus?.writeEnabled !== false

  useEffect(() => {
    if (searchParams.get('create') !== 'remediation-proposal' || !canCreate) {
      return
    }

    const findingId = searchParams.get('findingId')?.trim() ?? ''
    const agentId = searchParams.get('agentId')?.trim() ?? ''
    const policyId = searchParams.get('policyId')?.trim() ?? ''
    const snapshotId = searchParams.get('snapshotId')?.trim() ?? ''
    setCreateKind('remediation-proposal')
    setCreateTitle(findingId ? `Review finding ${findingId}` : 'Review exposure finding')
    setCreateDescription(
      'Review the cited evidence and prepare a remediation proposal for approval.',
    )
    setCreateFindingId(findingId)
    setCreateAgentId(agentId)
    setCreatePolicyId(policyId)
    setCreateEvidenceSnapshotIds(snapshotId ? [snapshotId] : [])
    setCreateOpen(true)
    setSearchParams({}, { replace: true })
  }, [canCreate, searchParams, setSearchParams])

  const permissionByCapability = useMemo(
    () => ({
      validateFinding: { can: canValidate, message: validatePermissionMessage },
      proposeRemediation: { can: canPropose, message: proposePermissionMessage },
      approveRemediation: { can: canApprove, message: approvePermissionMessage },
      executeRemediation: { can: canExecute, message: executePermissionMessage },
      configure: { can: canConfigure, message: configurePermissionMessage },
      read: { can: true, message: null },
      generateAdvisory: { can: true, message: null },
    }),
    [
      approvePermissionMessage,
      canApprove,
      canConfigure,
      canExecute,
      canPropose,
      canValidate,
      configurePermissionMessage,
      executePermissionMessage,
      proposePermissionMessage,
      validatePermissionMessage,
    ],
  )

  const loadQueue = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    const params: GovernanceQueueListParams = {}
    if (statusFilter) params.status = statusFilter
    if (kindFilter) params.kind = kindFilter
    if (search.trim().length > 0) params.search = search.trim()

    try {
      setQueuePage(await governanceQueueApi.list(params))
    } catch (caught: unknown) {
      setError(
        caught instanceof Error ? caught.message : 'The governance queue could not be loaded.',
      )
    } finally {
      setLoading(false)
    }
  }, [kindFilter, search, statusFilter])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const loadDetail = useCallback(async (caseId: string) => {
    setDetailLoadingById((current) => ({ ...current, [caseId]: true }))
    setDetailErrorById((current) => ({ ...current, [caseId]: '' }))
    try {
      const detail = await governanceQueueApi.get(caseId)
      setDetailsById((current) => ({ ...current, [caseId]: detail }))
    } catch (caught: unknown) {
      setDetailErrorById((current) => ({
        ...current,
        [caseId]: caught instanceof Error ? caught.message : 'Case detail could not be loaded.',
      }))
    } finally {
      setDetailLoadingById((current) => ({ ...current, [caseId]: false }))
    }
  }, [])

  const toggleExpanded = useCallback(
    (caseId: string) => {
      setExpandedCaseIds((current) => {
        if (current.includes(caseId)) {
          return current.filter((value) => value !== caseId)
        }
        return [...current, caseId]
      })
      if (detailsById[caseId] === undefined && detailLoadingById[caseId] !== true) {
        void loadDetail(caseId)
      }
    },
    [detailLoadingById, detailsById, loadDetail],
  )

  const handleCreate = useCallback(async () => {
    setCreateError(undefined)
    const body: GovernanceQueueCreateBody = {
      kind: createKind,
      title: createTitle,
      description: createDescription,
      ...(viewerIdentity !== undefined ? { actorIdentity: viewerIdentity } : {}),
      ...(principal?.roles[0] !== undefined ? { actorRole: principal.roles[0] } : {}),
      ...(createFindingId.trim().length > 0 ? { findingId: createFindingId.trim() } : {}),
      ...(createAgentId.trim().length > 0 ? { agentId: createAgentId.trim() } : {}),
      ...(createPolicyId.trim().length > 0 ? { policyId: createPolicyId.trim() } : {}),
      ...(createAssigneeIdentity.trim().length > 0
        ? { assigneeIdentity: createAssigneeIdentity.trim() }
        : {}),
      ...(createKind === 'policy-exception' && createExpiresAt
        ? { expiresAt: new Date(createExpiresAt).toISOString() }
        : {}),
      ...(createKind === 'lifecycle-review' ? { lifecycleAction: createLifecycleAction } : {}),
      ...(createEvidenceSnapshotIds.length > 0
        ? { evidenceSnapshotIds: createEvidenceSnapshotIds }
        : {}),
      idempotencyKey: createIdempotencyKey('queue-create'),
    }

    try {
      await governanceQueueApi.create(body)
      setCreateOpen(false)
      setCreateTitle('')
      setCreateDescription('')
      setCreateFindingId('')
      setCreateAgentId('')
      setCreatePolicyId('')
      setCreateAssigneeIdentity('')
      setCreateExpiresAt('')
      setCreateEvidenceSnapshotIds([])
      await loadQueue()
    } catch (caught: unknown) {
      setCreateError(caught instanceof Error ? caught.message : 'The case could not be created.')
    }
  }, [
    createAgentId,
    createDescription,
    createFindingId,
    createKind,
    createLifecycleAction,
    createPolicyId,
    createAssigneeIdentity,
    createExpiresAt,
    createEvidenceSnapshotIds,
    createTitle,
    loadQueue,
    principal?.roles,
    viewerIdentity,
  ])

  const performTransition = useCallback(
    async (caseRecord: GovernanceCase, operation: GovernanceCaseTransitionOp) => {
      setActionCaseId(caseRecord.id)
      try {
        const reEvaluation = reEvaluationById[caseRecord.id]
        const detail = await governanceQueueApi.transition(caseRecord.id, {
          operation,
          ...(viewerIdentity !== undefined ? { actorIdentity: viewerIdentity } : {}),
          ...(principal?.roles[0] !== undefined ? { actorRole: principal.roles[0] } : {}),
          ...(operation === 'pick-up' && caseRecord.assigneeIdentity !== undefined
            ? { assigneeIdentity: caseRecord.assigneeIdentity }
            : {}),
          ...(operation === 're-evaluate' && caseRecord.kind === 'policy-exception'
            ? {
                ...(reEvaluation?.expiresAt
                  ? { expiresAt: new Date(reEvaluation.expiresAt).toISOString() }
                  : {}),
                ...(reEvaluation?.evidenceSnapshotId
                  ? { evidenceSnapshotIds: [reEvaluation.evidenceSnapshotId] }
                  : {}),
              }
            : {}),
          idempotencyKey: createIdempotencyKey(`${caseRecord.id}-${operation}`),
        })
        setDetailsById((current) => ({ ...current, [caseRecord.id]: detail }))
        if (operation === 're-evaluate') {
          setReEvaluationById((current) => {
            const next = { ...current }
            delete next[caseRecord.id]
            return next
          })
        }
        await loadQueue()
      } catch (caught: unknown) {
        setError(
          caught instanceof Error ? caught.message : 'The transition could not be completed.',
        )
      } finally {
        setActionCaseId(undefined)
      }
    },
    [loadQueue, principal?.roles, reEvaluationById, viewerIdentity],
  )

  const summary = queuePage?.summary

  return (
    <>
      <PageHeading
        section="Governance"
        title="Governance work queue"
        description="Deterministic lifecycle workflow for evidence-backed review, approval, and closure decisions."
        actions={
          <div className="work-queue-heading-actions">
            <Button
              appearance="secondary"
              icon={<ArrowClockwiseRegular />}
              disabled={loading}
              onClick={() => void loadQueue()}
            >
              Refresh
            </Button>
            {createPermissionMessage !== null ? (
              <Tooltip content={createPermissionMessage} relationship="label">
                <span>
                  <Button
                    appearance="primary"
                    disabled={!canCreate}
                    onClick={() => setCreateOpen((value) => !value)}
                  >
                    Create case
                  </Button>
                </span>
              </Tooltip>
            ) : (
              <Button
                appearance="primary"
                disabled={!canCreate}
                onClick={() => setCreateOpen((value) => !value)}
              >
                Create case
              </Button>
            )}
          </div>
        }
      />

      <section className="work-queue-summary" aria-label="Governance queue summary">
        <div className="work-queue-mode-indicator">
          {summary?.sourceMode === 'mock'
            ? '[Mock] Deterministic queue data'
            : 'Foundry workflow boundary'}
        </div>
        {[
          { label: 'Open', value: summary?.byStatus.open ?? 0 },
          { label: 'In review', value: summary?.byStatus['in-review'] ?? 0 },
          { label: 'Pending approval', value: summary?.byStatus['pending-approval'] ?? 0 },
          { label: 'Approved', value: summary?.byStatus.approved ?? 0 },
          { label: 'Rejected', value: summary?.byStatus.rejected ?? 0 },
          { label: 'Expired', value: summary?.byStatus.expired ?? 0 },
        ].map((item) => (
          <article key={item.label} className="work-queue-summary-card">
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </article>
        ))}
      </section>

      <p className="work-queue-separation-note">
        Separation of duties: proposers cannot approve their own remediation or exception decisions.
      </p>

      {summary?.persistenceAvailable === false ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            {summary.persistenceNote ??
              'Live persistence unavailable – workflow state requires a dedicated Cosmos container. Cases shown are synthetic.'}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {createOpen ? (
        <section className="work-queue-create-card" aria-label="Create governance case">
          <div className="work-queue-create-grid">
            <label>
              <span>Kind</span>
              <Select
                value={createKind}
                onChange={(_event, data) => setCreateKind(data.value as GovernanceCaseKind)}
              >
                {kindOptions.map((kind) => (
                  <option key={kind} value={kind}>
                    {humanizeKind(kind)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="work-queue-create-grid__wide">
              <span>Title</span>
              <Input value={createTitle} onChange={(_event, data) => setCreateTitle(data.value)} />
            </label>
            <label className="work-queue-create-grid__wide">
              <span>Description</span>
              <Input
                value={createDescription}
                onChange={(_event, data) => setCreateDescription(data.value)}
              />
            </label>
            <label>
              <span>Finding ID</span>
              <Input
                value={createFindingId}
                onChange={(_event, data) => setCreateFindingId(data.value)}
              />
            </label>
            <label>
              <span>Agent ID</span>
              <Input
                value={createAgentId}
                onChange={(_event, data) => setCreateAgentId(data.value)}
              />
            </label>
            <label>
              <span>Policy ID</span>
              <Input
                value={createPolicyId}
                onChange={(_event, data) => setCreatePolicyId(data.value)}
              />
            </label>
            <label>
              <span>Assignee</span>
              <Input
                value={createAssigneeIdentity}
                onChange={(_event, data) => setCreateAssigneeIdentity(data.value)}
              />
            </label>
            {createKind === 'policy-exception' ? (
              <label>
                <span>Exception expiry</span>
                <Input
                  type="datetime-local"
                  value={createExpiresAt}
                  onChange={(_event, data) => setCreateExpiresAt(data.value)}
                />
              </label>
            ) : null}
            {createKind === 'lifecycle-review' ? (
              <label>
                <span>Lifecycle action</span>
                <Select
                  value={createLifecycleAction}
                  onChange={(_event, data) =>
                    setCreateLifecycleAction(data.value as GovernanceLifecycleAction)
                  }
                >
                  <option value="promote">Promote</option>
                  <option value="acknowledge-drift">Acknowledge drift</option>
                  <option value="rollback">Rollback</option>
                  <option value="retire">Retire</option>
                </Select>
              </label>
            ) : null}
            <label>
              <span>Evidence snapshot ID</span>
              <Input
                value={createEvidenceSnapshotIds[0] ?? ''}
                onChange={(_event, data) =>
                  setCreateEvidenceSnapshotIds(data.value.trim() ? [data.value.trim()] : [])
                }
              />
            </label>
          </div>
          {createError ? (
            <div className="work-queue-inline-error" role="alert">
              {createError}
            </div>
          ) : null}
          <div className="work-queue-create-actions">
            <Button appearance="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              appearance="primary"
              disabled={
                createTitle.trim().length === 0 ||
                createDescription.trim().length === 0 ||
                (createKind === 'policy-exception' &&
                  (createPolicyId.trim().length === 0 ||
                    createExpiresAt.length === 0 ||
                    createEvidenceSnapshotIds.length === 0)) ||
                (createKind === 'lifecycle-review' &&
                  (createAgentId.trim().length === 0 || createEvidenceSnapshotIds.length === 0))
              }
              onClick={() => void handleCreate()}
            >
              Save case
            </Button>
          </div>
        </section>
      ) : null}

      <section className="work-queue-filters" aria-label="Queue filters">
        <div className="work-queue-search">
          <SearchRegular aria-hidden="true" />
          <Input
            appearance="underline"
            aria-label="Search governance cases"
            placeholder="Search title, description, finding, agent"
            value={search}
            onChange={(_event, data) => setSearch(data.value)}
          />
        </div>
        <label>
          <span>Status</span>
          <Select
            value={statusFilter}
            onChange={(_event, data) => setStatusFilter((data.value as GovernanceCaseStatus) || '')}
          >
            <option value="">All</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {humanizeStatus(status)}
              </option>
            ))}
          </Select>
        </label>
        <label>
          <span>Kind</span>
          <Select
            value={kindFilter}
            onChange={(_event, data) => setKindFilter((data.value as GovernanceCaseKind) || '')}
          >
            <option value="">All</option>
            {kindOptions.map((kind) => (
              <option key={kind} value={kind}>
                {humanizeKind(kind)}
              </option>
            ))}
          </Select>
        </label>
        <Button
          appearance="subtle"
          icon={<ArrowClockwiseRegular />}
          onClick={() => void loadQueue()}
        >
          Refresh
        </Button>
      </section>

      {loading && queuePage === undefined ? (
        <div className="work-queue-state" data-testid="work-queue-loading" role="status">
          <Spinner size="medium" label="Loading governance queue…" />
        </div>
      ) : error ? (
        <div className="work-queue-state work-queue-state--error" role="alert">
          <AlertRegular />
          <div>
            <strong>Governance queue unavailable</strong>
            <span>{error}</span>
          </div>
          <Button appearance="primary" onClick={() => void loadQueue()}>
            Try again
          </Button>
        </div>
      ) : queuePage && queuePage.cases.length === 0 ? (
        <div className="work-queue-state">
          <strong>No governance cases</strong>
          <span>No cases match the current filters.</span>
        </div>
      ) : queuePage ? (
        <section className="work-queue-table-card" aria-labelledby="work-queue-table-title">
          <div className="work-queue-table-card__header">
            <div>
              <span className="eyebrow">WORKFLOW</span>
              <h2 id="work-queue-table-title">Open governance cases</h2>
            </div>
            <span>{queuePage.total} cases</span>
          </div>
          <div className="work-queue-table-wrapper">
            <table className="work-queue-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Created by</th>
                  <th>Assignee</th>
                  <th>Age / SLA</th>
                  <th>Finding / Agent</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {queuePage.cases.map((caseRecord) => {
                  const overdue = computeOverdue(caseRecord.status, caseRecord.lastTransitionAt)
                  const operations = validTransitionsForCase(caseRecord)
                  const detail = detailsById[caseRecord.id]
                  const detailLoading = detailLoadingById[caseRecord.id] === true
                  const detailError = detailErrorById[caseRecord.id]
                  const isExpanded = expandedCaseIds.includes(caseRecord.id)
                  const closeNoteVisible = operations.includes('close') && !writeEnabled
                  return (
                    <Fragment key={caseRecord.id}>
                      <tr key={caseRecord.id}>
                        <td>
                          <strong>{caseRecord.title}</strong>
                          <span>{caseRecord.id}</span>
                          <small>{caseRecord.description}</small>
                        </td>
                        <td>{humanizeKind(caseRecord.kind)}</td>
                        <td>
                          <Badge
                            className={`work-queue-status-badge work-queue-status-badge--${caseRecord.status}`}
                          >
                            {humanizeStatus(caseRecord.status)}
                          </Badge>
                        </td>
                        <td>
                          <span>{caseRecord.createdByIdentity}</span>
                          <small>{caseRecord.createdByRole}</small>
                        </td>
                        <td>{caseRecord.assigneeIdentity ?? 'Unassigned'}</td>
                        <td>
                          <div className="work-queue-age-cell">
                            <span>{formatAge(caseRecord.createdAt)}</span>
                            {overdue ? (
                              <span className="work-queue-sla-warning">Overdue</span>
                            ) : (
                              <small>Within SLA</small>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="work-queue-link-stack">
                            {caseRecord.findingId ? (
                              <Link to={`/exposure/${caseRecord.findingId}`}>Finding</Link>
                            ) : (
                              <span>—</span>
                            )}
                            {caseRecord.agentId ? (
                              <Link to={`/agent-inventory/${caseRecord.agentId}`}>Agent</Link>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {operations.includes('re-evaluate') &&
                          caseRecord.kind === 'policy-exception' ? (
                            <div className="work-queue-actions">
                              <Input
                                type="datetime-local"
                                aria-label={`New exception expiry for ${caseRecord.id}`}
                                value={reEvaluationById[caseRecord.id]?.expiresAt ?? ''}
                                onChange={(_event, data) =>
                                  setReEvaluationById((current) => ({
                                    ...current,
                                    [caseRecord.id]: {
                                      expiresAt: data.value,
                                      evidenceSnapshotId:
                                        current[caseRecord.id]?.evidenceSnapshotId ?? '',
                                    },
                                  }))
                                }
                              />
                              <Input
                                aria-label={`New evidence snapshot for ${caseRecord.id}`}
                                placeholder="New evidence snapshot"
                                value={reEvaluationById[caseRecord.id]?.evidenceSnapshotId ?? ''}
                                onChange={(_event, data) =>
                                  setReEvaluationById((current) => ({
                                    ...current,
                                    [caseRecord.id]: {
                                      expiresAt: current[caseRecord.id]?.expiresAt ?? '',
                                      evidenceSnapshotId: data.value.trim(),
                                    },
                                  }))
                                }
                              />
                            </div>
                          ) : null}
                          <div className="work-queue-actions">
                            {operations.map((operation) => {
                              const capability = operationCapabilityMap[operation]
                              const permission = permissionByCapability[capability]
                              const selfApprovalBlocked =
                                operation === 'approve' &&
                                viewerIdentity !== undefined &&
                                caseRecord.proposerIdentity === viewerIdentity
                              const exceptionNotExpired =
                                operation === 'expire' &&
                                caseRecord.kind === 'policy-exception' &&
                                caseRecord.expiresAt !== undefined &&
                                Date.parse(caseRecord.expiresAt) > Date.now()
                              const reEvaluationIncomplete =
                                operation === 're-evaluate' &&
                                caseRecord.kind === 'policy-exception' &&
                                (!reEvaluationById[caseRecord.id]?.expiresAt ||
                                  !reEvaluationById[caseRecord.id]?.evidenceSnapshotId)
                              const disabledReason = selfApprovalBlocked
                                ? 'Approval is blocked because you proposed this case.'
                                : exceptionNotExpired
                                  ? `This exception remains valid until ${formatDateTime(caseRecord.expiresAt!)}.`
                                  : reEvaluationIncomplete
                                    ? 'Provide a new future expiry and evidence snapshot before re-evaluation.'
                                    : permission.message
                              const disabled =
                                !permission.can ||
                                selfApprovalBlocked ||
                                exceptionNotExpired ||
                                reEvaluationIncomplete ||
                                actionCaseId === caseRecord.id
                              const button = (
                                <Button
                                  appearance={operation === 'approve' ? 'primary' : 'secondary'}
                                  disabled={disabled}
                                  onClick={() => void performTransition(caseRecord, operation)}
                                >
                                  {humanizeOperation(operation)}
                                </Button>
                              )
                              return disabledReason ? (
                                <Tooltip
                                  key={operation}
                                  content={disabledReason}
                                  relationship="label"
                                >
                                  <span>{button}</span>
                                </Tooltip>
                              ) : (
                                <span key={operation}>{button}</span>
                              )
                            })}
                            <Button
                              appearance="subtle"
                              onClick={() => toggleExpanded(caseRecord.id)}
                            >
                              {isExpanded ? 'Hide details' : 'Details'}
                            </Button>
                          </div>
                          {closeNoteVisible ? (
                            <div className="work-queue-inline-warning">
                              Execution is disabled. The case can be closed with a record note; no
                              platform changes are made.
                            </div>
                          ) : null}
                          {viewerIdentity !== undefined &&
                          caseRecord.proposerIdentity === viewerIdentity &&
                          operations.includes('approve') ? (
                            <div className="work-queue-inline-warning">
                              Approval blocked: you proposed this case.
                            </div>
                          ) : null}
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr key={`${caseRecord.id}-detail`} className="work-queue-detail-row">
                          <td colSpan={8}>
                            {detailLoading ? (
                              <div className="work-queue-detail-loading" role="status">
                                <Spinner size="small" label="Loading case detail…" />
                              </div>
                            ) : detailError ? (
                              <div className="work-queue-inline-error" role="alert">
                                {detailError}
                              </div>
                            ) : detail ? (
                              <div className="work-queue-detail-panel">
                                <div className="work-queue-detail-meta">
                                  <span>Created {formatDateTime(detail.case.createdAt)}</span>
                                  <span>
                                    Last transition {formatDateTime(detail.case.lastTransitionAt)}
                                  </span>
                                  {detail.case.expiresAt ? (
                                    <span>
                                      Exception expiry {formatDateTime(detail.case.expiresAt)}
                                    </span>
                                  ) : null}
                                  {detail.case.lifecycleAction ? (
                                    <span>
                                      Lifecycle action{' '}
                                      {humanizeOperation(detail.case.lifecycleAction)}
                                    </span>
                                  ) : null}
                                  {detail.persistenceNote ? (
                                    <span>{detail.persistenceNote}</span>
                                  ) : null}
                                </div>
                                <ul className="work-queue-timeline">
                                  {detail.transitions.map((transition) => (
                                    <li key={transition.id}>
                                      <div>
                                        <strong>{humanizeOperation(transition.operation)}</strong>
                                        <span>
                                          {transition.fromStatus === null
                                            ? 'None'
                                            : humanizeStatus(transition.fromStatus)}{' '}
                                          → {humanizeStatus(transition.toStatus)}
                                        </span>
                                      </div>
                                      <div>
                                        <span>{transition.actorIdentity}</span>
                                        <span>{formatDateTime(transition.timestamp)}</span>
                                      </div>
                                      <div>
                                        <span>
                                          {transition.authorizationContext.mode} authorization ·{' '}
                                          {transition.authorizationContext.subject}
                                        </span>
                                        <span>
                                          {transition.source.mode} evidence ·{' '}
                                          {transition.source.referenceIds.length} references
                                        </span>
                                      </div>
                                      {transition.assignedToIdentity ? (
                                        <p>Assigned to {transition.assignedToIdentity}</p>
                                      ) : null}
                                      {transition.reason ? <p>{transition.reason}</p> : null}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  )
}
