import {
  exposureFindingSchema,
  exposurePageSchema,
  incidentNarrativeSchema,
  estateSnapshotSchema,
  remediationPreviewSchema,
  type EstateSnapshot,
  type ExposureFinding,
  type ExposurePage,
  type IncidentNarrative,
  type RemediationPreview,
} from '@agent-sentinel/domain'

function responseMessage(value: unknown): string | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  )
    return value.message
  return undefined
}

export interface ExposureListParams {
  severity?: string
  status?: string
  policyId?: string
  search?: string
  page?: number
  pageSize?: number
}

function buildQuery(params: ExposureListParams): string {
  const query = new URLSearchParams()
  if (params.severity) query.set('severity', params.severity)
  if (params.status) query.set('status', params.status)
  if (params.policyId) query.set('policyId', params.policyId)
  if (params.search) query.set('search', params.search)
  if (params.page) query.set('page', String(params.page))
  if (params.pageSize) query.set('pageSize', String(params.pageSize))
  const encoded = query.toString()
  return encoded.length > 0 ? `?${encoded}` : ''
}

export const exposureApi = {
  async listAll(params: Omit<ExposureListParams, 'page'> = {}): Promise<ExposureFinding[]> {
    const findingsById = new Map<string, ExposureFinding>()
    const pageSize = params.pageSize ?? 200
    const MAX_PAGES = 100
    let expectedTotal: number | undefined
    let expectedSnapshotId: string | undefined

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.list({ ...params, page, pageSize })
      expectedTotal ??= result.total
      if (result.total !== expectedTotal) {
        throw new Error(
          `Exposure pagination changed during collection: expected ${expectedTotal} findings but page ${page} reported ${result.total}.`,
        )
      }

      const pageSnapshotIds = new Set(result.findings.map((finding) => finding.snapshotId))
      if (pageSnapshotIds.size > 1) {
        throw new Error(`Exposure page ${page} contains findings from multiple snapshots.`)
      }
      const pageSnapshotId = pageSnapshotIds.values().next().value
      expectedSnapshotId ??= pageSnapshotId
      if (
        pageSnapshotId !== undefined &&
        expectedSnapshotId !== undefined &&
        pageSnapshotId !== expectedSnapshotId
      ) {
        throw new Error(
          `Exposure snapshot changed during pagination: expected ${expectedSnapshotId} but page ${page} returned ${pageSnapshotId}.`,
        )
      }

      for (const finding of result.findings) findingsById.set(finding.id, finding)

      const findings = [...findingsById.values()]
      if (findings.length === expectedTotal) return findings
      if (findings.length > expectedTotal) {
        throw new Error(
          `Exposure pagination returned ${findings.length} unique findings but reported ${expectedTotal}.`,
        )
      }
      if (result.findings.length === 0) {
        throw new Error(
          `Exposure pagination ended before completion: collected ${findings.length} of ${expectedTotal} reported findings.`,
        )
      }

      if (page === MAX_PAGES) {
        throw new Error(
          `Pagination limit (${MAX_PAGES} pages) exhausted: collected ${findings.length} of ${expectedTotal} reported findings.`,
        )
      }
    }

    throw new Error('Exposure pagination ended without a complete result.')
  },
  async list(params: ExposureListParams = {}): Promise<ExposurePage> {
    const response = await fetch(`/api/exposures${buildQuery(params)}`)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return exposurePageSchema.parse(body)
  },
  async get(findingId: string): Promise<ExposureFinding> {
    const response = await fetch(`/api/exposures/${encodeURIComponent(findingId)}`)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return exposureFindingSchema.parse(body)
  },
  async getGraph(findingId: string): Promise<EstateSnapshot> {
    const response = await fetch(`/api/exposures/${encodeURIComponent(findingId)}/graph`)
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return estateSnapshotSchema.parse(body)
  },
  async getRemediationPreview(findingId: string): Promise<RemediationPreview> {
    const response = await fetch(
      `/api/exposures/${encodeURIComponent(findingId)}/remediation-preview`,
    )
    const body: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return remediationPreviewSchema.parse(body)
  },
  async generateNarrative(findingId: string): Promise<IncidentNarrative> {
    const path = `/api/exposures/${encodeURIComponent(findingId)}/narrative`
    let response = await fetch(path)
    let body: unknown = await response.json().catch(() => undefined)
    if (
      response.status === 405 &&
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      body.error === 'authenticated_post_required'
    ) {
      response = await fetch(path, { method: 'POST' })
      body = await response.json().catch(() => undefined)
    }
    if (!response.ok) {
      throw new Error(responseMessage(body) ?? `Request failed with status ${response.status}.`)
    }
    return incidentNarrativeSchema.parse(body)
  },
}
