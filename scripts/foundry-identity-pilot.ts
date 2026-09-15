import { pathToFileURL } from 'node:url'

import {
  foundryAgentSchema,
  FOUNDRY_API_VERSION,
  type FoundryAgent,
} from '@agent-sentinel/foundry-connector'
import { foundryManifest } from '@agent-sentinel/scenarios'
import { DefaultAzureCredential } from '@azure/identity'

import {
  AGENT_SENTINEL_MANAGED_MARKER,
  FoundryHttpClient,
  requiredEnvironment,
} from './foundry-http.js'

export const FOUNDRY_IDENTITY_PILOT_NAME = 'agent-sentinel-identity-pilot-readonly-v1'
export const FOUNDRY_IDENTITY_PILOT_VERSION = '1'
export const FOUNDRY_IDENTITY_PILOT_MARKER = '[pilot:foundry-instance-identity-v1]'
export const FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION = `CREATE:${FOUNDRY_IDENTITY_PILOT_NAME}`

const SOURCE_AGENT_NAME = 'customer-support-safe'
const IDENTITY_POLL_ATTEMPTS = 12
const IDENTITY_POLL_DELAY_MS = 5_000
const legacyNames = new Set(foundryManifest.agents.map((agent) => agent.name))
const sourceAgent = (() => {
  const candidate = foundryManifest.agents.find((agent) => agent.name === SOURCE_AGENT_NAME)
  if (candidate === undefined) {
    throw new Error(`Missing required semantic source agent: ${SOURCE_AGENT_NAME}.`)
  }
  return candidate
})()

type PilotClient = Pick<
  FoundryHttpClient,
  'createAgent' | 'deleteAgent' | 'getAgent' | 'listAgents'
>

type Sleep = (milliseconds: number) => Promise<void>

interface LegacyFingerprint {
  readonly id: string
  readonly name: string
  readonly version?: string
  readonly description?: string | null
  readonly metadata?: Record<string, string>
  readonly instance_identity?: FoundryAgent['instance_identity']
  readonly blueprint?: FoundryAgent['blueprint']
  readonly blueprint_reference?: FoundryAgent['blueprint_reference']
}

export interface FoundryIdentityPilotEvidence {
  readonly action: 'created' | 'deleted'
  readonly agent: {
    readonly id: string
    readonly name: typeof FOUNDRY_IDENTITY_PILOT_NAME
    readonly version?: string
    readonly principalId: string
    readonly clientId: string
    readonly blueprintPrincipalId: string
    readonly blueprintClientId: string
    readonly blueprintId: string
  }
  readonly legacyAgents: readonly LegacyFingerprint[]
}

export function pilotCleanupConfirmation(agentId: string): string {
  return `DELETE:${FOUNDRY_IDENTITY_PILOT_NAME}:${agentId}`
}

export function buildFoundryIdentityPilotPayload(): Readonly<Record<string, unknown>> {
  return {
    description: [
      'Synthetic identity-aware read-only customer support validation agent.',
      AGENT_SENTINEL_MANAGED_MARKER,
      FOUNDRY_IDENTITY_PILOT_MARKER,
      `[source:${SOURCE_AGENT_NAME}]`,
      `[version:${FOUNDRY_IDENTITY_PILOT_VERSION}]`,
    ].join(' '),
    definition: {
      kind: 'prompt',
      model: sourceAgent.modelDeployment,
      instructions: sourceAgent.instructions,
      tools: sourceAgent.functions.map((fn) => ({
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
      })),
    },
    metadata: {
      managedBy: 'agent-sentinel',
      pilot: 'foundry-instance-identity',
      pilotVersion: FOUNDRY_IDENTITY_PILOT_VERSION,
      semanticSource: SOURCE_AGENT_NAME,
      syntheticOnly: 'true',
      expectedRisk: 'low',
      expectedTrust: 'trusted',
      approvalRequired: 'false',
      externalTransfer: 'false',
      writeAccess: 'false',
    },
  }
}

export function buildFoundryIdentityPilotPlan() {
  return {
    schemaVersion: '1.0.0',
    kind: 'agent-sentinel-foundry-identity-pilot-plan',
    mode: 'plan-only',
    api: {
      service: 'Microsoft Foundry Agent Service',
      version: FOUNDRY_API_VERSION,
      create: {
        method: 'POST',
        path: `/agents/${FOUNDRY_IDENTITY_PILOT_NAME}/versions?api-version=${FOUNDRY_API_VERSION}`,
        body: buildFoundryIdentityPilotPayload(),
      },
      identityPolicy:
        'Omit blueprint_reference so the stable v1 service creates a new agent-specific identity and blueprint. Never supply provider IDs or the project managed identity.',
    },
    source: {
      name: SOURCE_AGENT_NAME,
      rationale:
        'Lowest-complexity existing agent: one synthetic read-only knowledge-search function, no write operation, no external transfer, and no sensitive-domain lookup.',
    },
    expectedResources: [
      'one new Foundry agent',
      'one initial immutable agent version',
      'one service-managed agent endpoint',
      'one service-managed Microsoft Entra agent identity',
      'one service-managed Microsoft Entra agent identity blueprint',
    ],
    expectedIdentityFields: [
      'instance_identity.principal_id',
      'instance_identity.client_id',
      'blueprint.principal_id',
      'blueprint.client_id',
      'blueprint_reference.type=ManagedAgentIdentityBlueprint',
      'blueprint_reference.blueprint_id',
    ],
    permissions: {
      foundryOperator: 'Foundry User at project scope',
      projectManagedIdentity:
        'Foundry User only when required by the Foundry service; never use as RUNS_AS',
      graphStableInventory: 'Application.Read.All',
      graphAgentIdentitySubtype: 'AgentIdentity.Read.All',
      pilotDownstreamRoles: [],
    },
    graphVerification: {
      servicePrincipal:
        'GET https://graph.microsoft.com/v1.0/servicePrincipals/{instance_identity.principal_id}',
      agentIdentitySubtype:
        'GET https://graph.microsoft.com/v1.0/servicePrincipals/{instance_identity.principal_id}/microsoft.graph.agentIdentity',
      expectedOdataType: '#microsoft.graph.agentIdentity',
      expectedServicePrincipalType: 'ServiceIdentity',
    },
    ingestion: {
      startupDiscovery: true,
      defaultIntervalMs: 300_000,
      expectedAgentCount: 7,
      expectedRunsAsEdges: 1,
    },
    rollback: {
      command:
        `pnpm foundry:identity-pilot -- cleanup --apply --agent-id <immutable-agent-id> ` +
        `--confirm "DELETE:${FOUNDRY_IDENTITY_PILOT_NAME}:<immutable-agent-id>"`,
      scope:
        'Delete only the exact pilot agent. Foundry remains responsible for its service-created identity and blueprint lifecycle.',
    },
    invariants: [
      'The six legacy manifest agents must be the complete pre-create estate and must retain null instance_identity.',
      'The pilot name, marker, and version are fixed and unique.',
      'The create operation targets only the pilot name and never updates an existing agent.',
      'No downstream role is assigned to the pilot identity for this basic synthetic function-tool pilot.',
      'Cleanup requires the pilot immutable ID plus an exact confirmation string and cannot target a legacy name.',
    ],
    confirmations: {
      create: FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION,
      cleanup: `DELETE:${FOUNDRY_IDENTITY_PILOT_NAME}:<immutable-agent-id>`,
    },
  } as const
}

function fingerprint(agentInput: FoundryAgent): LegacyFingerprint {
  const agent = foundryAgentSchema.parse(agentInput)
  return {
    id: agent.id,
    name: agent.name!,
    ...(agent.version === undefined ? {} : { version: agent.version }),
    ...(agent.description === undefined ? {} : { description: agent.description }),
    ...(agent.metadata === undefined ? {} : { metadata: structuredClone(agent.metadata) }),
    ...(agent.instance_identity === undefined
      ? {}
      : { instance_identity: structuredClone(agent.instance_identity) }),
    ...(agent.blueprint === undefined ? {} : { blueprint: structuredClone(agent.blueprint) }),
    ...(agent.blueprint_reference === undefined
      ? {}
      : { blueprint_reference: structuredClone(agent.blueprint_reference) }),
  }
}

function captureLegacyAgents(agents: readonly FoundryAgent[]): LegacyFingerprint[] {
  if (agents.length !== foundryManifest.agents.length) {
    throw new Error(
      `Expected exactly ${foundryManifest.agents.length} legacy agents before the pilot; found ${agents.length}.`,
    )
  }
  const byName = new Map<string, FoundryAgent>()
  for (const agent of agents) {
    if (agent.name === null || agent.name === undefined || !legacyNames.has(agent.name)) {
      throw new Error('Foundry estate contains an unexpected non-pilot agent.')
    }
    if (byName.has(agent.name)) throw new Error(`Duplicate legacy agent name: ${agent.name}.`)
    if (agent.description?.includes(AGENT_SENTINEL_MANAGED_MARKER) !== true) {
      throw new Error(`Legacy agent ${agent.name} is missing the ownership marker.`)
    }
    const parsed = foundryAgentSchema.parse(agent)
    if (parsed.instance_identity !== null && parsed.instance_identity !== undefined) {
      throw new Error(`Legacy agent ${agent.name} already has an instance identity.`)
    }
    byName.set(agent.name, parsed)
  }
  for (const expectedName of legacyNames) {
    if (!byName.has(expectedName)) throw new Error(`Missing legacy agent: ${expectedName}.`)
  }
  return [...byName.values()]
    .map(fingerprint)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function assertLegacyAgentsUnchanged(
  baseline: readonly LegacyFingerprint[],
  agents: readonly FoundryAgent[],
): void {
  const current = agents
    .filter((agent) => agent.name !== FOUNDRY_IDENTITY_PILOT_NAME)
    .map(fingerprint)
    .sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(current) !== JSON.stringify(baseline)) {
    throw new Error('Legacy agents changed during the isolated pilot operation.')
  }
}

function pilotEvidence(
  action: FoundryIdentityPilotEvidence['action'],
  agentInput: FoundryAgent,
  legacyAgents: readonly LegacyFingerprint[],
): FoundryIdentityPilotEvidence {
  const agent = foundryAgentSchema.parse(agentInput)
  if (
    agent.name !== FOUNDRY_IDENTITY_PILOT_NAME ||
    agent.version !== FOUNDRY_IDENTITY_PILOT_VERSION ||
    agent.description?.includes(FOUNDRY_IDENTITY_PILOT_MARKER) !== true ||
    agent.metadata?.['pilot'] !== 'foundry-instance-identity' ||
    agent.metadata['pilotVersion'] !== FOUNDRY_IDENTITY_PILOT_VERSION
  ) {
    throw new Error('Pilot agent identity or ownership markers do not match the fixed contract.')
  }
  if (
    agent.instance_identity === null ||
    agent.instance_identity === undefined ||
    agent.blueprint === null ||
    agent.blueprint === undefined ||
    agent.blueprint_reference === null ||
    agent.blueprint_reference === undefined
  ) {
    throw new Error('Pilot identity provisioning is incomplete.')
  }
  return {
    action,
    agent: {
      id: agent.id,
      name: FOUNDRY_IDENTITY_PILOT_NAME,
      ...(agent.version === undefined ? {} : { version: agent.version }),
      principalId: agent.instance_identity.principal_id,
      clientId: agent.instance_identity.client_id,
      blueprintPrincipalId: agent.blueprint.principal_id,
      blueprintClientId: agent.blueprint.client_id,
      blueprintId: agent.blueprint_reference.blueprint_id,
    },
    legacyAgents,
  }
}

async function waitForIdentity(client: PilotClient, sleep: Sleep): Promise<FoundryAgent> {
  let last: FoundryAgent | undefined
  for (let attempt = 0; attempt < IDENTITY_POLL_ATTEMPTS; attempt += 1) {
    last = await client.getAgent(FOUNDRY_IDENTITY_PILOT_NAME)
    if (
      last?.instance_identity !== null &&
      last?.instance_identity !== undefined &&
      last.blueprint !== null &&
      last.blueprint !== undefined &&
      last.blueprint_reference !== null &&
      last.blueprint_reference !== undefined
    ) {
      return last
    }
    if (attempt + 1 < IDENTITY_POLL_ATTEMPTS) await sleep(IDENTITY_POLL_DELAY_MS)
  }
  if (last === undefined) throw new Error('Pilot agent was not found after creation.')
  throw new Error(
    'Pilot agent exists, but identity provisioning did not complete within 60 seconds.',
  )
}

async function waitForDeletion(client: PilotClient, sleep: Sleep): Promise<void> {
  for (let attempt = 0; attempt < IDENTITY_POLL_ATTEMPTS; attempt += 1) {
    if ((await client.getAgent(FOUNDRY_IDENTITY_PILOT_NAME)) === undefined) return
    if (attempt + 1 < IDENTITY_POLL_ATTEMPTS) await sleep(IDENTITY_POLL_DELAY_MS)
  }
  throw new Error('Pilot agent deletion did not complete within 60 seconds.')
}

export async function createFoundryIdentityPilot(
  client: PilotClient,
  confirmation: string,
  sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<FoundryIdentityPilotEvidence> {
  if (confirmation !== FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION) {
    throw new Error(`Create requires --confirm ${FOUNDRY_IDENTITY_PILOT_CREATE_CONFIRMATION}.`)
  }
  const before = await client.listAgents()
  if (before.some((agent) => agent.name === FOUNDRY_IDENTITY_PILOT_NAME)) {
    throw new Error('The fixed pilot agent name already exists; no create operation was attempted.')
  }
  const legacyAgents = captureLegacyAgents(before)

  await client.createAgent(FOUNDRY_IDENTITY_PILOT_NAME, buildFoundryIdentityPilotPayload())
  const pilot = await waitForIdentity(client, sleep)
  const after = await client.listAgents()
  if (after.length !== foundryManifest.agents.length + 1) {
    throw new Error('Post-create estate does not contain exactly six legacy agents plus one pilot.')
  }
  assertLegacyAgentsUnchanged(legacyAgents, after)
  const listedPilot = after.filter((agent) => agent.name === FOUNDRY_IDENTITY_PILOT_NAME)
  if (listedPilot.length !== 1 || listedPilot[0]?.id !== pilot.id || pilot.id === '') {
    throw new Error('Post-create pilot uniqueness verification failed.')
  }
  return pilotEvidence('created', pilot, legacyAgents)
}

function validImmutableId(agentId: string): boolean {
  const hasControlCharacter = [...agentId].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
  return (
    agentId.length >= 1 &&
    agentId.length <= 256 &&
    agentId.trim() === agentId &&
    !hasControlCharacter
  )
}

export async function cleanupFoundryIdentityPilot(
  client: PilotClient,
  agentId: string,
  confirmation: string,
  sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
): Promise<FoundryIdentityPilotEvidence> {
  if (!validImmutableId(agentId)) throw new Error('A valid immutable pilot agent ID is required.')
  if (confirmation !== pilotCleanupConfirmation(agentId)) {
    throw new Error(`Cleanup requires --confirm ${pilotCleanupConfirmation(agentId)}.`)
  }
  const before = await client.listAgents()
  const pilotCandidates = before.filter((agent) => agent.name === FOUNDRY_IDENTITY_PILOT_NAME)
  if (pilotCandidates.length !== 1 || pilotCandidates[0]?.id !== agentId) {
    throw new Error('The requested immutable ID does not identify the one fixed pilot agent.')
  }
  const legacyAgents = captureLegacyAgents(
    before.filter((agent) => agent.name !== FOUNDRY_IDENTITY_PILOT_NAME),
  )
  const evidence = pilotEvidence('deleted', pilotCandidates[0], legacyAgents)

  await client.deleteAgent(FOUNDRY_IDENTITY_PILOT_NAME)
  await waitForDeletion(client, sleep)
  const after = await client.listAgents()
  if (after.some((agent) => agent.name === FOUNDRY_IDENTITY_PILOT_NAME)) {
    throw new Error('Pilot agent remains present after cleanup.')
  }
  assertLegacyAgentsUnchanged(legacyAgents, after)
  return evidence
}

interface PilotCliOptions {
  readonly action: 'plan' | 'create' | 'cleanup'
  readonly apply: boolean
  readonly confirmation?: string
  readonly agentId?: string
}

function parseCliOptions(argv: readonly string[]): PilotCliOptions {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const action = normalizedArgv[0] ?? 'plan'
  if (action !== 'plan' && action !== 'create' && action !== 'cleanup') {
    throw new Error('Usage: foundry:identity-pilot [plan|create|cleanup] [--apply] [options]')
  }
  let apply = false
  let confirmation: string | undefined
  let agentId: string | undefined
  for (let index = 1; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index]
    if (argument === '--apply') {
      apply = true
      continue
    }
    if (argument === '--confirm' || argument === '--agent-id') {
      const value = normalizedArgv[index + 1]
      if (value === undefined) throw new Error(`${argument} requires a value.`)
      if (argument === '--confirm') confirmation = value
      else agentId = value
      index += 1
      continue
    }
    throw new Error(`Unknown argument: ${argument}.`)
  }
  return {
    action,
    apply,
    ...(confirmation === undefined ? {} : { confirmation }),
    ...(agentId === undefined ? {} : { agentId }),
  }
}

export async function runFoundryIdentityPilotCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: {
    readonly clientFactory?: (endpoint: string) => PilotClient
    readonly log?: (message: string) => void
  } = {},
): Promise<number> {
  const options = parseCliOptions(argv)
  const log = dependencies.log ?? console.log
  if (options.action === 'plan') {
    if (options.apply) throw new Error('Plan mode never accepts --apply.')
    log(JSON.stringify(buildFoundryIdentityPilotPlan(), null, 2))
    return 0
  }
  if (!options.apply) {
    throw new Error(`${options.action} is blocked without --apply; run plan first.`)
  }
  const endpoint = requiredEnvironment('FOUNDRY_PROJECT_ENDPOINT')
  const client =
    dependencies.clientFactory?.(endpoint) ??
    new FoundryHttpClient(endpoint, new DefaultAzureCredential())
  const evidence =
    options.action === 'create'
      ? await createFoundryIdentityPilot(client, options.confirmation ?? '')
      : await cleanupFoundryIdentityPilot(client, options.agentId ?? '', options.confirmation ?? '')
  log(JSON.stringify(evidence, null, 2))
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runFoundryIdentityPilotCli()
}
