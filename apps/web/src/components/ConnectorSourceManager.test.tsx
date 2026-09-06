/* eslint-disable @typescript-eslint/unbound-method */
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectorSourceDefinition } from '@agent-sentinel/domain'

import {
  connectorSourcesApi,
  type ConnectorSourcePage,
  type ConnectorSourceConnectionStatus,
} from '../api/connectors-api'
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

const writablePage: ConnectorSourcePage = {
  items: [userSource, deploymentSource],
  page: { limit: 50, nextCursor: null },
  mutationPolicy: {
    enabled: true,
    requiresAuthentication: true,
    requiredCapability: 'configure',
  },
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
    mockAdministrator()
    vi.mocked(connectorSourcesApi.list).mockResolvedValue(writablePage)
  })

  afterEach(cleanup)

  it('shows exact IDs, deployment immutability, disabled state, and stale evidence', async () => {
    render(<ConnectorSourceManager />)

    const userCard = await screen.findByRole('article', { name: 'Primary Foundry' })
    expect(userCard).toHaveTextContent('primary')
    expect(userCard).toHaveTextContent('Disabled')
    expect(userCard).toHaveTextContent('Stale')

    const deploymentCard = screen.getByRole('article', { name: 'Deployment Foundry' })
    expect(deploymentCard).toHaveTextContent('deployment-primary')
    expect(deploymentCard).toHaveTextContent('Deployment managed')
    expect(within(deploymentCard).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(within(deploymentCard).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
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
    expect(await screen.findByRole('alert')).toHaveTextContent(/refresh and try again/i)
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
  })
})
