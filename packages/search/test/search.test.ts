import { describe, expect, it } from 'vitest'

import type { SearchClient } from '@azure/search-documents'
import type { Finding } from '@agent-sentinel/domain'

import {
  FakeEmbeddingClient,
  FindingIngestionService,
  FindingRagSearch,
  type FindingDocument,
} from '../src/index.js'

const finding: Finding & { tenantId: string } = {
  id: 'finding-1',
  tenantId: 'tenant-one',
  title: 'Exposed agent',
  summary: 'An agent is reachable from an untrusted input.',
  severity: 'high',
  owner: 'security-team',
  policyId: 'policy-1',
  detectedAt: '2024-01-01T00:00:00.000Z',
  recommendation: 'Restrict the input path.',
  path: {
    id: 'path-1',
    nodeIds: ['node-1', 'node-2'],
    edgeIds: ['edge-1'],
    evidenceIds: ['evidence-1'],
    riskScore: 80,
    status: 'theoretical',
    factors: {
      reachability: 1,
      exploitability: 0.8,
      businessImpact: 0.8,
      privilege: 0.7,
      dataSensitivity: 0.8,
      activity: 0.5,
      confidence: 0.9,
      compensatingControlDiscount: 0.1,
    },
  },
}

function fakeSearchClient(documents: FindingDocument[]): SearchClient<FindingDocument> {
  return {
    mergeOrUploadDocuments: (items: FindingDocument[]) => {
      documents.push(...items)
      return Promise.resolve({ results: [] })
    },
    deleteDocuments: (_keyName: string, ids: string[]) => {
      for (const id of ids) {
        const index = documents.findIndex((document) => document.id === id)
        if (index >= 0) {
          documents.splice(index, 1)
        }
      }
      return Promise.resolve({ results: [] })
    },
    search: () =>
      Promise.resolve({
        results: (async function* () {
          await Promise.resolve()
          for (const document of documents) {
            yield { document, score: 0.95 }
          }
        })(),
      }),
  } as unknown as SearchClient<FindingDocument>
}

describe('search services', () => {
  it('ingests a finding with its embedding', async () => {
    const documents: FindingDocument[] = []
    const service = new FindingIngestionService(
      fakeSearchClient(documents),
      new FakeEmbeddingClient(),
    )

    await service.ingestFinding(finding)

    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ id: 'finding-1', tenantId: 'tenant-one' })
    expect(documents[0]?.contentVector).toHaveLength(3072)
  })

  it('returns search results with finding citations', async () => {
    const documents: FindingDocument[] = [
      {
        id: finding.id,
        tenantId: finding.tenantId,
        title: finding.title,
        summary: finding.summary,
        severity: finding.severity,
        recommendation: finding.recommendation,
        owner: finding.owner,
        detectedAt: finding.detectedAt,
        contentVector: new Array<number>(3072).fill(0.1),
      },
    ]
    const service = new FindingRagSearch(fakeSearchClient(documents), new FakeEmbeddingClient())

    await expect(service.search('reachable agent')).resolves.toEqual([
      {
        id: 'finding-1',
        title: 'Exposed agent',
        summary: 'An agent is reachable from an untrusted input.',
        severity: 'high',
        score: 0.95,
        citations: ['finding-1'],
      },
    ])
  })

  it('returns deterministic vectors with the expected dimensions', async () => {
    const client = new FakeEmbeddingClient()

    await expect(client.embed('one')).resolves.toHaveLength(3072)
    const vectors = await client.embedBatch(['one', 'two'])
    expect(vectors).toHaveLength(2)
    expect(vectors.every((vector) => vector.length === 3072)).toBe(true)
  })
})
