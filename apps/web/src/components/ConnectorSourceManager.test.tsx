/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectorSourceDefinition, ConnectorSourceReadModel } from '@agent-sentinel/domain'

import {
  ConnectorSourceApiError,
  connectorSourcesApi,
  type ConnectorSourcePage,
  type ConnectorSourceConnectionStatus,
} from '../api/connectors-api'
import { setActiveEstateId } from '../api/auth-fetch'
import { useAuth } from '../hooks/useAuth'
import { ConnectorSourceManager } from './ConnectorSourceManager'

vi.mock('../api/connectors-api')
vi.mock('../hooks/useAuth')

const userSource: ConnectorSourceDefinition = {
  estateId: 'estate-one',
  tenantId: 'tenant-one',
  environment: 'production',
  sourceId: 'primary',
  connectorType: 'foundry',
  displayName: 'Primary Foundry',
  enabled: false,
  origin: 'user',
  configuration: {
    type: 'foundry',
    projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/primary',
  },
  credential: { mode: 'default' },
  testStatus: {
    status: 'degraded',
    evidenceBasis: 'provider-response',
    evidenceIds: ['evidence-old'],
    checkedAt: '2020-01-01T00:00:00.000Z',
    checkedBy: { type: 'user', id: 'administrator-object-id' },
    summary: 'Provider returned a partial response.',
  },
  version: 2,
  etag: 'etag-two',
  createdBy: { type: 'user', id: 'administrator-object-id' },
  updatedBy: { type: 'user', id: 'administrator-object-id' },
  createdAt: '2020-01-01T00:00:00.000Z',
  updatedAt: '2020-01-01T01:00:00.000Z',
}

const deploymentSource: ConnectorSourceDefinition = {
  ...userSource,
  sourceId: 'deployment-primary',
  displayName: 'Deployment Foundry',
  enabled: true,
  origin: 'deployment',
  etag: 'deployment-etag',
  createdBy: { type: 'deployment', id: 'deployment-json' },
  updatedBy: { type: 'deployment', id: 'deployment-json' },
}

const agent365Configuration = {
  type: 'agent365',
  graphBaseUrl: 'https://graph.microsoft.com',
  limits: {
    maxPages: 20,
    maxItems: 5_000,
    requestTimeoutMs: 15_000,
    maxRetries: 2,
    maxRetryAfterMs: 30_000,
    maxResponseBytes: 2_000_000,
  },
  aggregation: {
    maxConcurrency: 4,
    maxDurationMs: 120_000,
  },
} as const satisfies ConnectorSourceDefinition['configuration']

const agent365Source: ConnectorSourceDefinition = {
  ...userSource,
  sourceId: 'agent365-live',
  connectorType: 'agent365',
  displayName: 'Live Agent 365',
  enabled: true,
  configuration: agent365Configuration,
  credential: {
    mode: 'managed-identity',
    managedIdentityClientId: '59dbea72-1e91-403a-89cf-e02cdb8da350',
  },
}

const otelUserSource = {
  ...userSource,
  sourceId: 'runtime-otel',
  connectorType: 'azure-monitor-otel',
  displayName: 'Runtime telemetry',
  enabled: true,
  configuration: {
    type: 'azure-monitor-otel',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    sourceProjectId: 'project-a',
    logsBaseUrl: 'https://api.loganalytics.io',
    baselineWindowHours: 168,
    observedWindowHours: 24,
    requestTimeoutMs: 15_000,
    maxResponseBytes: 4_096,
  },
} satisfies ConnectorSourceDefinition

const migrationRequiredSource = {
  ...otelUserSource,
  sourceId: 'legacy-runtime-otel',
  displayName: 'Legacy runtime telemetry',
  enabled: false,
  configuration: {
    type: 'azure-monitor-otel',
    workspaceId: '11111111-1111-4111-8111-111111111111',
    logsBaseUrl: 'https://api.loganalytics.io',
    baselineWindowHours: 168,
    observedWindowHours: 24,
    requestTimeoutMs: 15_000,
    maxResponseBytes: 4_096,
  },
  testStatus: { status: 'not-tested' },
  migration: {
    status: 'migration-required',
    active: false,
    reason: 'missing-source-project-id',
    action: 'supply-exact-source-project-id',
  },
} satisfies ConnectorSourceReadModel

const writablePage: ConnectorSourcePage = {
  items: [userSource, deploymentSource],
  page: { limit: 50, nextCursor: null },
  mutationPolicy: {
    enabled: true,
    requiresAuthentication: true,
    requiredCapability: 'configure',
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function mockAdministrator(): void {
  vi.mocked(useAuth).mockReturnValue({
    isConfigured: true,
    spaConfig: null,
    isLoading: false,
    isSignedIn: true,
    principal: {
      subject: 'administrator-subject',
      tenantId: 'auth-tenant',
      roles: ['Administrator'],
      capabilities: ['read', 'configure'],
    },
    authError: null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    getAccessToken: vi.fn(),
  })
}

describe('ConnectorSourceManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActiveEstateId('estate-one')
    mockAdministrator()
    vi.mocked(connectorSourcesApi.list).mockResolvedValue(writablePage)
  })

  afterEach(() => {
    cleanup()
    setActiveEstateId(undefined)
  })

  it('shows exact IDs, deployment immutability, disabled state, and stale evidence', async () => {
    render(<ConnectorSourceManager />)

    expect(
      await screen.findByText(/Agent 365 sources are deployment managed and read-only/i),
    ).toBeVisible()

    const userCard = screen.getByRole('article', { name: 'Primary Foundry' })
    expect(userCard).toHaveTextContent('primary')
    expect(userCard).toHaveTextContent('Disabled')
    expect(userCard).toHaveTextContent('Stale')

    const deploymentCard = screen.getByRole('article', { name: 'Deployment Foundry' })
    expect(deploymentCard).toHaveTextContent('deployment-primary')
    expect(deploymentCard).toHaveTextContent('Deployment managed')
    expect(within(deploymentCard).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(deploymentCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('labels provider, synthetic, and unknown evidence without presenting synthetic results as live', async () => {
    const syntheticStatuses: ConnectorSourceDefinition[] = (
      ['degraded', 'failed', 'insufficient-data'] as const
    ).map((status, index) => ({
      ...userSource,
      sourceId: `synthetic-${index}`,
      displayName: `Synthetic ${status}`,
      testStatus: {
        status,
        evidenceBasis: 'synthetic',
        evidenceIds: [`synthetic-${index}-evidence`],
        checkedAt: '2026-09-06T04:00:00.000Z',
        checkedBy: { type: 'user', id: 'administrator-object-id' },
        summary: `Synthetic ${status} result.`,
      },
    }))
    vi.mocked(connectorSourcesApi.list).mockResolvedValue({
      ...writablePage,
      items: [
        userSource,
        ...syntheticStatuses,
        { ...deploymentSource, testStatus: { status: 'not-tested' } },
      ],
    })
    render(<ConnectorSourceManager />)

    expect(
      within(await screen.findByRole('article', { name: 'Primary Foundry' })).getByText(
        'Provider response evidence',
      ),
    ).toBeVisible()
    for (const status of ['degraded', 'failed', 'insufficient-data']) {
      const card = screen.getByRole('article', { name: `Synthetic ${status}` })
      expect(card).toHaveTextContent('Synthetic evidence - not live provider evidence')
      expect(card.textContent?.match(/\blive\b/gi)).toHaveLength(1)
    }
    expect(
      within(screen.getByRole('article', { name: 'Deployment Foundry' })).getByText(
        'Unknown / no evidence',
      ),
    ).toBeVisible()
  })

  it('shows why configuration is disabled when the deployment write gate is closed', async () => {
    vi.mocked(connectorSourcesApi.list).mockResolvedValue({
      ...writablePage,
      mutationPolicy: { ...writablePage.mutationPolicy, enabled: false },
    })
    render(<ConnectorSourceManager />)

    expect(await screen.findByRole('button', { name: 'Add connector source' })).toBeDisabled()
    expect(screen.getByText(/deployment write gate is disabled/i)).toBeVisible()
  })

  it('requires the configure capability before exposing mutation controls', async () => {
    vi.mocked(useAuth).mockReturnValue({
      ...vi.mocked(useAuth)(),
      principal: {
        subject: 'viewer-subject',
        tenantId: 'auth-tenant',
        roles: ['Viewer'],
        capabilities: ['read'],
      },
    })
    render(<ConnectorSourceManager />)

    expect(await screen.findByRole('button', { name: 'Add connector source' })).toBeDisabled()
    expect(screen.getByText(/administrator configure capability/i)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('creates a strict non-secret Foundry source and reloads the list', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.create).mockResolvedValue({
      replayed: false,
      source: userSource,
    })
    render(<ConnectorSourceManager />)

    await user.click(await screen.findByRole('button', { name: 'Add connector source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    await user.type(within(dialog).getByLabelText('Source ID'), 'new-foundry')
    await user.type(within(dialog).getByLabelText('Display name'), 'New Foundry')
    await user.type(
      within(dialog).getByLabelText('Project endpoint'),
      'https://safe.services.ai.azure.com/api/projects/new-foundry',
    )
    expect(within(dialog).queryByLabelText(/password|client secret|access token/i)).toBeNull()
    await user.click(within(dialog).getByRole('button', { name: 'Create source' }))

    await waitFor(() =>
      expect(connectorSourcesApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'new-foundry',
          connectorType: 'foundry',
          displayName: 'New Foundry',
          configuration: {
            type: 'foundry',
            projectEndpoint: 'https://safe.services.ai.azure.com/api/projects/new-foundry',
          },
          credential: { mode: 'default' },
        }),
        expect.stringMatching(/^connector-source-create-/),
      ),
    )
    expect(connectorSourcesApi.list).toHaveBeenCalledTimes(2)
  })

  it('creates Azure Monitor sources with an explicit response byte bound', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.create).mockResolvedValue({
      replayed: false,
      source: userSource,
    })
    render(<ConnectorSourceManager />)

    await user.click(await screen.findByRole('button', { name: 'Add connector source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    await user.type(within(dialog).getByLabelText('Source ID'), 'runtime-otel')
    await user.type(within(dialog).getByLabelText('Display name'), 'Runtime telemetry')
    await user.selectOptions(within(dialog).getByLabelText('Connector type'), 'azure-monitor-otel')
    await user.type(
      within(dialog).getByLabelText('Workspace ID'),
      '11111111-1111-4111-8111-111111111111',
    )
    await user.type(within(dialog).getByLabelText('Source project ID'), 'project-a')
    fireEvent.change(within(dialog).getByLabelText('Maximum response bytes'), {
      target: { value: '4096' },
    })
    await user.click(within(dialog).getByRole('button', { name: 'Create source' }))

    await waitFor(() => expect(connectorSourcesApi.create).toHaveBeenCalledOnce())
    const [request, idempotencyKey] = vi.mocked(connectorSourcesApi.create).mock.calls[0]!
    expect(request).toMatchObject({
      connectorType: 'azure-monitor-otel',
      configuration: {
        type: 'azure-monitor-otel',
        workspaceId: '11111111-1111-4111-8111-111111111111',
        sourceProjectId: 'project-a',
        maxResponseBytes: 4_096,
      },
    })
    expect(idempotencyKey).toMatch(/^connector-source-create-/)
  })

  it('keeps Agent 365 visible and read-only while excluding it from Add Source', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.list).mockResolvedValue({
      ...writablePage,
      items: [
        agent365Source,
        {
          ...agent365Source,
          sourceId: 'agent365-deployment',
          displayName: 'Deployment Agent 365',
          origin: 'deployment',
          runtimeBinding: { bindingSourceId: 'primary' },
          createdBy: { type: 'deployment', id: 'deployment-json' },
          updatedBy: { type: 'deployment', id: 'deployment-json' },
        },
      ],
    })
    vi.mocked(connectorSourcesApi.getConnectionTestStatus).mockResolvedValue({
      estateId: agent365Source.estateId,
      tenantId: agent365Source.tenantId,
      environment: agent365Source.environment,
      sourceId: agent365Source.sourceId,
      connectorType: 'agent365',
      readOnly: true,
      status: 'authorization-required',
      evidenceAvailability: 'unavailable',
      evidenceBasis: null,
      evidenceIds: [],
      checkedAt: null,
      checkedBy: null,
      summary: 'The persisted legacy source is inactive because deployment origin is required.',
    })
    render(<ConnectorSourceManager />)

    await user.click(await screen.findByRole('button', { name: 'Add connector source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    expect(
      within(dialog).queryByRole('option', { name: 'Microsoft Agent 365' }),
    ).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    for (const name of ['Live Agent 365', 'Deployment Agent 365']) {
      const card = screen.getByRole('article', { name })
      expect(within(card).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
      expect(within(card).queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
      expect(within(card).queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
      expect(within(card).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
      expect(
        within(card).getByText(/Agent 365 sources are deployment managed and read-only/i),
      ).toBeVisible()
    }

    const legacyCard = screen.getByRole('article', { name: 'Live Agent 365' })
    expect(legacyCard).toHaveTextContent('Legacy user record')
    await user.click(within(legacyCard).getByRole('button', { name: 'Check test evidence' }))
    expect(await within(legacyCard).findByRole('status')).toHaveTextContent(
      'deployment origin is required',
    )
  })

  it('hydrates and updates the bounded Azure Monitor source project ID', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.list).mockResolvedValue({
      ...writablePage,
      items: [otelUserSource],
    })
    vi.mocked(connectorSourcesApi.update).mockResolvedValue({
      replayed: false,
      source: {
        ...otelUserSource,
        configuration: {
          ...otelUserSource.configuration,
          sourceProjectId: 'project-b',
        },
      },
    })
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Runtime telemetry' })
    await user.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit Runtime telemetry' })
    const sourceProjectId = within(dialog).getByLabelText('Source project ID')
    expect(sourceProjectId).toHaveValue('project-a')
    expect(sourceProjectId).toHaveAttribute('required')
    expect(sourceProjectId).toHaveAttribute('maxlength', '200')

    await user.clear(sourceProjectId)
    await user.type(sourceProjectId, 'project-b')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledOnce())
    const [sourceId, patch, etag, idempotencyKey] = vi.mocked(connectorSourcesApi.update).mock
      .calls[0]!
    expect(sourceId).toBe('runtime-otel')
    expect(patch.configuration).toMatchObject({
      type: 'azure-monitor-otel',
      sourceProjectId: 'project-b',
    })
    expect(etag).toBe('etag-two')
    expect(idempotencyKey).toMatch(/^connector-source-update-/)
  })

  it('reuses a create key after ambiguous failures and replaces it when the payload changes', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.create).mockRejectedValue(new TypeError('Network unavailable.'))
    render(<ConnectorSourceManager />)

    await user.click(await screen.findByRole('button', { name: 'Add connector source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    await user.type(within(dialog).getByLabelText('Source ID'), 'new-foundry')
    const displayName = within(dialog).getByLabelText('Display name')
    await user.type(displayName, 'New Foundry')
    await user.type(
      within(dialog).getByLabelText('Project endpoint'),
      'https://safe.services.ai.azure.com/api/projects/new-foundry',
    )

    await user.click(within(dialog).getByRole('button', { name: 'Create source' }))
    await within(dialog).findByRole('alert')
    await user.click(within(dialog).getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(connectorSourcesApi.create).toHaveBeenCalledTimes(2))

    const firstKey = vi.mocked(connectorSourcesApi.create).mock.calls[0]?.[1]
    const secondKey = vi.mocked(connectorSourcesApi.create).mock.calls[1]?.[1]
    expect(secondKey).toBe(firstKey)

    await user.type(displayName, ' changed')
    await user.click(within(dialog).getByRole('button', { name: 'Create source' }))
    await waitFor(() => expect(connectorSourcesApi.create).toHaveBeenCalledTimes(3))
    expect(vi.mocked(connectorSourcesApi.create).mock.calls[2]?.[1]).not.toBe(secondKey)
  })

  it('moves focus into the source dialog and restores it when Escape closes the dialog', async () => {
    const user = userEvent.setup()
    render(<ConnectorSourceManager />)

    const addButton = await screen.findByRole('button', { name: 'Add connector source' })
    await user.click(addButton)

    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    expect(within(dialog).getByLabelText('Source ID')).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Add connector source' })).not.toBeInTheDocument()
    expect(addButton).toHaveFocus()
  })

  it('restores edit focus only after a successful mutation reloads and enables the control', async () => {
    const user = userEvent.setup()
    const reload = deferred<ConnectorSourcePage>()
    vi.mocked(connectorSourcesApi.list)
      .mockResolvedValueOnce(writablePage)
      .mockImplementationOnce(() => reload.promise)
    vi.mocked(connectorSourcesApi.update).mockResolvedValue({
      replayed: false,
      source: { ...userSource, displayName: 'Changed name', etag: 'etag-three' },
    })
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    const editButton = within(card).getByRole('button', { name: 'Edit' })
    await user.click(editButton)
    const dialog = screen.getByRole('dialog', { name: 'Edit Primary Foundry' })
    const displayName = within(dialog).getByLabelText('Display name')
    await user.clear(displayName)
    await user.type(displayName, 'Changed name')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(connectorSourcesApi.list).toHaveBeenCalledTimes(2))
    expect(editButton).toBeDisabled()
    expect(editButton).not.toHaveFocus()

    reload.resolve({
      ...writablePage,
      items: [{ ...userSource, displayName: 'Changed name', etag: 'etag-three' }, deploymentSource],
    })

    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: 'Changed name' })).getByRole('button', {
          name: 'Edit',
        }),
      ).toHaveFocus(),
    )
  })

  it('keeps keyboard focus within the source dialog', async () => {
    const user = userEvent.setup()
    render(<ConnectorSourceManager />)

    await user.click(await screen.findByRole('button', { name: 'Add connector source' }))
    const dialog = screen.getByRole('dialog', { name: 'Add connector source' })
    const sourceId = within(dialog).getByLabelText('Source ID')
    const submit = within(dialog).getByRole('button', { name: 'Create source' })

    submit.focus()
    await user.tab()
    expect(sourceId).toHaveFocus()

    await user.tab({ shift: true })
    expect(submit).toHaveFocus()
  })

  it('updates with the current ETag and reports stale conflicts', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.update).mockRejectedValue(
      Object.assign(new Error('The connector source changed. Refresh its ETag and retry.'), {
        status: 412,
        code: 'etag_mismatch',
      }),
    )
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    await user.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit Primary Foundry' })
    const displayName = within(dialog).getByLabelText('Display name')
    await user.clear(displayName)
    await user.type(displayName, 'Changed name')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(connectorSourcesApi.update).toHaveBeenCalledWith(
        'primary',
        expect.objectContaining({ displayName: 'Changed name' }),
        'etag-two',
        expect.stringMatching(/^connector-source-update-/),
      ),
    )
    const alert = await within(dialog).findByRole('alert')
    expect(alert).toHaveTextContent(/refresh and try again/i)
    expect(alert).toHaveAttribute('aria-live', 'assertive')
    expect(alert.id).not.toBe('')
    expect(dialog.getAttribute('aria-describedby')).toContain(alert.id)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('reuses an update key after an ambiguous failure and replaces it for a changed patch', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.update).mockRejectedValue(
      new ConnectorSourceApiError('Service response was lost.', 503),
    )
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    await user.click(within(card).getByRole('button', { name: 'Edit' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit Primary Foundry' })
    const displayName = within(dialog).getByLabelText('Display name')
    await user.clear(displayName)
    await user.type(displayName, 'Changed name')

    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await within(dialog).findByRole('alert')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledTimes(2))
    const firstKey = vi.mocked(connectorSourcesApi.update).mock.calls[0]?.[3]
    expect(vi.mocked(connectorSourcesApi.update).mock.calls[1]?.[3]).toBe(firstKey)

    await user.type(displayName, ' again')
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledTimes(3))
    expect(vi.mocked(connectorSourcesApi.update).mock.calls[2]?.[3]).not.toBe(firstKey)
  })

  it('requires explicit confirmation before deleting a user source', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.delete).mockResolvedValue({
      replayed: false,
      source: null,
    })
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    await user.click(within(card).getByRole('button', { name: 'Delete' }))
    expect(connectorSourcesApi.delete).not.toHaveBeenCalled()
    await user.click(within(card).getByRole('button', { name: 'Confirm delete' }))

    await waitFor(() =>
      expect(connectorSourcesApi.delete).toHaveBeenCalledWith(
        'primary',
        'etag-two',
        expect.stringMatching(/^connector-source-delete-/),
      ),
    )
  })

  it('reuses toggle and delete keys for ambiguous retries and replaces deliberate mutations', async () => {
    const user = userEvent.setup()
    vi.mocked(connectorSourcesApi.update)
      .mockRejectedValueOnce(new TypeError('Toggle response lost.'))
      .mockRejectedValueOnce(new TypeError('Toggle response lost again.'))
      .mockResolvedValueOnce({
        replayed: false,
        source: { ...userSource, enabled: true, etag: 'etag-three' },
      })
    vi.mocked(connectorSourcesApi.delete).mockRejectedValue(new TypeError('Delete response lost.'))
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    const enable = within(card).getByRole('button', { name: 'Enable' })
    await user.click(enable)
    await screen.findByRole('alert')
    await user.click(enable)
    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledTimes(2))
    const firstToggleKey = vi.mocked(connectorSourcesApi.update).mock.calls[0]?.[3]
    expect(vi.mocked(connectorSourcesApi.update).mock.calls[1]?.[3]).toBe(firstToggleKey)

    await user.click(enable)
    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledTimes(3))
    expect(vi.mocked(connectorSourcesApi.update).mock.calls[2]?.[3]).toBe(firstToggleKey)

    vi.mocked(connectorSourcesApi.list).mockResolvedValueOnce({
      ...writablePage,
      items: [{ ...userSource, enabled: true, etag: 'etag-three' }, deploymentSource],
    })
    await user.click(screen.getByRole('button', { name: 'Refresh sources' }))
    const refreshedCard = await screen.findByRole('article', { name: 'Primary Foundry' })
    await user.click(within(refreshedCard).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(connectorSourcesApi.update).toHaveBeenCalledTimes(4))
    expect(vi.mocked(connectorSourcesApi.update).mock.calls[3]?.[3]).not.toBe(firstToggleKey)

    const deleteButton = within(refreshedCard).getByRole('button', { name: 'Delete' })
    await user.click(deleteButton)
    const confirmDelete = within(refreshedCard).getByRole('button', { name: 'Confirm delete' })
    await user.click(confirmDelete)
    await waitFor(() => expect(connectorSourcesApi.delete).toHaveBeenCalledTimes(1))
    await user.click(confirmDelete)
    await waitFor(() => expect(connectorSourcesApi.delete).toHaveBeenCalledTimes(2))
    const firstDeleteKey = vi.mocked(connectorSourcesApi.delete).mock.calls[0]?.[2]
    expect(vi.mocked(connectorSourcesApi.delete).mock.calls[1]?.[2]).toBe(firstDeleteKey)

    await user.click(within(refreshedCard).getByRole('button', { name: 'Cancel delete' }))
    await user.click(within(refreshedCard).getByRole('button', { name: 'Delete' }))
    await user.click(within(refreshedCard).getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(connectorSourcesApi.delete).toHaveBeenCalledTimes(3))
    expect(vi.mocked(connectorSourcesApi.delete).mock.calls[2]?.[2]).not.toBe(firstDeleteKey)
  })

  it('checks read-only provider evidence and preserves unknown health', async () => {
    const user = userEvent.setup()
    const unknownStatus: ConnectorSourceConnectionStatus = {
      estateId: 'estate-one',
      tenantId: 'tenant-one',
      environment: 'production',
      sourceId: 'primary',
      connectorType: 'foundry',
      readOnly: true,
      status: 'unknown',
      evidenceAvailability: 'unavailable',
      evidenceBasis: null,
      evidenceIds: [],
      checkedAt: null,
      checkedBy: null,
      summary: 'No evidence-backed connection test has been recorded.',
    }
    vi.mocked(connectorSourcesApi.getConnectionTestStatus).mockResolvedValue(unknownStatus)
    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Primary Foundry' })
    await user.click(within(card).getByRole('button', { name: 'Check test evidence' }))

    expect(await within(card).findByRole('status')).toHaveTextContent(
      'No evidence-backed connection test has been recorded.',
    )
    expect(within(card).getByRole('status')).toHaveTextContent('Unknown')
    expect(within(card).getByRole('status')).toHaveTextContent('Unknown / no evidence')
  })

  it('renders legacy Azure Monitor sources inactive with migration guidance and no actions', async () => {
    vi.mocked(connectorSourcesApi.list).mockResolvedValueOnce({
      ...writablePage,
      items: [migrationRequiredSource],
    })

    render(<ConnectorSourceManager />)

    const card = await screen.findByRole('article', { name: 'Legacy runtime telemetry' })
    expect(within(card).getByText('Migration required')).toBeVisible()
    expect(within(card).getByRole('status')).toHaveTextContent(
      'Add the exact authoritative source project ID before activating this connector.',
    )
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Enable' })).toBeNull()
    expect(within(card).queryByRole('button', { name: 'Check test evidence' })).toBeNull()
  })

  it('shows a cursor loading state, suppresses duplicate requests, and merges exact IDs in order', async () => {
    const cursorPage = deferred<ConnectorSourcePage>()
    vi.mocked(connectorSourcesApi.list)
      .mockResolvedValueOnce({
        ...writablePage,
        page: { limit: 50, nextCursor: 'primary' },
      })
      .mockImplementationOnce(() => cursorPage.promise)
    render(<ConnectorSourceManager />)

    const loadMore = await screen.findByRole('button', { name: 'Load more sources' })
    fireEvent.click(loadMore)
    fireEvent.click(loadMore)

    expect(connectorSourcesApi.list).toHaveBeenCalledTimes(2)
    expect(connectorSourcesApi.list).toHaveBeenLastCalledWith('primary')
    expect(loadMore).toBeDisabled()
    expect(loadMore).toHaveTextContent('Loading more...')

    cursorPage.resolve({
      ...writablePage,
      items: [
        { ...userSource, displayName: 'Primary updated', etag: 'etag-three' },
        { ...userSource, sourceId: 'primary-shadow', displayName: 'Distinct source ID' },
        { ...userSource, sourceId: 'later', displayName: 'Later source' },
      ],
      page: { limit: 50, nextCursor: null },
    })

    await screen.findByRole('article', { name: 'Later source' })
    expect(
      screen.getAllByRole('article').map((article) => article.getAttribute('aria-label')),
    ).toEqual(['Primary updated', 'Deployment Foundry', 'Distinct source ID', 'Later source'])
  })

  it('ignores a stale cursor response after a newer refresh', async () => {
    const cursorPage = deferred<ConnectorSourcePage>()
    vi.mocked(connectorSourcesApi.list)
      .mockResolvedValueOnce({
        ...writablePage,
        page: { limit: 50, nextCursor: 'primary' },
      })
      .mockImplementationOnce(() => cursorPage.promise)
      .mockResolvedValueOnce({
        ...writablePage,
        items: [{ ...userSource, displayName: 'Fresh source' }],
      })
    render(<ConnectorSourceManager />)

    fireEvent.click(await screen.findByRole('button', { name: 'Load more sources' }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }))
    await screen.findByRole('article', { name: 'Fresh source' })

    cursorPage.resolve({
      ...writablePage,
      items: [{ ...userSource, sourceId: 'stale', displayName: 'Stale page source' }],
      page: { limit: 50, nextCursor: null },
    })

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Stale page source' })).toBeNull(),
    )
  })

  it('ignores responses from an unmounted prior estate', async () => {
    const priorEstate = deferred<ConnectorSourcePage>()
    vi.mocked(connectorSourcesApi.list)
      .mockImplementationOnce(() => priorEstate.promise)
      .mockResolvedValueOnce({
        ...writablePage,
        items: [{ ...userSource, estateId: 'estate-two', displayName: 'Estate two source' }],
      })
    const view = render(<ConnectorSourceManager key="estate-one" />)

    setActiveEstateId('estate-two')
    view.rerender(<ConnectorSourceManager key="estate-two" />)
    await screen.findByRole('article', { name: 'Estate two source' })

    priorEstate.resolve({
      ...writablePage,
      items: [{ ...userSource, displayName: 'Prior estate source' }],
    })

    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Prior estate source' })).toBeNull(),
    )
  })
})
