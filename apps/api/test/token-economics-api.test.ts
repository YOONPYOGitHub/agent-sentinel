import { describe, expect, it } from 'vitest'
import { tokenEconomicsReportSchema } from '@agent-sentinel/domain'
import { createApp } from '../src/app.js'
import type { ExposureFindingRepository, SnapshotRepository } from '@agent-sentinel/domain'

function makeStubRepositories(): {
  exposureRepository: ExposureFindingRepository
  snapshotRepository: SnapshotRepository
} {
  return {
    exposureRepository: {
      upsert: (f) => Promise.resolve(f),
      findById: () => Promise.resolve(null),
      listByTenant: () => Promise.resolve({ items: [], total: 0 }),
      getFacets: () => Promise.resolve({ severity: {}, status: {}, policyId: {} }),
      resolveAbsent: () => Promise.resolve([]),
    },
    snapshotRepository: {
      save: () => Promise.resolve(),
      findLatest: () => Promise.resolve(null),
      findById: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    },
  }
}

async function makeMockApp() {
  process.env['AGENT_SENTINEL_CONNECTOR'] = 'mock'
  return createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    { dataMode: 'mock' },
  )
}

async function makeFoundryApp() {
  return createApp(
    undefined,
    { mode: 'disabled', allowedScopes: { read: [], write: [] } },
    { dataMode: 'live', ...makeStubRepositories() },
  )
}

describe('token economics API - mock mode', () => {
  it('returns ready status for hr-policy-agent (healthy with cost)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.agentId).toBe('hr-policy-agent')
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeGreaterThan(0)
    expect(result.coverage?.costCoverage).toBe(1)
    expect(result.anomalies).toEqual([])
    expect(result.baselineEvidenceId).toBeDefined()
    expect(result.observedEvidenceId).toBeDefined()
    expect(result.unavailableReason).toBeUndefined()
    await app.close()
  })

  it('returns ready with cost anomaly for code-review-copilot', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/code-review-copilot',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeGreaterThan(0)
    expect(result.anomalies?.some((a) => a.dimension === 'cost')).toBe(true)
    const costAnomaly = result.anomalies?.find((a) => a.dimension === 'cost')
    expect(costAnomaly?.severity).toMatch(/medium|high|critical/)
    await app.close()
  })

  it('returns ready without cost for sales-research-agent (missing-cost example)', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/sales-research-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('ready')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.costPerSuccessUsd).toBeUndefined()
    expect(result.coverage?.costCoverage).toBe(0)
    await app.close()
  })

  it('returns insufficient-data for unknown agent, not invented success', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/unknown-agent-xyz',
    })

    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('insufficient-data')
    expect(result.source).toBe('mock-synthetic')
    expect(result.measuredCostUsd).toBeUndefined()
    await app.close()
  })

  it('does not accept a caller-controlled tenant override', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent?tenantId=other-tenant',
    })
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.tenantId).toBe('contoso-ai-lab')
    await app.close()
  })

  it('returns 414 for agentId longer than the router parameter limit', async () => {
    const app = await makeMockApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/' + 'a'.repeat(201),
    })
    expect(response.statusCode).toBe(414)
    await app.close()
  })
})

describe('token economics API - foundry mode', () => {
  it('returns connector-not-connected and never synthetic data', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/hr-policy-agent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('connector-not-connected')
    expect(result.source).toBe('azure-monitor-otel')
    expect(result.measuredCostUsd).toBeUndefined()
    expect(result.coverage).toBeUndefined()
    expect(result.unavailableReason).toContain('connector')
    await app.close()
  })

  it('returns connector-not-connected even for unknown agents in foundry mode', async () => {
    const app = await makeFoundryApp()
    const response = await app.inject({
      method: 'GET',
      url: '/api/token-economics/agents/nonexistent',
    })
    expect(response.statusCode).toBe(200)
    const result = tokenEconomicsReportSchema.parse(response.json())
    expect(result.status).toBe('connector-not-connected')
    expect(result.source).toBe('azure-monitor-otel')
    await app.close()
  })
})
