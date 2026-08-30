import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ADAPTER_DEFAULT_CONFIDENCE,
  ADAPTER_MAX_DECLARED_CONFIDENCE,
  actionDepthSchema,
  computeManifestHash,
  edgeDeclarationSchema,
  isSupportedManifestVersion,
  MANIFEST_LIMITS,
  MANIFEST_SCHEMA_VERSION,
  manifestEntityKindSchema,
  manifestEvidenceTypeSchema,
  manifestSourceBindingSchema,
  SUPPORTED_MANIFEST_RELATIONSHIPS,
  SUPPORTED_MANIFEST_VERSIONS,
  stableId,
  validateManifest,
  type ManifestEnvelope,
} from '@agent-sentinel/connector-sdk'
import type { EstateSnapshot } from '@agent-sentinel/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  acceptManifest,
  assertSafeManifestPath,
  effectiveEvidence,
  ManifestConnector,
  ManifestFileLoadError,
  mergeManifestSnapshots,
  normalizeManifest,
} from '../src/index.js'

const TENANT = 'contoso-ai-lab'
const ENVIRONMENT = 'production'

type Raw = Record<string, unknown>

function baseManifest(): Raw {
  return {
    schemaVersion: '1.0',
    manifestId: 'mf-001',
    tenantId: TENANT,
    environmentId: ENVIRONMENT,
    producedAt: '2026-08-20T09:00:00.000Z',
    producer: { name: 'Contoso Registry', version: '1.0.0' },
    capabilities: {
      supportsDiscovery: true,
      evidenceDepth: 'deep',
      supportsRuntimeTelemetry: true,
      supportsActions: 'propose',
    },
    agents: [
      { id: 'agent-a', displayName: 'Agent A', owner: 'Platform', trust: 'conditional' },
      { id: 'agent-b', displayName: 'Agent B' },
    ],
    tools: [
      { id: 'tool-a', displayName: 'tool_a', toolType: 'function' },
      { id: 'tool-b', displayName: 'tool_b', toolType: 'action', trust: 'untrusted' },
    ],
    identities: [{ id: 'identity-a', displayName: 'svc-agent-a', principalType: 'workload' }],
    dataSources: [{ id: 'data-a', displayName: 'Ledger', sensitivity: 'confidential' }],
    mcpDependencies: [{ id: 'mcp-a', displayName: 'Directory MCP', endpointRef: 'dir.internal' }],
    edges: [
      {
        from: { kind: 'agent', id: 'agent-a' },
        to: { kind: 'identity', id: 'identity-a' },
        relationship: 'RUNS_AS',
      },
      {
        from: { kind: 'identity', id: 'identity-a' },
        to: { kind: 'dataSources', id: 'data-a' },
        relationship: 'CAN_READ',
      },
      {
        from: { kind: 'agent', id: 'agent-b' },
        to: { kind: 'mcp', id: 'mcp-a' },
        relationship: 'CAN_CALL',
      },
    ],
    evidence: [
      {
        id: 'ev-config',
        subjectId: 'agent-a',
        evidenceType: 'declared_configuration',
        sourceBinding: {
          sourceConnectorId: 'primary',
          sourceTenantId: TENANT,
          sourceObjectId: 'agent-a',
          sourceEnvironment: ENVIRONMENT,
        },
        confidence: 0.6,
        observedAt: '2026-08-20T08:55:00.000Z',
        claims: { registryRecord: 'agents/agent-a/9' },
      },
      {
        id: 'ev-runtime',
        subjectId: 'tool-b',
        evidenceType: 'runtime_observed',
        sourceBinding: {
          sourceConnectorId: 'primary',
          sourceTenantId: TENANT,
          sourceObjectId: 'provider-tool-b',
          sourceEnvironment: ENVIRONMENT,
        },
        confidence: 0.9,
        observedAt: '2026-08-20T08:58:00.000Z',
        claims: {},
      },
    ],
    metadata: { costCenter: 'FIN-3120' },
  }
}

function withPatch(patch: (manifest: Raw) => void): Raw {
  const manifest = baseManifest()
  patch(manifest)
  return manifest
}

function accepted(manifest: Raw): ManifestEnvelope {
  const result = acceptManifest(manifest, { tenantId: TENANT, environmentId: ENVIRONMENT })
  if (!result.ok) throw new Error(`Expected acceptance: ${JSON.stringify(result.errors)}`)
  return result.accepted.envelope
}

function errorText(manifest: Raw, environmentId: string | undefined = ENVIRONMENT): string {
  const result = acceptManifest(manifest, {
    tenantId: TENANT,
    ...(environmentId === undefined ? {} : { environmentId }),
  })
  if (result.ok) throw new Error('Expected rejection but the manifest was accepted.')
  return result.errors.map((error) => `${error.path}: ${error.message}`).join(' | ')
}

function connector(manifest: Raw): ManifestConnector {
  return new ManifestConnector({
    manifestContent: manifest,
    tenantId: TENANT,
    environmentId: ENVIRONMENT,
  })
}

// ─── Normalization ───────────────────────────────────────────────────────────

describe('manifest normalization', () => {
  it('normalizes agents, tools, identities, data sources, MCP servers, edges and evidence', async () => {
    const snapshot = await connector(baseManifest()).discover()

    expect(snapshot.tenantId).toBe(TENANT)
    expect(snapshot.environment).toBe(ENVIRONMENT)
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(2)
    expect(snapshot.nodes.filter((node) => node.kind === 'tool')).toHaveLength(2)
    expect(snapshot.nodes.filter((node) => node.kind === 'identity')).toHaveLength(1)
    expect(snapshot.nodes.filter((node) => node.kind === 'data')).toHaveLength(1)
    expect(snapshot.nodes.filter((node) => node.kind === 'mcp')).toHaveLength(1)
    expect(snapshot.edges).toHaveLength(3)
    // Seven declared entities plus two operator-supplied evidence records.
    expect(snapshot.evidence).toHaveLength(9)
    expect(snapshot.edges.map((edge) => edge.relationship)).toEqual([
      'RUNS_AS',
      'CAN_READ',
      'CAN_CALL',
    ])
    expect(snapshot.nodes.find((node) => node.name === 'Ledger')?.sensitivity).toBe('confidential')
  })

  it('keeps exact runtime source binding optional for backward-compatible v1 manifests', () => {
    const withoutBinding = withPatch((manifest) => {
      const evidence = manifest['evidence'] as Raw[]
      delete evidence[1]?.['sourceBinding']
    })
    expect(validateManifest(withoutBinding).ok).toBe(true)
    expect(
      errorText(
        withPatch((manifest) => {
          const evidence = manifest['evidence'] as Raw[]
          evidence[1]!['sourceBinding'] = {
            sourceConnectorId: 'primary',
            sourceTenantId: TENANT,
            sourceObjectId: 'provider-tool-b',
          }
        }),
      ),
    ).toContain('sourceEnvironment')
    const declaredBinding = validateManifest(baseManifest())
    expect(declaredBinding.ok).toBe(true)
    if (declaredBinding.ok) {
      expect(declaredBinding.envelope.evidence[0]?.sourceBinding?.sourceObjectId).toBe('agent-a')
    }
  })

  it('namespaces every identifier with the manifest stable id prefix', async () => {
    const snapshot = await connector(baseManifest()).discover()
    const ids = [
      ...snapshot.nodes.map((node) => node.id),
      ...snapshot.edges.map((edge) => edge.id),
      ...snapshot.evidence.map((item) => item.id),
    ]
    expect(ids.every((id) => id.startsWith('manifest::mf-001::'))).toBe(true)
    expect(snapshot.nodes.find((node) => node.name === 'Agent A')?.id).toBe(
      stableId('manifest', 'mf-001::agent-a'),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('defaults trust to conditional and never claims source of truth', async () => {
    const instance = connector(baseManifest())
    const snapshot = await instance.discover()
    const provenance = await instance.getProvenance()

    expect(snapshot.nodes.find((node) => node.name === 'Agent B')?.trust).toBe('conditional')
    expect(provenance.sourceOfTruth).toBe(false)
    expect(provenance.isNonAuthoritative).toBe(true)
    for (const node of snapshot.nodes) {
      expect(node.metadata['sourceOfTruth']).toBe('false')
      expect(node.metadata['source']).toBe('custom-manifest-adapter')
    }
    expect(JSON.stringify(snapshot)).not.toContain('"sourceOfTruth":true')
  })

  it('marks adapter edges as non-removable because the adapter cannot remediate', async () => {
    const snapshot = await connector(baseManifest()).discover()
    expect(snapshot.edges.every((edge) => edge.removable === false)).toBe(true)
  })

  it('exposes no execute method', () => {
    expect((connector(baseManifest()) as { execute?: unknown }).execute).toBeUndefined()
  })

  it('merges a manifest snapshot without changing the primary snapshot boundary', async () => {
    const manifestSnapshot = await connector(baseManifest()).discover()
    const primary: EstateSnapshot = {
      tenantId: TENANT,
      environment: ENVIRONMENT,
      generatedAt: '2026-08-28T00:00:00.000Z',
      nodes: [],
      edges: [],
      evidence: [],
    }
    const merged = mergeManifestSnapshots(primary, [manifestSnapshot])
    expect(merged.generatedAt).toBe(primary.generatedAt)
    expect(merged.nodes).toHaveLength(manifestSnapshot.nodes.length)
    expect(merged.nodes.every((node) => node.metadata['sourceOfTruth'] === 'false')).toBe(true)
  })

  it('rejects identifier collisions during estate composition', async () => {
    const manifestSnapshot = await connector(baseManifest()).discover()
    expect(() => mergeManifestSnapshots(manifestSnapshot, [manifestSnapshot])).toThrow(
      'collides with the estate graph',
    )
  })
})

// ─── Schema version ──────────────────────────────────────────────────────────

describe('schema version compatibility', () => {
  it('publishes the supported version set', () => {
    expect(SUPPORTED_MANIFEST_VERSIONS).toContain(MANIFEST_SCHEMA_VERSION)
    expect(isSupportedManifestVersion('1.0')).toBe(true)
    expect(isSupportedManifestVersion('2.0')).toBe(false)
    expect(isSupportedManifestVersion(1)).toBe(false)
  })

  it('rejects an unsupported schema version', () => {
    const message = errorText(withPatch((manifest) => (manifest['schemaVersion'] = '9.9')))
    expect(message).toContain('Unsupported manifest schemaVersion')
    expect(message).toContain('schemaVersion')
  })

  it('rejects a missing schema version', () => {
    expect(errorText(withPatch((manifest) => delete manifest['schemaVersion']))).toContain(
      'Unsupported manifest schemaVersion',
    )
  })
})

// ─── Tenant and environment isolation ────────────────────────────────────────

describe('tenant and environment isolation', () => {
  it('rejects a tenant mismatch', () => {
    expect(errorText(withPatch((manifest) => (manifest['tenantId'] = 'other-tenant')))).toContain(
      'does not match the configured tenant',
    )
  })

  it('rejects an environment mismatch', () => {
    expect(errorText(withPatch((manifest) => (manifest['environmentId'] = 'staging')))).toContain(
      'does not match the configured environment',
    )
  })

  it('accepts a manifest without an environment when none is configured', () => {
    const manifest = withPatch((entry) => delete entry['environmentId'])
    const result = acceptManifest(manifest, { tenantId: TENANT })
    expect(result.ok).toBe(true)
  })

  it('rejects a manifest without an environment when one is configured', () => {
    expect(errorText(withPatch((manifest) => delete manifest['environmentId']))).toContain(
      '(absent)',
    )
  })

  it('rejects entity-level environment labels outside the configured boundary', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          const agents = manifest['agents'] as Array<Record<string, unknown>>
          const agent = agents[0]
          if (agent === undefined) throw new Error('Fixture agent is missing.')
          agent['environment'] = 'staging'
        }),
      ),
    ).toContain('Entity environment does not match the configured environment')
  })
})

// ─── Referential integrity ───────────────────────────────────────────────────

describe('referential integrity', () => {
  it('rejects duplicate ids within the same declaration type', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['agents'] = [
            { id: 'agent-a', displayName: 'Agent A' },
            { id: 'agent-a', displayName: 'Agent A duplicate' },
          ]
        }),
      ),
    ).toContain('Duplicate agent id agent-a')
  })

  it('rejects id collisions across declaration types', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['tools'] = [{ id: 'agent-a', displayName: 'Collides with an agent' }]
        }),
      ),
    ).toContain('collides with a declared agent')
  })

  it('rejects duplicate evidence ids', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['evidence'] = [
            {
              id: 'ev-1',
              subjectId: 'agent-a',
              evidenceType: 'declared_configuration',
              observedAt: '2026-08-20T08:55:00.000Z',
            },
            {
              id: 'ev-1',
              subjectId: 'agent-b',
              evidenceType: 'declared_configuration',
              observedAt: '2026-08-20T08:55:00.000Z',
            },
          ]
        }),
      ),
    ).toContain('Duplicate evidence id ev-1')
  })

  it('rejects dangling edge endpoints', () => {
    const message = errorText(
      withPatch((manifest) => {
        manifest['edges'] = [
          {
            from: { kind: 'agent', id: 'agent-a' },
            to: { kind: 'tool', id: 'tool-missing' },
            relationship: 'CAN_CALL',
          },
        ]
      }),
    )
    expect(message).toContain('Edge to references undeclared entity tool-missing')
  })

  it('rejects an edge endpoint whose declared kind is wrong', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['edges'] = [
            {
              from: { kind: 'tool', id: 'agent-a' },
              to: { kind: 'identity', id: 'identity-a' },
              relationship: 'RUNS_AS',
            },
          ]
        }),
      ),
    ).toContain('declares kind tool but agent-a is a agent')
  })

  it('rejects dangling evidence subjects', () => {
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['evidence'] = [
            {
              id: 'ev-x',
              subjectId: 'not-declared',
              evidenceType: 'declared_configuration',
              observedAt: '2026-08-20T08:55:00.000Z',
            },
          ]
        }),
      ),
    ).toContain('references undeclared subject not-declared')
  })

  it('rejects a relationship outside the deterministic vocabulary', () => {
    const message = errorText(
      withPatch((manifest) => {
        manifest['edges'] = [
          {
            from: { kind: 'agent', id: 'agent-a' },
            to: { kind: 'tool', id: 'tool-a' },
            relationship: 'MAYBE_TALKS_TO',
          },
        ]
      }),
    )
    expect(message).toContain('Invalid option')
    expect(SUPPORTED_MANIFEST_RELATIONSHIPS).toContain('CAN_CALL')
  })

  it('rejects non-canonical relationship spellings in the standalone edge contract', () => {
    const edge = {
      from: { kind: 'agent', id: 'agent-a' },
      to: { kind: 'tool', id: 'tool-a' },
      relationship: 'runs-as',
    }
    expect(edgeDeclarationSchema.safeParse(edge).success).toBe(false)
    expect(
      errorText(
        withPatch((manifest) => {
          manifest['edges'] = [edge]
        }),
      ),
    ).toContain('Invalid option')
  })

  it('rejects unknown envelope keys', () => {
    expect(
      errorText(withPatch((manifest) => (manifest['ingestUrl'] = 'https://evil.example'))),
    ).toMatch(/unrecognized key/i)
  })
})

// ─── Action depth ────────────────────────────────────────────────────────────

describe('action depth', () => {
  it('rejects execute at validation and at the connector boundary', async () => {
    const manifest = withPatch((entry) => {
      ;(entry['capabilities'] as Raw)['supportsActions'] = 'execute'
    })
    expect(errorText(manifest)).toContain('"execute" is never permitted')

    const result = await connector(manifest).testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('execute')
  })

  it('accepts observation-only depths', () => {
    for (const depth of ['none', 'simulate', 'propose']) {
      const manifest = withPatch((entry) => {
        ;(entry['capabilities'] as Raw)['supportsActions'] = depth
      })
      expect(acceptManifest(manifest, { tenantId: TENANT, environmentId: ENVIRONMENT }).ok).toBe(
        true,
      )
    }
  })

  it('defaults action depth to none', () => {
    const manifest = withPatch((entry) => {
      delete (entry['capabilities'] as Raw)['supportsActions']
    })
    expect(accepted(manifest).capabilities.supportsActions).toBe('none')
  })
})

// ─── Confidence and runtime gating ───────────────────────────────────────────

describe('confidence and runtime evidence gating', () => {
  it('defaults adapter confidence to 0.4', async () => {
    const manifest = withPatch((entry) => {
      entry['evidence'] = [
        {
          id: 'ev-default',
          subjectId: 'agent-a',
          evidenceType: 'declared_configuration',
          observedAt: '2026-08-20T08:55:00.000Z',
        },
      ]
    })
    expect(accepted(manifest).evidence[0]?.confidence).toBe(ADAPTER_DEFAULT_CONFIDENCE)

    const snapshot = await connector(manifest).discover()
    expect(
      snapshot.evidence.every((item) => item.confidence <= ADAPTER_MAX_DECLARED_CONFIDENCE),
    ).toBe(true)
    // Baseline entity evidence always uses the adapter default.
    const baseline = snapshot.evidence.find((item) =>
      item.id.includes('evidence::declared::agent-a'),
    )
    expect(baseline?.confidence).toBe(ADAPTER_DEFAULT_CONFIDENCE)
  })

  it('rejects declared-configuration confidence above the adapter ceiling', () => {
    expect(
      errorText(
        withPatch((entry) => {
          entry['evidence'] = [
            {
              id: 'ev-high',
              subjectId: 'agent-a',
              evidenceType: 'declared_configuration',
              confidence: 0.95,
              observedAt: '2026-08-20T08:55:00.000Z',
            },
          ]
        }),
      ),
    ).toContain('may not exceed confidence 0.7')
  })

  it('rejects runtime evidence when runtime telemetry is not declared', () => {
    expect(
      errorText(
        withPatch((entry) => {
          ;(entry['capabilities'] as Raw)['supportsRuntimeTelemetry'] = false
        }),
      ),
    ).toContain('capabilities.supportsRuntimeTelemetry is false')
  })

  it('keeps runtime confidence only when telemetry support and deep evidence are both declared', async () => {
    const deep = await connector(baseManifest()).discover()
    const runtime = deep.evidence.find((item) => item.id.includes('evidence::ev-runtime'))
    expect(runtime?.confidence).toBe(0.9)
    expect(runtime?.freshness).toBe('live')
    expect(runtime?.summary).toContain('Runtime observation')

    const shallow = await connector(
      withPatch((entry) => {
        ;(entry['capabilities'] as Raw)['evidenceDepth'] = 'shallow'
      }),
    ).discover()
    const downgraded = shallow.evidence.find((item) => item.id.includes('evidence::ev-runtime'))
    expect(downgraded?.confidence).toBe(ADAPTER_MAX_DECLARED_CONFIDENCE)
    expect(downgraded?.summary).toContain('Declared configuration')
  })

  it('caps effective evidence deterministically', () => {
    const shallow = {
      supportsDiscovery: true,
      evidenceDepth: 'shallow',
      supportsRuntimeTelemetry: true,
      supportsActions: 'none',
    } as const
    expect(
      effectiveEvidence({ evidenceType: 'runtime_observed', confidence: 1 }, shallow).confidence,
    ).toBe(ADAPTER_MAX_DECLARED_CONFIDENCE)
    expect(
      effectiveEvidence({ evidenceType: 'declared_configuration', confidence: 1 }, shallow)
        .evidenceType,
    ).toBe('declared_configuration')
  })
})

// ─── Bounds ──────────────────────────────────────────────────────────────────

describe('bounded input', () => {
  it('rejects more than 20 metadata keys', () => {
    const metadata: Record<string, string> = {}
    for (let index = 0; index <= MANIFEST_LIMITS.maxMetadataKeys; index += 1)
      metadata[`key-${index}`] = 'value'
    expect(errorText(withPatch((entry) => (entry['metadata'] = metadata)))).toContain(
      'metadata supports at most 20 keys',
    )
  })

  it('rejects metadata values longer than 256 characters', () => {
    expect(
      errorText(withPatch((entry) => (entry['metadata'] = { note: 'x'.repeat(257) }))),
    ).toContain('metadata values must be at most 256 characters')
  })

  it('rejects more than 50 claim keys', () => {
    const claims: Record<string, string> = {}
    for (let index = 0; index <= MANIFEST_LIMITS.maxClaimKeys; index += 1)
      claims[`claim-${index}`] = 'value'
    expect(
      errorText(
        withPatch((entry) => {
          entry['evidence'] = [
            {
              id: 'ev-claims',
              subjectId: 'agent-a',
              evidenceType: 'declared_configuration',
              observedAt: '2026-08-20T08:55:00.000Z',
              claims,
            },
          ]
        }),
      ),
    ).toContain('claims supports at most 50 keys')
  })

  it('rejects claim values longer than 512 characters', () => {
    expect(
      errorText(
        withPatch((entry) => {
          entry['evidence'] = [
            {
              id: 'ev-claims',
              subjectId: 'agent-a',
              evidenceType: 'declared_configuration',
              observedAt: '2026-08-20T08:55:00.000Z',
              claims: { detail: 'y'.repeat(513) },
            },
          ]
        }),
      ),
    ).toContain('claims values must be at most 512 characters')
  })
})

// ─── Idempotency ─────────────────────────────────────────────────────────────

describe('deterministic hashing', () => {
  it('produces the same hash for the same manifest regardless of key order', () => {
    const first = computeManifestHash(accepted(baseManifest()))
    const reordered = baseManifest()
    const rebuilt: Raw = {}
    for (const key of Object.keys(reordered).reverse()) rebuilt[key] = reordered[key]
    expect(computeManifestHash(accepted(rebuilt))).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the hash when a declaration changes', () => {
    const changed = withPatch((entry) => {
      ;(entry['agents'] as Raw[])[0]!['displayName'] = 'Agent A renamed'
    })
    expect(computeManifestHash(accepted(changed))).not.toBe(
      computeManifestHash(accepted(baseManifest())),
    )
  })

  it('normalizes to an identical snapshot on repeated runs', () => {
    const envelope = accepted(baseManifest())
    const options = { tenantId: TENANT, environmentId: ENVIRONMENT }
    expect(normalizeManifest(envelope, options).snapshot).toEqual(
      normalizeManifest(envelope, options).snapshot,
    )
  })
})

// ─── Configuration and file safety ───────────────────────────────────────────

describe('connector configuration', () => {
  it('requires exactly one manifest source', () => {
    expect(() => new ManifestConnector({ tenantId: TENANT })).toThrow(
      /exactly one of manifestContent or manifestPath/,
    )
    expect(
      () =>
        new ManifestConnector({
          tenantId: TENANT,
          manifestContent: baseManifest(),
          manifestPath: '/srv/manifests/a.json',
        }),
    ).toThrow(/not both/)
  })

  it('rejects an empty tenant', () => {
    expect(() => new ManifestConnector({ tenantId: '', manifestContent: baseManifest() })).toThrow()
  })
})

describe('local file safety', () => {
  const remote = [
    'http://example.com/manifest.json',
    'https://example.com/manifest.json',
    'file:///srv/manifest.json',
    'ftp://example.com/manifest.json',
    '//example.com/manifest.json',
    '\\\\server\\share\\manifest.json',
  ]

  it('rejects every remote or protocol-relative reference at config time', () => {
    for (const path of remote)
      expect(() => new ManifestConnector({ tenantId: TENANT, manifestPath: path })).toThrow(
        /local absolute path/,
      )
  })

  it('rejects every remote or protocol-relative reference at load time', () => {
    for (const path of remote)
      expect(() => assertSafeManifestPath(path)).toThrow(ManifestFileLoadError)
  })

  it('rejects relative and unnormalized paths', () => {
    expect(() => assertSafeManifestPath('manifests/a.json')).toThrow(/absolute/)
    expect(() => assertSafeManifestPath('./a.json')).toThrow(/absolute/)
    expect(() => assertSafeManifestPath('/srv/../etc/passwd')).toThrow(/normalized/)
    expect(() => assertSafeManifestPath('/srv/manifest\0.json')).toThrow(/NUL/)
    expect(() => assertSafeManifestPath('   ')).toThrow(/must not be empty/)
  })

  it('accepts a plain absolute path', () => {
    expect(assertSafeManifestPath('/srv/manifests/a.json')).toBe('/srv/manifests/a.json')
  })
})

describe('manifest file loading', () => {
  let directory: string
  let manifestPath: string

  beforeAll(async () => {
    const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '.fixtures')
    await mkdir(fixtureRoot, { recursive: true })
    directory = await mkdtemp(join(fixtureRoot, 'manifest-'))
    manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(baseManifest()), 'utf8')
  })

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('loads and normalizes a manifest from an absolute local path', async () => {
    const snapshot = await new ManifestConnector({
      manifestPath,
      tenantId: TENANT,
      environmentId: ENVIRONMENT,
    }).discover()
    expect(snapshot.nodes).toHaveLength(7)
  })

  it('reports a missing file as a failed connection rather than throwing', async () => {
    const result = await new ManifestConnector({
      manifestPath: join(directory, 'absent.json'),
      tenantId: TENANT,
    }).testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('could not be read')
  })

  it('rejects a symbolic link', async () => {
    const linkPath = join(directory, 'link.json')
    await symlink(manifestPath, linkPath)
    const result = await new ManifestConnector({
      manifestPath: linkPath,
      tenantId: TENANT,
    }).testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('symbolic links are rejected')
  })

  it('rejects malformed JSON', async () => {
    const badPath = join(directory, 'bad.json')
    await writeFile(badPath, '{ not json', 'utf8')
    const result = await new ManifestConnector({
      manifestPath: badPath,
      tenantId: TENANT,
    }).testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not valid JSON')
  })
})

// ─── Connector surface ───────────────────────────────────────────────────────

describe('connector surface', () => {
  it('reports a successful connection with the manifest hash', async () => {
    const instance = connector(baseManifest())
    const result = await instance.testConnection()
    expect(result.ok).toBe(true)
    expect(result.message).toContain('non-authoritative')
    expect((await instance.getManifestHash()).length).toBe(64)
  })

  it('declares read-only capabilities and honest blind spots', () => {
    const { descriptor } = connector(baseManifest())
    expect(descriptor.id).toBe('custom-manifest-adapter')
    expect(descriptor.capabilities).toEqual(['discovery', 'evidence'])
    expect(descriptor.capabilities).not.toContain('remediation-execution')
    expect(descriptor.blindSpots.join(' ')).toContain('non-authoritative')
  })

  it('returns evidence by id and rejects an unknown id', async () => {
    const instance = connector(baseManifest())
    const [first] = await instance.listEvidence()
    expect(first).toBeDefined()
    await expect(instance.getEvidence(first!.id)).resolves.toMatchObject({ id: first!.id })
    await expect(instance.getEvidence('nope')).rejects.toThrow(/was not found/)
  })

  it('does not let an older in-flight load overwrite a fresh load after reset', async () => {
    const oldManifest = baseManifest()
    const freshManifest = withPatch((manifest) => {
      manifest['manifestId'] = 'mf-fresh'
    })
    let resolveOld: ((manifest: Raw) => void) | undefined
    let reads = 0
    const instance = new ManifestConnector(
      {
        manifestContent: oldManifest,
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
      },
      () => {
        reads += 1
        if (reads === 1)
          return new Promise<unknown>((resolve) => {
            resolveOld = resolve
          })
        return Promise.resolve(freshManifest)
      },
    )

    const oldLoad = instance.getEnvelope()
    instance.reset()
    await expect(instance.getEnvelope()).resolves.toMatchObject({ manifestId: 'mf-fresh' })
    if (resolveOld === undefined) throw new Error('The first manifest read did not start.')
    resolveOld(oldManifest)
    await expect(oldLoad).resolves.toMatchObject({ manifestId: 'mf-001' })
    await expect(instance.getEnvelope()).resolves.toMatchObject({ manifestId: 'mf-fresh' })
  })
})

// ─── Published artefacts ─────────────────────────────────────────────────────

const schemaPath = fileURLToPath(new URL('../schemas/manifest.schema.json', import.meta.url))
const samplePath = fileURLToPath(new URL('../examples/sample-manifest.json', import.meta.url))

describe('published artefacts', () => {
  it('validates the shipped example manifest', async () => {
    const sample: unknown = JSON.parse(await readFile(samplePath, 'utf8'))
    const validated = validateManifest(sample)
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    expect(validated.envelope.agents.length).toBeGreaterThanOrEqual(2)
    expect(validated.envelope.tools.length).toBeGreaterThanOrEqual(2)
    expect(validated.envelope.identities.length).toBeGreaterThanOrEqual(1)
    expect(validated.envelope.dataSources.length).toBeGreaterThanOrEqual(1)
    expect(validated.envelope.edges.length).toBeGreaterThanOrEqual(2)
    expect(validated.envelope.evidence.length).toBeGreaterThanOrEqual(2)
  })

  it('normalizes the shipped example manifest into a valid snapshot', async () => {
    const sample: unknown = JSON.parse(await readFile(samplePath, 'utf8'))
    const snapshot = await new ManifestConnector({
      manifestContent: sample,
      tenantId: 'contoso-ai-lab',
      environmentId: 'production',
    }).discover()
    expect(snapshot.nodes.filter((node) => node.kind === 'agent')).toHaveLength(2)
    expect(snapshot.edges).toHaveLength(4)
    expect(
      snapshot.nodes.find((node) => node.id.endsWith('invoice-triage-agent'))?.metadata[
        'approvalRequired'
      ],
    ).toBe('true')
  })

  it('keeps the JSON Schema in parity with the Zod contract', async () => {
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
      additionalProperties: boolean
      required: string[]
      properties: Record<string, { enum?: string[]; maxItems?: number }>
      $defs: Record<string, Record<string, unknown>>
    }

    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties['schemaVersion']?.enum).toEqual([...SUPPORTED_MANIFEST_VERSIONS])
    expect(schema.required).toEqual([
      'schemaVersion',
      'manifestId',
      'tenantId',
      'producedAt',
      'producer',
      'capabilities',
      'agents',
      'tools',
      'identities',
      'dataSources',
      'edges',
      'evidence',
    ])

    const defs = schema.$defs
    expect(defs['actionDepth']?.['enum']).toEqual(actionDepthSchema.options)
    expect(defs['entityKind']?.['enum']).toEqual(manifestEntityKindSchema.options)
    expect(defs['evidenceType']?.['enum']).toEqual(manifestEvidenceTypeSchema.options)
    expect(defs['sourceBinding']?.['required']).toEqual(
      Object.keys(manifestSourceBindingSchema.shape),
    )
    expect(defs['relationship']?.['enum']).toEqual([...SUPPORTED_MANIFEST_RELATIONSHIPS])
    expect(edgeDeclarationSchema.shape.relationship.options).toEqual([
      ...SUPPORTED_MANIFEST_RELATIONSHIPS,
    ])

    expect(defs['metadata']?.['maxProperties']).toBe(MANIFEST_LIMITS.maxMetadataKeys)
    expect((defs['metadata']?.['additionalProperties'] as { maxLength: number }).maxLength).toBe(
      MANIFEST_LIMITS.maxMetadataValueLength,
    )
    expect(defs['claims']?.['maxProperties']).toBe(MANIFEST_LIMITS.maxClaimKeys)
    expect((defs['claims']?.['additionalProperties'] as { maxLength: number }).maxLength).toBe(
      MANIFEST_LIMITS.maxClaimValueLength,
    )

    const confidence = (
      defs['evidenceDeclaration']?.['properties'] as Record<string, Record<string, unknown>>
    )['confidence']
    expect(confidence?.['minimum']).toBe(0)
    expect(confidence?.['maximum']).toBe(1)
    expect(confidence?.['default']).toBe(ADAPTER_DEFAULT_CONFIDENCE)

    expect(defs['sourceProvenance']?.['properties']).toMatchObject({
      isNonAuthoritative: { const: true },
      sourceOfTruth: { const: false },
    })
    expect(schema.properties['agents']?.maxItems).toBe(MANIFEST_LIMITS.maxEntitiesPerType)
    expect(schema.properties['tools']?.maxItems).toBe(MANIFEST_LIMITS.maxEntitiesPerType)
    expect(schema.properties['identities']?.maxItems).toBe(MANIFEST_LIMITS.maxEntitiesPerType)
    expect(schema.properties['dataSources']?.maxItems).toBe(MANIFEST_LIMITS.maxEntitiesPerType)
    expect(schema.properties['mcpDependencies']?.maxItems).toBe(MANIFEST_LIMITS.maxEntitiesPerType)
    expect(schema.properties['edges']?.maxItems).toBe(MANIFEST_LIMITS.maxEdges)
    expect(schema.properties['evidence']?.maxItems).toBe(MANIFEST_LIMITS.maxEvidenceRecords)
  })
})
