import { describe, expect, it } from 'vitest'

import {
  SOURCE_PROJECT_ID_MAX_LENGTH,
  connectorSourceAuditRecordSchema,
  connectorSourceCreateInputSchema,
  connectorSourceDefinitionSchema,
  connectorSourceReadModelSchema,
  connectorSourceTestStatusSchema,
  hydratePersistedConnectorSourceDefinition,
  sourceProjectIdSchema,
} from '../src/index.js'

const ACTOR = { type: 'deployment', id: 'bicep' } as const
const DEFINITION = {
  estateId: 'estate-a',
  tenantId: '00000000-0000-0000-0000-000000000001',
  environment: 'production',
  sourceId: 'foundry-primary',
  connectorType: 'foundry',
  displayName: 'Primary Foundry project',
  enabled: true,
  origin: 'deployment',
  configuration: {
    type: 'foundry',
    projectEndpoint: 'https://example.services.ai.azure.com/api/projects/project-a',
  },
  credential: {
    mode: 'managed-identity',
    managedIdentityClientId: '00000000-0000-0000-0000-000000000002',
  },
  testStatus: { status: 'not-tested' },
  version: 1,
  etag: 'source-etag-1',
  createdBy: ACTOR,
  updatedBy: ACTOR,
  createdAt: '2026-09-04T00:00:00.000Z',
  updatedAt: '2026-09-04T00:00:00.000Z',
} as const

const CREATE_INPUT = {
  estateId: DEFINITION.estateId,
  tenantId: DEFINITION.tenantId,
  environment: DEFINITION.environment,
  sourceId: DEFINITION.sourceId,
  connectorType: DEFINITION.connectorType,
  displayName: DEFINITION.displayName,
  enabled: DEFINITION.enabled,
  origin: DEFINITION.origin,
  configuration: DEFINITION.configuration,
  credential: DEFINITION.credential,
  testStatus: DEFINITION.testStatus,
} as const

describe('connector source domain', () => {
  it('accepts a strict estate-scoped non-secret definition', () => {
    expect(connectorSourceDefinitionSchema.parse(DEFINITION)).toEqual(DEFINITION)
  })

  it.each([
    { password: 'not-allowed' },
    { clientSecret: 'not-allowed' },
    { accessToken: 'not-allowed' },
    { rawCredentials: { token: 'not-allowed' } },
  ])('rejects secret-shaped credential fields', (secretField) => {
    const result = connectorSourceCreateInputSchema.safeParse({
      ...CREATE_INPUT,
      credential: { mode: 'default', ...secretField },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['credential'] })]),
      )
    }
  })

  it('rejects unknown fields, unrestricted URLs, and connector mismatches', () => {
    expect(() =>
      connectorSourceDefinitionSchema.parse({ ...DEFINITION, unexpected: true }),
    ).toThrow()
    expect(() =>
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        configuration: {
          type: 'foundry',
          projectEndpoint: 'https://attacker.example/api/projects/project-a',
        },
      }),
    ).toThrow()
    expect(() =>
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        configuration: {
          type: 'azure-resource-graph',
          subscriptions: ['00000000-0000-0000-0000-000000000003'],
        },
      }),
    ).toThrow()
  })

  it('bounds connector configuration', () => {
    expect(() =>
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        connectorType: 'azure-resource-graph',
        configuration: {
          type: 'azure-resource-graph',
          subscriptions: Array.from(
            { length: 101 },
            (_, index) => `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
          ),
        },
      }),
    ).toThrow()
  })

  it('uses the strict Agent 365 retry-after bound without narrowing other connectors', () => {
    const limits = {
      maxPages: 20,
      maxItems: 5_000,
      requestTimeoutMs: 15_000,
      maxRetries: 2,
      maxRetryAfterMs: 60_000,
      maxResponseBytes: 2_000_000,
    }
    expect(
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        sourceId: 'agent365-primary',
        connectorType: 'agent365',
        configuration: {
          type: 'agent365',
          graphBaseUrl: 'https://graph.microsoft.com',
          limits,
        },
      }).configuration,
    ).toMatchObject({ type: 'agent365', limits: { maxRetryAfterMs: 60_000 } })
    expect(() =>
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        sourceId: 'agent365-primary',
        connectorType: 'agent365',
        configuration: {
          type: 'agent365',
          graphBaseUrl: 'https://graph.microsoft.com',
          limits: { ...limits, maxRetryAfterMs: 60_001 },
        },
      }),
    ).toThrow()
    expect(
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        sourceId: 'defender-primary',
        connectorType: 'defender-cloud-apps',
        configuration: {
          type: 'defender-cloud-apps',
          apiBaseUrl: 'https://contoso.us2.portal.cloudappsecurity.com',
          limits: { ...limits, maxRetryAfterMs: 120_000 },
        },
      }).configuration,
    ).toMatchObject({
      type: 'defender-cloud-apps',
      limits: { maxRetryAfterMs: 120_000 },
    })
  })

  it('keeps Azure Monitor writes strict when sourceProjectId is missing', () => {
    expect(() =>
      connectorSourceCreateInputSchema.parse({
        ...CREATE_INPUT,
        connectorType: 'azure-monitor-otel',
        configuration: {
          type: 'azure-monitor-otel',
          workspaceId: '00000000-0000-0000-0000-000000000003',
          logsBaseUrl: 'https://api.loganalytics.io',
          baselineWindowHours: 168,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
          maxResponseBytes: 4_194_304,
        },
      }),
    ).toThrow()
  })

  it('shares the exact Azure Monitor source project ID boundary', () => {
    const maximum = 'p'.repeat(SOURCE_PROJECT_ID_MAX_LENGTH)
    const tooLong = `${maximum}x`

    expect(sourceProjectIdSchema.parse(maximum)).toBe(maximum)
    expect(sourceProjectIdSchema.safeParse(tooLong).success).toBe(false)
    expect(
      connectorSourceCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        connectorType: 'azure-monitor-otel',
        configuration: {
          type: 'azure-monitor-otel',
          workspaceId: '00000000-0000-0000-0000-000000000003',
          sourceProjectId: tooLong,
          logsBaseUrl: 'https://api.loganalytics.io',
          baselineWindowHours: 168,
          observedWindowHours: 24,
          requestTimeoutMs: 15_000,
          maxResponseBytes: 4_194_304,
        },
      }).success,
    ).toBe(false)
  })

  it('shares the exact Foundry endpoint project ID boundary', () => {
    const maximum = 'p'.repeat(SOURCE_PROJECT_ID_MAX_LENGTH)
    const endpoint = (projectId: string) =>
      `https://example.services.ai.azure.com/api/projects/${projectId}`

    expect(
      connectorSourceCreateInputSchema.parse({
        ...CREATE_INPUT,
        configuration: {
          type: 'foundry',
          projectEndpoint: ` ${endpoint(maximum)}/ `,
        },
      }).configuration,
    ).toEqual({
      type: 'foundry',
      projectEndpoint: endpoint(maximum),
    })
    expect(
      connectorSourceCreateInputSchema.safeParse({
        ...CREATE_INPUT,
        configuration: {
          type: 'foundry',
          projectEndpoint: endpoint(`${maximum}x`),
        },
      }).success,
    ).toBe(false)
  })

  it('marks a legacy Azure Monitor source inactive when no exact project binding exists', () => {
    const legacy = {
      ...DEFINITION,
      sourceId: 'azure-monitor-primary',
      connectorType: 'azure-monitor-otel',
      configuration: {
        type: 'azure-monitor-otel',
        workspaceId: '00000000-0000-0000-0000-000000000003',
        logsBaseUrl: 'https://api.loganalytics.io',
        baselineWindowHours: 168,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 4_194_304,
      },
    }

    const hydrated = hydratePersistedConnectorSourceDefinition(legacy)

    expect(connectorSourceReadModelSchema.parse(hydrated)).toMatchObject({
      sourceId: 'azure-monitor-primary',
      connectorType: 'azure-monitor-otel',
      enabled: false,
      testStatus: { status: 'not-tested' },
      migration: {
        status: 'migration-required',
        active: false,
        reason: 'missing-source-project-id',
        action: 'supply-exact-source-project-id',
      },
    })
    expect(hydrated.configuration).not.toHaveProperty('sourceProjectId')
  })

  it('hydrates sourceProjectId only from one exact authoritative deployment binding', () => {
    const legacy = {
      ...DEFINITION,
      sourceId: 'azure-monitor-primary',
      connectorType: 'azure-monitor-otel',
      configuration: {
        type: 'azure-monitor-otel',
        workspaceId: '00000000-0000-0000-0000-000000000003',
        logsBaseUrl: 'https://api.loganalytics.io',
        baselineWindowHours: 168,
        observedWindowHours: 24,
        requestTimeoutMs: 15_000,
        maxResponseBytes: 4_194_304,
      },
    }
    const authoritative = connectorSourceDefinitionSchema.parse({
      ...legacy,
      origin: 'deployment',
      configuration: {
        ...legacy.configuration,
        sourceProjectId: 'project-a',
      },
    })

    expect(hydratePersistedConnectorSourceDefinition(legacy, [authoritative])).toMatchObject({
      enabled: true,
      configuration: {
        type: 'azure-monitor-otel',
        sourceProjectId: 'project-a',
      },
    })
    expect(
      hydratePersistedConnectorSourceDefinition(legacy, [
        connectorSourceDefinitionSchema.parse({
          ...legacy,
          origin: 'deployment',
          configuration: {
            ...legacy.configuration,
            sourceProjectId: 'project-a',
            workspaceId: '00000000-0000-0000-0000-000000000004',
          },
        }),
      ]),
    ).toMatchObject({
      enabled: false,
      migration: { status: 'migration-required' },
    })
    expect(
      hydratePersistedConnectorSourceDefinition(legacy, [
        authoritative,
        connectorSourceDefinitionSchema.parse({
          ...authoritative,
          configuration: {
            ...authoritative.configuration,
            sourceProjectId: 'project-b',
          },
        }),
      ]),
    ).toMatchObject({
      enabled: false,
      migration: { status: 'migration-required' },
    })
  })

  it('requires real provider evidence for a passing test', () => {
    expect(() =>
      connectorSourceTestStatusSchema.parse({
        status: 'passed',
        evidenceBasis: 'synthetic',
        evidenceIds: ['evidence-1'],
        checkedAt: '2026-09-04T00:01:00.000Z',
        checkedBy: { type: 'user', id: 'admin@example.test' },
        summary: 'Synthetic probe passed.',
      }),
    ).toThrow()
    expect(
      connectorSourceTestStatusSchema.parse({
        status: 'passed',
        evidenceBasis: 'provider-response',
        evidenceIds: ['evidence-1'],
        checkedAt: '2026-09-04T00:01:00.000Z',
        checkedBy: { type: 'user', id: 'admin@example.test' },
        summary: 'Provider returned a bounded successful response.',
      }),
    ).toMatchObject({ status: 'passed' })
  })

  it('normalizes timestamps before chronological validation', () => {
    expect(
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        createdAt: '2026-09-04T08:00:00+09:00',
        updatedAt: '2026-09-03T23:30:00Z',
      }),
    ).toMatchObject({
      createdAt: '2026-09-03T23:00:00.000Z',
      updatedAt: '2026-09-03T23:30:00.000Z',
    })
    expect(() =>
      connectorSourceDefinitionSchema.parse({
        ...DEFINITION,
        createdAt: '2026-09-04T00:00:00Z',
        updatedAt: '2026-09-04T08:30:00+09:00',
      }),
    ).toThrow('updatedAt cannot precede createdAt')
  })

  it('enforces immutable, attributed audit snapshots', () => {
    expect(
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-create',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'create',
        actor: ACTOR,
        occurredAt: DEFINITION.createdAt,
        idempotencyKey: 'create-source',
        before: null,
        after: DEFINITION,
      }),
    ).toMatchObject({ operation: 'create' })
    expect(() =>
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-update',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'update',
        actor: { type: 'user', id: 'admin@example.test' },
        occurredAt: '2026-09-04T00:01:00.000Z',
        idempotencyKey: 'update-source',
        before: DEFINITION,
        after: {
          ...DEFINITION,
          origin: 'user',
          version: 2,
          etag: 'source-etag-2',
          updatedBy: { type: 'user', id: 'admin@example.test' },
          updatedAt: '2026-09-04T00:01:00.000Z',
        },
      }),
    ).toThrow('immutable fields')
  })

  it('rejects reverse-sorting equal-time successor audits', () => {
    const created = connectorSourceAuditRecordSchema.parse({
      id: 'audit-z-create',
      estateId: DEFINITION.estateId,
      tenantId: DEFINITION.tenantId,
      environment: DEFINITION.environment,
      sourceId: DEFINITION.sourceId,
      operation: 'create',
      actor: ACTOR,
      occurredAt: DEFINITION.createdAt,
      idempotencyKey: 'reverse-create',
      before: null,
      after: DEFINITION,
    }).after!

    expect(() =>
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-y-update',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'update',
        actor: ACTOR,
        occurredAt: created.updatedAt,
        idempotencyKey: 'reverse-update',
        before: created,
        after: {
          ...created,
          version: 2,
          etag: 'source-etag-2',
        },
      }),
    ).toThrow('must occur after the current source version')

    const updated = connectorSourceAuditRecordSchema.parse({
      id: 'audit-y-update',
      estateId: DEFINITION.estateId,
      tenantId: DEFINITION.tenantId,
      environment: DEFINITION.environment,
      sourceId: DEFINITION.sourceId,
      operation: 'update',
      actor: ACTOR,
      occurredAt: '2026-09-04T00:01:00.000Z',
      idempotencyKey: 'reverse-update',
      before: created,
      after: {
        ...created,
        version: 2,
        etag: 'source-etag-2',
        updatedAt: '2026-09-04T00:01:00.000Z',
      },
    }).after!

    expect(() =>
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-x-delete',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'delete',
        actor: ACTOR,
        occurredAt: updated.updatedAt,
        idempotencyKey: 'reverse-delete',
        before: updated,
        after: null,
      }),
    ).toThrow('must occur after the source version')
  })

  it('rejects an update audit that precedes the prior updatedAt', () => {
    const occurredAt = '2026-09-04T00:01:00.000Z'
    const before = {
      ...DEFINITION,
      version: 2,
      etag: 'source-etag-2',
      updatedAt: '2026-09-04T00:02:00.000Z',
    }
    expect(() =>
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-regressed-update',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'update',
        actor: { type: 'user', id: 'admin@example.test' },
        occurredAt,
        idempotencyKey: 'regressed-update',
        before,
        after: {
          ...before,
          displayName: 'Regressed update',
          version: 3,
          etag: 'source-etag-3',
          updatedBy: { type: 'user', id: 'admin@example.test' },
          updatedAt: occurredAt,
        },
      }),
    ).toThrow('must occur after the current source version')
  })

  it('rejects a delete audit that precedes the prior updatedAt', () => {
    const occurredAt = '2026-09-04T00:01:00.000Z'
    const before = {
      ...DEFINITION,
      version: 2,
      etag: 'source-etag-2',
      updatedAt: '2026-09-04T00:02:00.000Z',
    }
    expect(() =>
      connectorSourceAuditRecordSchema.parse({
        id: 'audit-regressed-delete',
        estateId: DEFINITION.estateId,
        tenantId: DEFINITION.tenantId,
        environment: DEFINITION.environment,
        sourceId: DEFINITION.sourceId,
        operation: 'delete',
        actor: { type: 'user', id: 'admin@example.test' },
        occurredAt,
        idempotencyKey: 'regressed-delete',
        before,
        after: null,
      }),
    ).toThrow('must occur after the source version')
  })
})
