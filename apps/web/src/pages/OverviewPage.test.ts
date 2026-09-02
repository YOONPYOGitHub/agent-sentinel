import { describe, expect, it } from 'vitest'

import { testState } from '../test-fixture'
import {
  overviewCapabilityPosture,
  overviewEntraIdentityCount,
  overviewEstateHealth,
  overviewExposureDisplayState,
  overviewExposureMetric,
  overviewPortfolioMetrics,
  overviewSnapshotPresentation,
} from '../overview-posture'

describe('Overview evidence posture', () => {
  it('derives portfolio and capability counts from the snapshot', () => {
    const metrics = overviewPortfolioMetrics(testState)
    expect(metrics.find((item) => item.label === 'Managed agents')).toMatchObject({
      value: 3,
      detail: '3 declared platforms',
    })
    expect(metrics.find((item) => item.label === 'Owned agents')).toMatchObject({
      value: 3,
      detail: '0 without a declared owner',
    })

    const capabilities = overviewCapabilityPosture(testState)
    const expectedMcp = testState.snapshot.nodes.filter(
      (node) => node.kind === 'mcp' && node.trust === 'trusted',
    ).length
    const expectedTools = testState.snapshot.nodes.filter(
      (node) => node.kind === 'tool' && node.trust === 'trusted',
    ).length
    expect(capabilities.find(([label]) => label === 'Trusted MCP servers')?.[1]).toBe(expectedMcp)
    expect(capabilities.find(([label]) => label === 'Trusted tools')?.[1]).toBe(expectedTools)
    const labels = capabilities.map(([label]) => String(label))
    expect(labels).not.toContain('Unapproved discoveries')
    expect(labels).toContain('Untrusted discoveries')
  })

  it('reports unsupported estate dimensions as unknown without invented percentages', () => {
    const health = overviewEstateHealth(testState)
    for (const label of ['Reliability', 'Quality', 'Cost efficiency', 'Lifecycle']) {
      expect(health.find((item) => item.label === label)).toMatchObject({
        status: 'Unknown',
        coverage: 'unknown',
      })
    }
    expect(JSON.stringify(health)).not.toMatch(/99\.94|4\.6|91%|97%|88%|76%|84%/)
  })

  it('derives security posture from active paths instead of a fixed score', () => {
    expect(overviewEstateHealth(testState).find((item) => item.label === 'Security')).toMatchObject(
      {
        status: 'Critical',
        coverage: 'derived',
      },
    )
    const mitigated = {
      ...testState,
      findings: testState.findings.map((finding) => ({
        ...finding,
        path: { ...finding.path, status: 'mitigated' as const },
      })),
    }
    expect(overviewEstateHealth(mitigated).find((item) => item.label === 'Security')).toMatchObject(
      {
        status: 'Healthy',
        detail: '0 active evidence-backed paths',
      },
    )

    const lowerScoreCritical = {
      ...testState,
      findings: testState.findings.map((finding) => ({
        ...finding,
        path: { ...finding.path, riskScore: 77 },
      })),
    }
    expect(
      overviewEstateHealth(lowerScoreCritical).find((item) => item.label === 'Security'),
    ).toMatchObject({ status: 'Critical' })
    expect(
      overviewPortfolioMetrics(lowerScoreCritical).find(
        (item) => item.label === 'Critical modeled paths',
      ),
    ).toMatchObject({ value: 1 })
  })

  it('counts only explicitly non-public data assets as sensitive', () => {
    const dataNode = testState.snapshot.nodes.find((node) => node.kind === 'data')!
    const withDataPath = (sensitivity: 'public' | 'confidential' | undefined) => ({
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: testState.snapshot.nodes.map((node) =>
          node.id === dataNode.id ? { ...node, sensitivity } : node,
        ),
      },
      findings: testState.findings.map((finding) => ({
        ...finding,
        path: { ...finding.path, nodeIds: [...finding.path.nodeIds, dataNode.id] },
      })),
    })

    expect(
      overviewPortfolioMetrics(withDataPath(undefined)).find(
        (item) => item.label === 'Sensitive assets modeled',
      ),
    ).toMatchObject({
      value: 0,
      detail: '0 explicitly non-public · 1 unclassified · 0 public',
    })
    expect(
      overviewPortfolioMetrics(withDataPath('public')).find(
        (item) => item.label === 'Sensitive assets modeled',
      ),
    ).toMatchObject({
      value: 0,
      detail: '0 explicitly non-public · 0 unclassified · 1 public',
    })
    expect(
      overviewPortfolioMetrics(withDataPath('confidential')).find(
        (item) => item.label === 'Sensitive assets modeled',
      ),
    ).toMatchObject({
      value: 1,
      detail: '1 explicitly non-public · 0 unclassified · 0 public',
    })
  })

  it('counts stable and preview Microsoft Entra identity platforms', () => {
    const identity = testState.snapshot.nodes.find((node) => node.kind === 'identity')!
    const state = {
      ...testState,
      snapshot: {
        ...testState.snapshot,
        nodes: [
          { ...identity, id: 'stable-entra', metadata: { platform: 'Microsoft Entra ID' } },
          {
            ...identity,
            id: 'preview-entra',
            metadata: { platform: 'Microsoft Entra Agent ID preview' },
          },
          { ...identity, id: 'other-identity', metadata: { platform: 'GitHub' } },
        ],
      },
    }

    expect(overviewEntraIdentityCount(state)).toBe(2)
  })

  it('marks retained exposure results as last-known after refresh failure', () => {
    const exposure = {
      findings: [
        {
          id: 'exposure-critical',
          policyId: 'AS-POL-001',
          policyName: 'Critical policy',
          severity: 'critical' as const,
          status: 'open' as const,
          riskScore: 90,
          title: 'Critical exposure',
          summary: 'Test exposure.',
          recommendation: 'Review.',
          affectedAgentId: 'sales-research-agent',
          affectedAgentName: 'Sales Research Agent',
          declaredTools: [],
          affectedNodeIds: ['sales-research-agent'],
          affectedEdgeIds: [],
          evidenceIds: ['evidence-sales'],
          evidenceTypes: ['declared_configuration' as const],
          blastRadiusCount: 0,
          blastRadiusNodeIds: [],
          firstSeen: '2026-09-01T00:00:00.000Z',
          lastSeen: '2026-09-01T00:00:00.000Z',
          validationStatus: 'theoretical' as const,
          sourceMode: 'mock' as const,
          tenantId: 'test',
          snapshotId: 'snapshot-test',
        },
      ],
      total: 1,
      facets: {
        severity: { critical: 1 },
        status: { open: 1 },
        policyId: { 'AS-POL-001': 1 },
      },
    }

    expect(overviewExposureMetric(exposure, 'refresh failed', false)).toEqual({
      value: 1,
      detail: 'Last-known · 1 critical · 0 high',
      tone: 'warning',
    })
    expect(overviewExposureMetric(undefined, 'refresh failed', false)).toEqual({
      value: '—',
      detail: 'Exposure counts unavailable',
      tone: 'warning',
    })
    expect(overviewExposureMetric(undefined, undefined, false)).toEqual({
      value: '—',
      detail: 'Exposure findings not loaded',
      tone: 'neutral',
    })
    expect(overviewExposureMetric(exposure, undefined, true)).toEqual({
      value: 1,
      detail: 'Refreshing · last-known · 1 critical · 0 high',
      tone: 'warning',
    })
    expect(overviewExposureDisplayState(undefined, undefined, false)).toBe('unloaded')
    expect(overviewExposureDisplayState(exposure, undefined, true)).toBe('refreshing')
    expect(overviewExposureDisplayState(exposure, 'refresh failed', false)).toBe('stale')
  })

  it('labels retained discovery snapshots during refresh and failure', () => {
    expect(overviewSnapshotPresentation(undefined, false)).toEqual({
      heading: 'Current discovery snapshot',
      badge: 'Current',
    })
    expect(overviewSnapshotPresentation(undefined, true)).toEqual({
      heading: 'Refreshing discovery snapshot',
      badge: 'Refreshing last-known',
    })
    expect(overviewSnapshotPresentation('offline', false)).toEqual({
      heading: 'Last-known discovery snapshot',
      badge: 'Refresh failed',
    })
  })
})
