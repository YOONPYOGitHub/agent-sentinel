import type { SearchClient } from '@azure/search-documents'

import type { EmbeddingClient } from './embedding-client.js'
import type { FindingDocument } from './ingestion.js'

export interface SearchResult {
  id: string
  title: string
  summary: string
  severity: string
  score: number
  citations: string[]
}

export class FindingRagSearch {
  constructor(
    private readonly searchClient: SearchClient<FindingDocument>,
    private readonly embeddingClient: EmbeddingClient,
  ) {}

  async search(query: string, filter?: string): Promise<SearchResult[]> {
    const vector = await this.embeddingClient.embed(query)
    const options = {
      top: 10,
      select: ['id', 'title', 'summary', 'severity'] as const,
      vectorSearchOptions: {
        queries: [
          {
            kind: 'vector' as const,
            vector,
            fields: ['contentVector'] as const,
            kNearestNeighborsCount: 10,
          },
        ],
      },
      ...(filter === undefined ? {} : { filter }),
    }
    const response = await this.searchClient.search(query, options)
    const results: SearchResult[] = []
    for await (const result of response.results) {
      results.push({
        id: result.document.id,
        title: result.document.title,
        summary: result.document.summary,
        severity: result.document.severity,
        score: result.score,
        citations: [result.document.id],
      })
    }
    return results
  }
}
