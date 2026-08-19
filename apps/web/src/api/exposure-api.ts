import {
  exposureFindingSchema,
  exposurePageSchema,
  estateSnapshotSchema,
  remediationPreviewSchema,
  type EstateSnapshot,
  type ExposureFinding,
  type ExposurePage,
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
}
