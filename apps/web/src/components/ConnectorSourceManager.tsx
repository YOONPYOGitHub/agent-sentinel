import { Badge, Button, Spinner } from '@fluentui/react-components'
import {
  AddRegular,
  ArrowClockwiseRegular,
  DeleteRegular,
  EditRegular,
  LockClosedRegular,
  PlugConnectedRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'

import type {
  ConnectorCredentialMetadata,
  ConnectorSourceConfiguration,
  ConnectorSourceDefinition,
  ConnectorType,
} from '@agent-sentinel/domain'

import {
  ConnectorSourceApiError,
  connectorSourcesApi,
  type ConnectorSourceConnectionStatus,
  type ConnectorSourceCreateRequest,
  type ConnectorSourcePage,
  type ConnectorSourceUpdateRequest,
} from '../api/connectors-api'
import { getActiveEstateId } from '../api/auth-fetch'
import { useAuth } from '../hooks/useAuth'

const STALE_AFTER_MS = 24 * 60 * 60 * 1_000

const CONNECTOR_TYPE_LABELS: Record<ConnectorType, string> = {
  foundry: 'Azure AI Foundry',
  'entra-identity': 'Microsoft Entra identity',
  'power-platform': 'Power Platform',
  agent365: 'Microsoft Agent 365',
  'defender-cloud-apps': 'Defender for Cloud Apps',
  purview: 'Microsoft Purview',
  'azure-resource-graph': 'Azure Resource Graph',
  'teams-distribution': 'Teams distribution',
  'azure-monitor-otel': 'Azure Monitor and OpenTelemetry',
  manifest: 'Manifest',
}

const CONNECTOR_TYPES = Object.keys(CONNECTOR_TYPE_LABELS) as ConnectorType[]

type CredentialMode = ConnectorCredentialMetadata['mode']

interface SourceFormState {
  sourceId: string
  connectorType: ConnectorType
  displayName: string
  enabled: boolean
  projectEndpoint: string
  graphBaseUrl: string
  environmentId: string
  apiBaseUrl: string
  lookbackHours: string
  subscriptions: string
  managementBaseUrl: string
  workspaceId: string
  logsBaseUrl: string
  baselineWindowHours: string
  observedWindowHours: string
  requestTimeoutMs: string
  manifestId: string
  owners: boolean
  appRoleAssignments: boolean
  agentIdentityPreview: boolean
  maxPages: string
  maxItems: string
  maxRetries: string
  maxRetryAfterMs: string
  maxResponseBytes: string
  credentialMode: CredentialMode
  managedIdentityClientId: string
  clientId: string
  vaultUri: string
  secretName: string
  secretVersion: string
}

const defaultForm: SourceFormState = {
  sourceId: '',
  connectorType: 'foundry',
  displayName: '',
  enabled: true,
  projectEndpoint: '',
  graphBaseUrl: 'https://graph.microsoft.com',
  environmentId: '',
  apiBaseUrl: 'https://api.powerplatform.com',
  lookbackHours: '24',
  subscriptions: '',
  managementBaseUrl: 'https://management.azure.com',
  workspaceId: '',
  logsBaseUrl: 'https://api.loganalytics.io',
  baselineWindowHours: '168',
  observedWindowHours: '24',
  requestTimeoutMs: '15000',
  manifestId: '',
  owners: false,
  appRoleAssignments: false,
  agentIdentityPreview: false,
  maxPages: '20',
  maxItems: '5000',
  maxRetries: '2',
  maxRetryAfterMs: '30000',
  maxResponseBytes: '2000000',
  credentialMode: 'default',
  managedIdentityClientId: '',
  clientId: '',
  vaultUri: '',
  secretName: '',
  secretVersion: '',
}

function numeric(value: string): number {
  return Number(value)
}

function limits(form: SourceFormState) {
  return {
    maxPages: numeric(form.maxPages),
    maxItems: numeric(form.maxItems),
    requestTimeoutMs: numeric(form.requestTimeoutMs),
    maxRetries: numeric(form.maxRetries),
    maxRetryAfterMs: numeric(form.maxRetryAfterMs),
    maxResponseBytes: numeric(form.maxResponseBytes),
  }
}

function configuration(form: SourceFormState): ConnectorSourceConfiguration {
  switch (form.connectorType) {
    case 'foundry':
      return { type: 'foundry', projectEndpoint: form.projectEndpoint }
    case 'entra-identity':
      return {
        type: 'entra-identity',
        graphBaseUrl: form.graphBaseUrl,
        capabilities: {
          owners: form.owners,
          appRoleAssignments: form.appRoleAssignments,
          agentIdentityPreview: form.agentIdentityPreview,
        },
        limits: limits(form),
      }
    case 'power-platform':
      return {
        type: 'power-platform',
        environmentId: form.environmentId,
        apiBaseUrl: form.apiBaseUrl,
        limits: limits(form),
      }
    case 'agent365':
      return { type: 'agent365', graphBaseUrl: form.graphBaseUrl, limits: limits(form) }
    case 'defender-cloud-apps':
      return {
        type: 'defender-cloud-apps',
        apiBaseUrl: form.apiBaseUrl,
        lookbackHours: numeric(form.lookbackHours),
        limits: limits(form),
      }
    case 'purview':
      return { type: 'purview', graphBaseUrl: form.graphBaseUrl, limits: limits(form) }
    case 'azure-resource-graph':
      return {
        type: 'azure-resource-graph',
        subscriptions: form.subscriptions
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
        managementBaseUrl: form.managementBaseUrl,
        limits: limits(form),
      }
    case 'teams-distribution':
      return {
        type: 'teams-distribution',
        graphBaseUrl: form.graphBaseUrl,
        limits: limits(form),
      }
    case 'azure-monitor-otel':
      return {
        type: 'azure-monitor-otel',
        workspaceId: form.workspaceId,
        logsBaseUrl: form.logsBaseUrl,
        baselineWindowHours: numeric(form.baselineWindowHours),
        observedWindowHours: numeric(form.observedWindowHours),
        requestTimeoutMs: numeric(form.requestTimeoutMs),
      }
    case 'manifest':
      return { type: 'manifest', manifestId: form.manifestId }
  }
}

function credential(form: SourceFormState): ConnectorCredentialMetadata {
  switch (form.credentialMode) {
    case 'default':
      return { mode: 'default' }
    case 'managed-identity':
      return {
        mode: 'managed-identity',
        managedIdentityClientId: form.managedIdentityClientId,
      }
    case 'federated-app':
      return {
        mode: 'federated-app',
        clientId: form.clientId,
        managedIdentityClientId: form.managedIdentityClientId,
      }
    case 'key-vault-secret-reference':
      return {
        mode: 'key-vault-secret-reference',
        vaultUri: form.vaultUri,
        secretName: form.secretName,
        ...(form.secretVersion.trim().length > 0 ? { secretVersion: form.secretVersion } : {}),
      }
  }
}

function formForSource(source: ConnectorSourceDefinition): SourceFormState {
  const form = { ...defaultForm }
  form.sourceId = source.sourceId
  form.connectorType = source.connectorType
  form.displayName = source.displayName
  form.enabled = source.enabled
  form.credentialMode = source.credential.mode
  if ('managedIdentityClientId' in source.credential) {
    form.managedIdentityClientId = source.credential.managedIdentityClientId
  }
  if (source.credential.mode === 'federated-app') form.clientId = source.credential.clientId
  if (source.credential.mode === 'key-vault-secret-reference') {
    form.vaultUri = source.credential.vaultUri
    form.secretName = source.credential.secretName
    form.secretVersion = source.credential.secretVersion ?? ''
  }
  const value = source.configuration
  if ('graphBaseUrl' in value) form.graphBaseUrl = value.graphBaseUrl
  if ('limits' in value) {
    form.maxPages = String(value.limits.maxPages)
    form.maxItems = String(value.limits.maxItems)
    form.requestTimeoutMs = String(value.limits.requestTimeoutMs)
    form.maxRetries = String(value.limits.maxRetries)
    form.maxRetryAfterMs = String(value.limits.maxRetryAfterMs)
    form.maxResponseBytes = String(value.limits.maxResponseBytes)
  }
  switch (value.type) {
    case 'foundry':
      form.projectEndpoint = value.projectEndpoint
      break
    case 'entra-identity':
      form.owners = value.capabilities.owners
      form.appRoleAssignments = value.capabilities.appRoleAssignments
      form.agentIdentityPreview = value.capabilities.agentIdentityPreview
      break
    case 'power-platform':
      form.environmentId = value.environmentId
      form.apiBaseUrl = value.apiBaseUrl
      break
    case 'defender-cloud-apps':
      form.apiBaseUrl = value.apiBaseUrl
      form.lookbackHours = String(value.lookbackHours)
      break
    case 'azure-resource-graph':
      form.subscriptions = value.subscriptions.join('\n')
      form.managementBaseUrl = value.managementBaseUrl
      break
    case 'azure-monitor-otel':
      form.workspaceId = value.workspaceId
      form.logsBaseUrl = value.logsBaseUrl
      form.baselineWindowHours = String(value.baselineWindowHours)
      form.observedWindowHours = String(value.observedWindowHours)
      form.requestTimeoutMs = String(value.requestTimeoutMs)
      break
    case 'manifest':
      form.manifestId = value.manifestId
      break
    case 'agent365':
    case 'purview':
    case 'teams-distribution':
      break
  }
  return form
}

function mutationKey(operation: string, sourceId: string): string {
  return `connector-source-${operation}-${sourceId}-${globalThis.crypto.randomUUID()}`
}

type MutationIntent =
  | { operation: 'create'; input: ConnectorSourceCreateRequest }
  | {
      operation: 'update'
      sourceId: string
      etag: string
      patch: ConnectorSourceUpdateRequest
    }
  | { operation: 'toggle'; sourceId: string; etag: string; enabled: boolean }
  | { operation: 'delete'; sourceId: string; etag: string }

function mutationIntentSlot(intent: MutationIntent): string {
  return intent.operation === 'create' ? 'create' : `${intent.operation}:${intent.sourceId}`
}

function mutationFingerprint(intent: MutationIntent): string {
  return JSON.stringify(intent)
}

function retainMutationKey(error: unknown): boolean {
  const status =
    error instanceof ConnectorSourceApiError
      ? error.status
      : typeof error === 'object' &&
          error !== null &&
          'status' in error &&
          typeof error.status === 'number'
        ? error.status
        : undefined
  return status === undefined || status >= 500 || status === 408 || status === 429
}

function mergeSourcePages(
  current: readonly ConnectorSourceDefinition[],
  incoming: readonly ConnectorSourceDefinition[],
): ConnectorSourceDefinition[] {
  const merged = [...current]
  const indexBySourceId = new Map(current.map((source, index) => [source.sourceId, index] as const))
  for (const source of incoming) {
    const existingIndex = indexBySourceId.get(source.sourceId)
    if (existingIndex === undefined) {
      indexBySourceId.set(source.sourceId, merged.length)
      merged.push(source)
    } else {
      merged[existingIndex] = source
    }
  }
  return merged
}

function statusLabel(
  status: ConnectorSourceDefinition['testStatus']['status'] | 'unknown',
): string {
  return status
    .split('-')
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function isStale(checkedAt: string | null | undefined): boolean {
  return checkedAt !== null && checkedAt !== undefined
    ? Date.now() - Date.parse(checkedAt) > STALE_AFTER_MS
    : false
}

function evidenceBasisLabel(basis: 'provider-response' | 'synthetic' | null | undefined): string {
  if (basis === 'provider-response') return 'Provider response evidence'
  if (basis === 'synthetic') return 'Synthetic evidence - not live provider evidence'
  return 'Unknown / no evidence'
}

function mutationError(error: unknown): string {
  if (
    (error instanceof ConnectorSourceApiError && error.code === 'etag_mismatch') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'etag_mismatch')
  ) {
    return 'This connector source changed in another session. Refresh and try again.'
  }
  return error instanceof Error ? error.message : 'The connector source operation failed.'
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  label: string
  value: string
  min: number
  max: number
  onChange: (value: string) => void
}) {
  return (
    <label className="connector-source-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        required
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  )
}

function LimitsFields({
  form,
  setField,
}: {
  form: SourceFormState
  setField: <K extends keyof SourceFormState>(field: K, value: SourceFormState[K]) => void
}) {
  return (
    <fieldset className="connector-source-fieldset">
      <legend>Request limits</legend>
      <div className="connector-source-form-grid">
        <NumberField
          id="source-max-pages"
          label="Maximum pages"
          value={form.maxPages}
          min={1}
          max={100}
          onChange={(value) => setField('maxPages', value)}
        />
        <NumberField
          id="source-max-items"
          label="Maximum items"
          value={form.maxItems}
          min={1}
          max={50000}
          onChange={(value) => setField('maxItems', value)}
        />
        <NumberField
          id="source-timeout"
          label="Request timeout (ms)"
          value={form.requestTimeoutMs}
          min={100}
          max={120000}
          onChange={(value) => setField('requestTimeoutMs', value)}
        />
        <NumberField
          id="source-retries"
          label="Maximum retries"
          value={form.maxRetries}
          min={0}
          max={5}
          onChange={(value) => setField('maxRetries', value)}
        />
        <NumberField
          id="source-retry-after"
          label="Maximum retry-after (ms)"
          value={form.maxRetryAfterMs}
          min={0}
          max={120000}
          onChange={(value) => setField('maxRetryAfterMs', value)}
        />
        <NumberField
          id="source-response-bytes"
          label="Maximum response bytes"
          value={form.maxResponseBytes}
          min={1024}
          max={10000000}
          onChange={(value) => setField('maxResponseBytes', value)}
        />
      </div>
    </fieldset>
  )
}

function SourceForm({
  source,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  source?: ConnectorSourceDefinition
  busy: boolean
  error?: string
  onCancel: () => void
  onSubmit: (form: SourceFormState) => Promise<void>
}) {
  const [form, setForm] = useState<SourceFormState>(() =>
    source === undefined ? { ...defaultForm } : formForSource(source),
  )
  const formRef = useRef<HTMLFormElement>(null)
  const id = useId()
  const titleId = `${id}-title`
  const descriptionId = `${id}-description`
  const errorId = `${id}-error`
  const setField = <K extends keyof SourceFormState>(field: K, value: SourceFormState[K]): void =>
    setForm((current) => ({ ...current, [field]: value }))
  const type = form.connectorType
  const hasLimits = !['foundry', 'azure-monitor-otel', 'manifest'].includes(type)

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void onSubmit(form)
  }

  return (
    <div
      className="connector-source-dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={error === undefined ? descriptionId : `${descriptionId} ${errorId}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          onCancel()
          return
        }
        if (event.key === 'Tab') {
          const focusable = Array.from(
            formRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          )
          const first = focusable[0]
          const last = focusable.at(-1)
          if (first === undefined || last === undefined) return
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
      }}
    >
      <form ref={formRef} className="connector-source-dialog" onSubmit={submit}>
        <div>
          <h3 id={titleId}>
            {source === undefined ? 'Add connector source' : `Edit ${source.displayName}`}
          </h3>
          <p id={descriptionId}>
            Store only non-secret configuration. Use managed identity, federation metadata, or a Key
            Vault reference; never enter credential values.
          </p>
        </div>

        {error === undefined ? null : (
          <div
            id={errorId}
            className="connector-source-dialog__error"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </div>
        )}

        <div className="connector-source-form-grid">
          <label className="connector-source-field" htmlFor="source-id">
            <span>Source ID</span>
            <input
              id="source-id"
              required
              pattern="[a-z0-9][a-z0-9-]{0,62}"
              value={form.sourceId}
              disabled={source !== undefined}
              autoFocus={source === undefined}
              onChange={(event) => setField('sourceId', event.currentTarget.value)}
            />
          </label>
          <label className="connector-source-field" htmlFor="source-display-name">
            <span>Display name</span>
            <input
              id="source-display-name"
              required
              maxLength={100}
              value={form.displayName}
              autoFocus={source !== undefined}
              onChange={(event) => setField('displayName', event.currentTarget.value)}
            />
          </label>
          <label className="connector-source-field" htmlFor="source-type">
            <span>Connector type</span>
            <select
              id="source-type"
              value={type}
              disabled={source !== undefined}
              onChange={(event) =>
                setField('connectorType', event.currentTarget.value as ConnectorType)
              }
            >
              {CONNECTOR_TYPES.map((value) => (
                <option key={value} value={value}>
                  {CONNECTOR_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="connector-source-checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setField('enabled', event.currentTarget.checked)}
            />
            Enabled
          </label>
        </div>

        <fieldset className="connector-source-fieldset">
          <legend>Connector configuration</legend>
          <div className="connector-source-form-grid">
            {type === 'foundry' ? (
              <label className="connector-source-field connector-source-field--wide">
                <span>Project endpoint</span>
                <input
                  type="url"
                  required
                  value={form.projectEndpoint}
                  onChange={(event) => setField('projectEndpoint', event.currentTarget.value)}
                />
              </label>
            ) : null}
            {['entra-identity', 'agent365', 'purview', 'teams-distribution'].includes(type) ? (
              <label className="connector-source-field connector-source-field--wide">
                <span>Microsoft Graph base URL</span>
                <input
                  type="url"
                  required
                  value={form.graphBaseUrl}
                  onChange={(event) => setField('graphBaseUrl', event.currentTarget.value)}
                />
              </label>
            ) : null}
            {type === 'power-platform' ? (
              <>
                <label className="connector-source-field">
                  <span>Power Platform environment ID</span>
                  <input
                    required
                    value={form.environmentId}
                    onChange={(event) => setField('environmentId', event.currentTarget.value)}
                  />
                </label>
                <label className="connector-source-field">
                  <span>Power Platform API base URL</span>
                  <input
                    type="url"
                    required
                    value={form.apiBaseUrl}
                    onChange={(event) => setField('apiBaseUrl', event.currentTarget.value)}
                  />
                </label>
              </>
            ) : null}
            {type === 'defender-cloud-apps' ? (
              <>
                <label className="connector-source-field">
                  <span>Tenant portal URL</span>
                  <input
                    type="url"
                    required
                    value={form.apiBaseUrl}
                    onChange={(event) => setField('apiBaseUrl', event.currentTarget.value)}
                  />
                </label>
                <NumberField
                  id="source-lookback-hours"
                  label="Lookback hours"
                  value={form.lookbackHours}
                  min={1}
                  max={168}
                  onChange={(value) => setField('lookbackHours', value)}
                />
              </>
            ) : null}
            {type === 'entra-identity' ? (
              <div className="connector-source-checkbox-group connector-source-field--wide">
                <label className="connector-source-checkbox">
                  <input
                    type="checkbox"
                    checked={form.owners}
                    onChange={(event) => setField('owners', event.currentTarget.checked)}
                  />
                  Owner enrichment
                </label>
                <label className="connector-source-checkbox">
                  <input
                    type="checkbox"
                    checked={form.appRoleAssignments}
                    onChange={(event) =>
                      setField('appRoleAssignments', event.currentTarget.checked)
                    }
                  />
                  App role assignments
                </label>
                <label className="connector-source-checkbox">
                  <input
                    type="checkbox"
                    checked={form.agentIdentityPreview}
                    onChange={(event) =>
                      setField('agentIdentityPreview', event.currentTarget.checked)
                    }
                  />
                  Agent Identity preview
                </label>
              </div>
            ) : null}
            {type === 'azure-resource-graph' ? (
              <>
                <label className="connector-source-field connector-source-field--wide">
                  <span>Subscription IDs (comma or line separated)</span>
                  <textarea
                    required
                    value={form.subscriptions}
                    onChange={(event) => setField('subscriptions', event.currentTarget.value)}
                  />
                </label>
                <label className="connector-source-field connector-source-field--wide">
                  <span>Azure Resource Manager base URL</span>
                  <input
                    type="url"
                    required
                    value={form.managementBaseUrl}
                    onChange={(event) => setField('managementBaseUrl', event.currentTarget.value)}
                  />
                </label>
              </>
            ) : null}
            {type === 'azure-monitor-otel' ? (
              <>
                <label className="connector-source-field">
                  <span>Workspace ID</span>
                  <input
                    required
                    value={form.workspaceId}
                    onChange={(event) => setField('workspaceId', event.currentTarget.value)}
                  />
                </label>
                <label className="connector-source-field">
                  <span>Logs API base URL</span>
                  <input
                    type="url"
                    required
                    value={form.logsBaseUrl}
                    onChange={(event) => setField('logsBaseUrl', event.currentTarget.value)}
                  />
                </label>
                <NumberField
                  id="source-baseline-window"
                  label="Baseline window (hours)"
                  value={form.baselineWindowHours}
                  min={1}
                  max={744}
                  onChange={(value) => setField('baselineWindowHours', value)}
                />
                <NumberField
                  id="source-observed-window"
                  label="Observed window (hours)"
                  value={form.observedWindowHours}
                  min={1}
                  max={168}
                  onChange={(value) => setField('observedWindowHours', value)}
                />
                <NumberField
                  id="source-otel-timeout"
                  label="Request timeout (ms)"
                  value={form.requestTimeoutMs}
                  min={1000}
                  max={60000}
                  onChange={(value) => setField('requestTimeoutMs', value)}
                />
              </>
            ) : null}
            {type === 'manifest' ? (
              <label className="connector-source-field connector-source-field--wide">
                <span>Manifest ID</span>
                <input
                  required
                  value={form.manifestId}
                  onChange={(event) => setField('manifestId', event.currentTarget.value)}
                />
              </label>
            ) : null}
          </div>
        </fieldset>

        {hasLimits ? <LimitsFields form={form} setField={setField} /> : null}

        <fieldset className="connector-source-fieldset">
          <legend>Credential metadata</legend>
          <label className="connector-source-field" htmlFor="source-credential-mode">
            <span>Credential mode</span>
            <select
              id="source-credential-mode"
              value={form.credentialMode}
              onChange={(event) =>
                setField('credentialMode', event.currentTarget.value as CredentialMode)
              }
            >
              <option value="default">Default workload identity</option>
              <option value="managed-identity">Managed identity</option>
              <option value="federated-app">Federated application</option>
              <option value="key-vault-secret-reference">Key Vault reference</option>
            </select>
          </label>
          {form.credentialMode === 'managed-identity' || form.credentialMode === 'federated-app' ? (
            <label className="connector-source-field">
              <span>Managed identity client ID</span>
              <input
                required
                value={form.managedIdentityClientId}
                onChange={(event) => setField('managedIdentityClientId', event.currentTarget.value)}
              />
            </label>
          ) : null}
          {form.credentialMode === 'federated-app' ? (
            <label className="connector-source-field">
              <span>Application client ID</span>
              <input
                required
                value={form.clientId}
                onChange={(event) => setField('clientId', event.currentTarget.value)}
              />
            </label>
          ) : null}
          {form.credentialMode === 'key-vault-secret-reference' ? (
            <div className="connector-source-form-grid">
              <label className="connector-source-field">
                <span>Key Vault URI</span>
                <input
                  type="url"
                  required
                  value={form.vaultUri}
                  onChange={(event) => setField('vaultUri', event.currentTarget.value)}
                />
              </label>
              <label className="connector-source-field">
                <span>Key Vault reference name</span>
                <input
                  required
                  value={form.secretName}
                  onChange={(event) => setField('secretName', event.currentTarget.value)}
                />
              </label>
              <label className="connector-source-field">
                <span>Key Vault reference version (optional)</span>
                <input
                  value={form.secretVersion}
                  onChange={(event) => setField('secretVersion', event.currentTarget.value)}
                />
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="connector-source-dialog__actions">
          <Button appearance="secondary" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button appearance="primary" type="submit" disabled={busy}>
            {busy ? 'Saving...' : source === undefined ? 'Create source' : 'Save changes'}
          </Button>
        </div>
      </form>
    </div>
  )
}

function ConnectorSourceCard({
  source,
  canConfigure,
  busy,
  onEdit,
  onToggle,
  onDelete,
  onCancelDelete,
}: {
  source: ConnectorSourceDefinition
  canConfigure: boolean
  busy: boolean
  onEdit: () => void
  onToggle: () => Promise<void>
  onDelete: () => Promise<void>
  onCancelDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [testStatus, setTestStatus] = useState<ConnectorSourceConnectionStatus>()
  const [testError, setTestError] = useState<string>()
  const [testing, setTesting] = useState(false)
  const deploymentManaged = source.origin === 'deployment'
  const sourceStatus = source.testStatus.status
  const sourceEvidenceBasis =
    source.testStatus.status === 'not-tested' ? null : source.testStatus.evidenceBasis
  const stale = source.testStatus.status !== 'not-tested' && isStale(source.testStatus.checkedAt)

  const checkTestEvidence = async (): Promise<void> => {
    setTesting(true)
    setTestError(undefined)
    try {
      setTestStatus(await connectorSourcesApi.getConnectionTestStatus(source.sourceId))
    } catch (error: unknown) {
      setTestError(error instanceof Error ? error.message : 'Connection test evidence unavailable.')
    } finally {
      setTesting(false)
    }
  }

  return (
    <article className="connector-source-card" aria-label={source.displayName}>
      <div className="connector-source-card__header">
        <div>
          <h3>{source.displayName}</h3>
          <code>{source.sourceId}</code>
        </div>
        <div className="connector-source-card__badges">
          <Badge appearance="tint" color={source.enabled ? 'success' : 'subtle'}>
            {source.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <Badge appearance="outline">
            {deploymentManaged ? 'Deployment managed' : 'User managed'}
          </Badge>
          {stale ? (
            <Badge appearance="tint" color="warning">
              Stale
            </Badge>
          ) : null}
        </div>
      </div>
      <dl className="connector-source-card__details">
        <div>
          <dt>Type</dt>
          <dd>{CONNECTOR_TYPE_LABELS[source.connectorType]}</dd>
        </div>
        <div>
          <dt>Estate</dt>
          <dd>{source.estateId}</dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>{source.credential.mode}</dd>
        </div>
        <div>
          <dt>Connection evidence</dt>
          <dd>{statusLabel(sourceStatus === 'not-tested' ? 'unknown' : sourceStatus)}</dd>
        </div>
        <div className="connector-source-card__evidence-basis">
          <dt>Evidence basis</dt>
          <dd>{evidenceBasisLabel(sourceEvidenceBasis)}</dd>
        </div>
      </dl>
      <div className="connector-source-card__actions">
        <Button
          appearance="secondary"
          icon={<PlugConnectedRegular />}
          disabled={testing}
          onClick={() => void checkTestEvidence()}
        >
          {testing ? 'Checking...' : 'Check test evidence'}
        </Button>
        {!deploymentManaged && canConfigure ? (
          <>
            <Button
              appearance="secondary"
              icon={<EditRegular />}
              data-connector-focus={`edit:${source.sourceId}`}
              onClick={onEdit}
              disabled={busy}
            >
              Edit
            </Button>
            <Button appearance="secondary" onClick={() => void onToggle()} disabled={busy}>
              {source.enabled ? 'Disable' : 'Enable'}
            </Button>
            {!confirmDelete ? (
              <Button
                appearance="secondary"
                icon={<DeleteRegular />}
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              >
                Delete
              </Button>
            ) : (
              <>
                <Button appearance="primary" onClick={() => void onDelete()} disabled={busy}>
                  Confirm delete
                </Button>
                <Button
                  appearance="secondary"
                  onClick={() => {
                    onCancelDelete()
                    setConfirmDelete(false)
                  }}
                  disabled={busy}
                >
                  Cancel delete
                </Button>
              </>
            )}
          </>
        ) : null}
      </div>
      {deploymentManaged ? (
        <p className="connector-source-card__notice">
          <LockClosedRegular aria-hidden="true" />
          Deployment-defined sources are visible for compatibility and cannot be edited or deleted
          here.
        </p>
      ) : null}
      {testStatus !== undefined ? (
        <div className="connector-source-test-result" role="status">
          <strong>{statusLabel(testStatus.status)}</strong>
          <strong className="connector-source-test-result__basis">
            {evidenceBasisLabel(testStatus.evidenceBasis)}
          </strong>
          <span>{testStatus.summary}</span>
          {isStale(testStatus.checkedAt) ? <span>Evidence is stale.</span> : null}
        </div>
      ) : null}
      {testError !== undefined ? (
        <div
          className="connector-source-test-result connector-source-test-result--error"
          role="alert"
        >
          {testError}
        </div>
      ) : null}
    </article>
  )
}

export function ConnectorSourceManager() {
  const { isConfigured, principal } = useAuth()
  const [page, setPage] = useState<ConnectorSourcePage>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string>()
  const [operationError, setOperationError] = useState<string>()
  const [editing, setEditing] = useState<ConnectorSourceDefinition | 'new'>()
  const [busySourceId, setBusySourceId] = useState<string>()
  const pageRef = useRef<ConnectorSourcePage | undefined>(undefined)
  const mounted = useRef(false)
  const requestGeneration = useRef(0)
  const inFlightCursors = useRef(new Map<string, number>())
  const mutationKeys = useRef(new Map<string, { fingerprint: string; key: string }>())
  const editorTrigger = useRef<{ element: HTMLElement; focusId?: string } | null>(null)

  useEffect(() => {
    pageRef.current = page
  }, [page])

  useEffect(() => {
    if (
      editing !== undefined ||
      busySourceId !== undefined ||
      loading ||
      refreshing ||
      loadingMore ||
      editorTrigger.current === null
    ) {
      return
    }
    const target = editorTrigger.current
    const replacement =
      target.focusId === undefined
        ? undefined
        : Array.from(document.querySelectorAll<HTMLElement>('[data-connector-focus]')).find(
            (element) => element.dataset.connectorFocus === target.focusId,
          )
    const element = target.element.isConnected ? target.element : replacement
    if (element === undefined || element.matches(':disabled')) return
    element.focus()
    editorTrigger.current = null
  }, [busySourceId, editing, loading, loadingMore, page, refreshing])

  const load = useCallback(async (cursor?: string) => {
    const estateId = getActiveEstateId()
    const cursorRequestKey = cursor === undefined ? undefined : `${estateId ?? ''}:${cursor}`
    if (cursorRequestKey !== undefined && inFlightCursors.current.has(cursorRequestKey)) {
      return
    }

    const generation =
      cursorRequestKey === undefined ? requestGeneration.current + 1 : requestGeneration.current
    if (cursorRequestKey === undefined) {
      requestGeneration.current = generation
      inFlightCursors.current.clear()
      setLoadingMore(false)
      if (pageRef.current === undefined) {
        setLoading(true)
      } else {
        setRefreshing(true)
      }
    } else {
      inFlightCursors.current.set(cursorRequestKey, generation)
      setLoadingMore(true)
    }
    setError(undefined)

    const requestIsCurrent = (): boolean =>
      mounted.current &&
      requestGeneration.current === generation &&
      getActiveEstateId() === estateId

    try {
      const next = await connectorSourcesApi.list(cursor)
      if (!requestIsCurrent()) return
      setPage((current) => {
        const updated =
          cursor === undefined || current === undefined
            ? next
            : { ...next, items: mergeSourcePages(current.items, next.items) }
        pageRef.current = updated
        return updated
      })
    } catch (caught: unknown) {
      if (!requestIsCurrent()) return
      setError(caught instanceof Error ? caught.message : 'Connector sources could not be loaded.')
    } finally {
      if (
        cursorRequestKey !== undefined &&
        inFlightCursors.current.get(cursorRequestKey) === generation
      ) {
        inFlightCursors.current.delete(cursorRequestKey)
      }
      if (requestIsCurrent()) {
        setLoading(false)
        setRefreshing(false)
        if (cursor !== undefined) setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    const cursors = inFlightCursors.current
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
      requestGeneration.current += 1
      cursors.clear()
    }
  }, [load])

  const hasConfigureCapability =
    principal?.capabilities.includes(page?.mutationPolicy.requiredCapability ?? 'configure') ??
    false
  const canConfigure =
    page?.mutationPolicy.enabled === true && isConfigured && hasConfigureCapability
  const disabledReason = useMemo(() => {
    if (page === undefined) return undefined
    if (!page.mutationPolicy.enabled) return 'The deployment write gate is disabled.'
    if (!isConfigured || principal === null)
      return 'Sign in with an authenticated Administrator account to configure connector sources.'
    if (!hasConfigureCapability)
      return 'The Administrator configure capability is required to change connector sources.'
    return undefined
  }, [hasConfigureCapability, isConfigured, page, principal])

  const openEditor = (value: ConnectorSourceDefinition | 'new'): void => {
    const activeElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    editorTrigger.current =
      activeElement === undefined
        ? null
        : {
            element: activeElement,
            ...(activeElement.dataset.connectorFocus === undefined
              ? {}
              : { focusId: activeElement.dataset.connectorFocus }),
          }
    setOperationError(undefined)
    setEditing(value)
  }

  const keyForIntent = (intent: MutationIntent): string => {
    const slot = mutationIntentSlot(intent)
    const fingerprint = mutationFingerprint(intent)
    const pending = mutationKeys.current.get(slot)
    if (pending?.fingerprint === fingerprint) return pending.key
    const sourceId =
      intent.operation === 'create' ? intent.input.sourceId || 'new-source' : intent.sourceId
    const key = mutationKey(intent.operation, sourceId)
    mutationKeys.current.set(slot, { fingerprint, key })
    return key
  }

  const clearIntent = (intent: MutationIntent): void => {
    mutationKeys.current.delete(mutationIntentSlot(intent))
  }

  const clearMutationSlot = (operation: MutationIntent['operation'], sourceId?: string): void => {
    mutationKeys.current.delete(
      operation === 'create' ? 'create' : `${operation}:${sourceId ?? ''}`,
    )
  }

  const save = async (form: SourceFormState): Promise<void> => {
    setOperationError(undefined)
    setBusySourceId(form.sourceId)
    try {
      const input: ConnectorSourceCreateRequest = {
        sourceId: form.sourceId,
        connectorType: form.connectorType,
        displayName: form.displayName,
        enabled: form.enabled,
        configuration: configuration(form),
        credential: credential(form),
      }
      if (editing === 'new') {
        const intent = { operation: 'create', input } as const
        const key = keyForIntent(intent)
        try {
          await connectorSourcesApi.create(input, key)
          clearIntent(intent)
        } catch (caught: unknown) {
          if (!retainMutationKey(caught)) clearIntent(intent)
          throw caught
        }
      } else if (editing !== undefined) {
        const patch: ConnectorSourceUpdateRequest = {
          displayName: input.displayName,
          enabled: input.enabled,
          configuration: input.configuration,
          credential: input.credential,
        }
        const intent = {
          operation: 'update',
          sourceId: editing.sourceId,
          etag: editing.etag,
          patch,
        } as const
        const key = keyForIntent(intent)
        try {
          await connectorSourcesApi.update(editing.sourceId, patch, editing.etag, key)
          clearIntent(intent)
        } catch (caught: unknown) {
          if (!retainMutationKey(caught)) clearIntent(intent)
          throw caught
        }
      }
      setEditing(undefined)
      await load()
    } catch (caught: unknown) {
      setOperationError(mutationError(caught))
    } finally {
      setBusySourceId(undefined)
    }
  }

  const updateEnabled = async (source: ConnectorSourceDefinition): Promise<void> => {
    setOperationError(undefined)
    setBusySourceId(source.sourceId)
    const intent = {
      operation: 'toggle',
      sourceId: source.sourceId,
      etag: source.etag,
      enabled: !source.enabled,
    } as const
    try {
      await connectorSourcesApi.update(
        source.sourceId,
        { enabled: intent.enabled },
        source.etag,
        keyForIntent(intent),
      )
      clearIntent(intent)
      await load()
    } catch (caught: unknown) {
      if (!retainMutationKey(caught)) clearIntent(intent)
      setOperationError(mutationError(caught))
    } finally {
      setBusySourceId(undefined)
    }
  }

  const remove = async (source: ConnectorSourceDefinition): Promise<void> => {
    setOperationError(undefined)
    setBusySourceId(source.sourceId)
    const intent = {
      operation: 'delete',
      sourceId: source.sourceId,
      etag: source.etag,
    } as const
    try {
      await connectorSourcesApi.delete(source.sourceId, source.etag, keyForIntent(intent))
      clearIntent(intent)
      await load()
    } catch (caught: unknown) {
      if (!retainMutationKey(caught)) clearIntent(intent)
      setOperationError(mutationError(caught))
    } finally {
      setBusySourceId(undefined)
    }
  }

  return (
    <section className="connectors-section" aria-labelledby="connector-sources-heading">
      <div className="connector-source-section-header">
        <div>
          <h2 id="connector-sources-heading" className="connectors-section__heading">
            Connector source configuration
          </h2>
          <p>
            Estate-scoped, non-secret source definitions. Runtime activation remains controlled by
            deployment configuration.
          </p>
        </div>
        <div className="connector-source-section-header__actions">
          <Button
            appearance="secondary"
            icon={<ArrowClockwiseRegular />}
            disabled={loading || refreshing}
            onClick={() => void load()}
          >
            Refresh sources
          </Button>
          <Button
            appearance="primary"
            icon={<AddRegular />}
            disabled={!canConfigure}
            data-connector-focus="add"
            onClick={() => openEditor('new')}
          >
            Add connector source
          </Button>
        </div>
      </div>

      {disabledReason !== undefined ? (
        <p className="connector-source-policy-notice">
          <LockClosedRegular aria-hidden="true" />
          {disabledReason}
        </p>
      ) : null}
      {operationError !== undefined && editing === undefined ? (
        <div className="connector-source-operation-error" role="alert">
          {operationError}
        </div>
      ) : null}
      {error !== undefined && page !== undefined ? (
        <div className="connector-source-operation-error" role="alert">
          Refresh failed. Existing connector source data may be stale. {error}
        </div>
      ) : null}

      {loading && page === undefined ? (
        <div className="connector-source-list-state" role="status">
          <Spinner size="medium" />
          Loading connector sources...
        </div>
      ) : error !== undefined && page === undefined ? (
        <div
          className="connector-source-list-state connector-source-list-state--error"
          role="alert"
        >
          <strong>Connector sources unavailable</strong>
          <span>{error}</span>
          <Button appearance="primary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : page !== undefined && page.items.length === 0 ? (
        <div className="connector-source-list-state">
          No connector sources are configured for this estate.
        </div>
      ) : page !== undefined ? (
        <>
          {refreshing ? (
            <div className="connector-source-refreshing" role="status">
              Refreshing connector sources...
            </div>
          ) : null}
          <div className="connector-source-grid">
            {page.items.map((source) => (
              <ConnectorSourceCard
                key={source.sourceId}
                source={source}
                canConfigure={canConfigure}
                busy={busySourceId === source.sourceId}
                onEdit={() => openEditor(source)}
                onToggle={() => updateEnabled(source)}
                onDelete={() => remove(source)}
                onCancelDelete={() => clearMutationSlot('delete', source.sourceId)}
              />
            ))}
          </div>
          {page.page.nextCursor !== null ? (
            <Button
              appearance="secondary"
              disabled={refreshing || loadingMore}
              onClick={() => void load(page.page.nextCursor ?? undefined)}
            >
              {loadingMore ? 'Loading more...' : 'Load more sources'}
            </Button>
          ) : null}
        </>
      ) : null}

      {editing !== undefined ? (
        <SourceForm
          {...(editing === 'new' ? {} : { source: editing })}
          busy={busySourceId !== undefined}
          {...(operationError === undefined ? {} : { error: operationError })}
          onCancel={() => {
            if (editing === 'new') {
              clearMutationSlot('create')
            } else {
              clearMutationSlot('update', editing.sourceId)
            }
            setEditing(undefined)
            setOperationError(undefined)
          }}
          onSubmit={save}
        />
      ) : null}
    </section>
  )
}
