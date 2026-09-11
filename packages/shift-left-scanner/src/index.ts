import type {
  ManifestEnvelope,
  ManifestValidationIssue,
  SourceProvenance,
} from '@agent-sentinel/connector-sdk'
import type { Evidence, ExposureFinding } from '@agent-sentinel/domain'
import { createLiveGraphTraversalContextForSnapshot } from '@agent-sentinel/graph-engine'
import { acceptManifest, normalizeManifest } from '@agent-sentinel/manifest-connector'
import { evaluateAllExposurePolicies, exposurePolicyCatalog } from '@agent-sentinel/policy-engine'

export const SHIFT_LEFT_REPORT_VERSION = '1.0'

export type ShiftLeftDecision = 'pass' | 'warn' | 'block'

export interface ShiftLeftFinding {
  readonly decision: Exclude<ShiftLeftDecision, 'pass'>
  readonly finding: ExposureFinding
  readonly evidence: readonly Evidence[]
}

export interface ShiftLeftPolicyResult {
  readonly policyId: string
  readonly policyName: string
  readonly decision: ShiftLeftDecision
  readonly findings: readonly ShiftLeftFinding[]
}

export interface ShiftLeftReport {
  readonly schemaVersion: typeof SHIFT_LEFT_REPORT_VERSION
  readonly decision: ShiftLeftDecision
  readonly manifest: {
    readonly manifestId: string
    readonly manifestHash: string
    readonly tenantId: string
    readonly environmentId: string
    readonly producedAt: string
  }
  readonly provenance: SourceProvenance
  readonly summary: {
    readonly policiesEvaluated: number
    readonly policiesPassed: number
    readonly warningFindings: number
    readonly blockingFindings: number
  }
  readonly policies: readonly ShiftLeftPolicyResult[]
}

export type ShiftLeftScanResult =
  | { readonly ok: true; readonly report: ShiftLeftReport }
  | { readonly ok: false; readonly errors: readonly ManifestValidationIssue[] }

export interface ShiftLeftScanScope {
  readonly tenantId: string
  readonly environmentId?: string
}

function decisionForFinding(finding: ExposureFinding): Exclude<ShiftLeftDecision, 'pass'> {
  return finding.severity === 'critical' ? 'block' : 'warn'
}

function strongestDecision(findings: readonly ShiftLeftFinding[]): ShiftLeftDecision {
  if (findings.some((finding) => finding.decision === 'block')) return 'block'
  if (findings.length > 0) return 'warn'
  return 'pass'
}

/**
 * Scan an untrusted manifest with the same acceptance, normalization, and
 * deterministic policy evaluation used by runtime ingestion.
 */
export function scanManifest(raw: unknown, scope: ShiftLeftScanScope): ShiftLeftScanResult {
  const accepted = acceptManifest(raw, scope)
  if (!accepted.ok) return { ok: false, errors: accepted.errors }
  return { ok: true, report: scanValidatedManifest(accepted.accepted.envelope, scope) }
}

/**
 * Scan a validated envelope. Acceptance is intentionally repeated so callers
 * cannot bypass tenant/environment binding by supplying a typed value.
 */
export function scanValidatedManifest(
  envelope: ManifestEnvelope,
  scope: ShiftLeftScanScope,
): ShiftLeftReport {
  const accepted = acceptManifest(envelope, scope)
  if (!accepted.ok) {
    const details = accepted.errors
      .map((issue) => `${issue.path || '(root)'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Validated manifest does not match the scan scope: ${details}`)
  }

  const normalized = normalizeManifest(accepted.accepted.envelope, scope)
  const traversalContext = createLiveGraphTraversalContextForSnapshot(normalized.snapshot, {
    estate: {
      id: 'shift-left',
      tenantId: scope.tenantId,
      environment: normalized.snapshot.environment,
    },
    clock: () => new Date(normalized.snapshot.generatedAt),
  })
  const findings = evaluateAllExposurePolicies(normalized.snapshot, traversalContext)
  const evidenceById = new Map(
    normalized.snapshot.evidence.map((evidence) => [evidence.id, evidence]),
  )
  const policyIds = new Set(exposurePolicyCatalog.map((policy) => policy.id))
  const unknownPolicy = findings.find((finding) => !policyIds.has(finding.policyId))
  if (unknownPolicy !== undefined)
    throw new Error(`Policy engine returned uncatalogued policy ${unknownPolicy.policyId}.`)

  const policies: ShiftLeftPolicyResult[] = exposurePolicyCatalog.map((policy) => {
    const policyFindings: ShiftLeftFinding[] = findings
      .filter((finding) => finding.policyId === policy.id)
      .map((finding) => {
        const evidence = finding.evidenceIds.map((evidenceId) => {
          const citation = evidenceById.get(evidenceId)
          if (citation === undefined)
            throw new Error(
              `Finding ${finding.id} cites evidence ${evidenceId}, which is absent from the normalized manifest.`,
            )
          return citation
        })
        return { decision: decisionForFinding(finding), finding, evidence }
      })
    return {
      policyId: policy.id,
      policyName: policy.name,
      decision: strongestDecision(policyFindings),
      findings: policyFindings,
    }
  })

  const allFindings = policies.flatMap((policy) => policy.findings)
  const warningFindings = allFindings.filter((finding) => finding.decision === 'warn').length
  const blockingFindings = allFindings.filter((finding) => finding.decision === 'block').length

  return {
    schemaVersion: SHIFT_LEFT_REPORT_VERSION,
    decision: strongestDecision(allFindings),
    manifest: {
      manifestId: envelope.manifestId,
      manifestHash: normalized.hash,
      tenantId: normalized.snapshot.tenantId,
      environmentId: normalized.snapshot.environment,
      producedAt: normalized.snapshot.generatedAt,
    },
    provenance: normalized.provenance,
    summary: {
      policiesEvaluated: policies.length,
      policiesPassed: policies.filter((policy) => policy.decision === 'pass').length,
      warningFindings,
      blockingFindings,
    },
    policies,
  }
}
