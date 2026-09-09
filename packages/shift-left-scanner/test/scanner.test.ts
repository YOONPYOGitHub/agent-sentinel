import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ManifestEnvelope } from '@agent-sentinel/connector-sdk'
import { evidenceSchema, exposureFindingSchema } from '@agent-sentinel/domain'
import { normalizeManifest } from '@agent-sentinel/manifest-connector'
import { createLiveGraphTraversalContextForSnapshot } from '@agent-sentinel/graph-engine'
import { evaluateAllExposurePolicies } from '@agent-sentinel/policy-engine'
import { describe, expect, it } from 'vitest'

import { scanManifest, scanValidatedManifest } from '../src/index.js'

const scope = { tenantId: 'tenant-ci', environmentId: 'production' }

function fixture(): unknown {
  return JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../tools/fixtures/shift-left-block.json'),
      'utf8',
    ),
  ) as unknown
}

describe('shift-left manifest scanning', () => {
  it('uses the runtime policy engine without changing its findings', () => {
    const envelope = fixture() as ManifestEnvelope
    const report = scanValidatedManifest(envelope, scope)
    const snapshot = normalizeManifest(envelope, scope).snapshot
    const runtimeFindings = evaluateAllExposurePolicies(
      snapshot,
      createLiveGraphTraversalContextForSnapshot(snapshot, {
        estate: {
          id: 'shift-left',
          tenantId: scope.tenantId,
          environment: scope.environmentId,
        },
        clock: () => new Date(snapshot.generatedAt),
      }),
    )

    expect(
      report.policies.flatMap((policy) => policy.findings.map(({ finding }) => finding)),
    ).toEqual(runtimeFindings)
  })

  it('blocks critical findings and cites normalized evidence', () => {
    const result = scanManifest(fixture(), scope)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.report.decision).toBe('block')
    expect(result.report.summary).toEqual({
      policiesEvaluated: 3,
      policiesPassed: 2,
      warningFindings: 0,
      blockingFindings: 1,
    })
    const blocked = result.report.policies.find((policy) => policy.decision === 'block')
    const item = blocked?.findings[0]
    expect(item?.finding.policyId).toBe('AS-POL-001')
    expect(item?.finding.severity).toBe('critical')
    expect(item?.finding.sourceMode).toBe('manifest')
    expect(item?.finding.recommendation).toContain('Require explicit human approval')
    expect(item?.evidence.map((evidence) => evidence.id)).toEqual(item?.finding.evidenceIds)
    expect(item?.evidence.every((evidence) => evidenceSchema.safeParse(evidence).success)).toBe(
      true,
    )
    expect(exposureFindingSchema.safeParse(item?.finding).success).toBe(true)
    expect(result.report.provenance).toMatchObject({
      isNonAuthoritative: true,
      sourceOfTruth: false,
    })
  })

  it('reports a pass for every policy when no policy produces a finding', () => {
    const raw = fixture() as ManifestEnvelope
    const safe = {
      ...raw,
      agents: raw.agents.map((agent) => ({ ...agent })),
      tools: raw.tools.map((tool) => ({ ...tool, displayName: 'read_record' })),
    }
    const result = scanManifest(safe, scope)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.decision).toBe('pass')
    expect(result.report.policies.every((policy) => policy.decision === 'pass')).toBe(true)
  })

  it('reuses the runtime approval-gate semantics from the normalized agent definition', () => {
    const raw = fixture() as ManifestEnvelope
    const gated = {
      ...raw,
      agents: raw.agents.map((agent) => ({ ...agent, approvalRequired: true })),
    }
    const result = scanManifest(gated, scope)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.decision).toBe('pass')
  })

  it('warns for non-critical findings', () => {
    const raw = fixture() as ManifestEnvelope
    const warning = {
      ...raw,
      tools: raw.tools.map((tool) => ({
        ...tool,
        displayName: 'employee_lookup',
        description: 'Reads salary and performance fields.',
      })),
    }
    const result = scanManifest(warning, scope)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.decision).toBe('warn')
    expect(result.report.summary.warningFindings).toBe(1)
  })

  it('fails closed on tenant and environment mismatches', () => {
    const tenant = scanManifest(fixture(), { ...scope, tenantId: 'other-tenant' })
    const environment = scanManifest(fixture(), { ...scope, environmentId: 'staging' })
    expect(tenant.ok).toBe(false)
    expect(environment.ok).toBe(false)
    if (tenant.ok || environment.ok) return
    expect(tenant.errors[0]?.path).toBe('tenantId')
    expect(tenant.errors[0]?.message).toContain('does not match')
    expect(environment.errors[0]?.path).toBe('environmentId')
    expect(environment.errors[0]?.message).toContain('does not match')
  })
})
