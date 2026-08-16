import type { SearchClient } from '@azure/search-documents'

import type { Finding } from '@agent-sentinel/domain'

import type { EmbeddingClient } from './embedding-client.js'

export interface FindingDocument {
  id: string
  tenantId: string
  title: string
  summary: string
  severity: string
  recommendation: string
  owner: string
  detectedAt: string
  contentVector: number[]
}

type TenantFinding = Finding & { tenantId?: string }

export class FindingIngestionService {
  constructor(
    private readonly searchClient: SearchClient<FindingDocument>,
    private readonly embeddingClient: EmbeddingClient,
  ) {}

  async ingestFinding(finding: Finding): Promise<void> {
    const tenantId = (finding as TenantFinding).tenantId
    if (!tenantId) {
      throw new Error('Finding must include tenantId for search ingestion')
    }
    const contentVector = await this.embeddingClient.embed(
      [finding.title, finding.summary, finding.recommendation].join('\n'),
    )
    await this.searchClient.mergeOrUploadDocuments([
      {
        id: finding.id,
        tenantId,
        title: finding.title,
        summary: finding.summary,
        severity: finding.severity,
        recommendation: finding.recommendation,
        owner: finding.owner,
        detectedAt: finding.detectedAt,
        contentVector,
      },
    ])
  }

  async deleteFinding(id: string): Promise<void> {
    await this.searchClient.deleteDocuments('id', [id])
  }
}
