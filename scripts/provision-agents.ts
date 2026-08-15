import { pathToFileURL } from 'node:url'
import { DefaultAzureCredential } from '@azure/identity'
import { foundryManifest, type AgentDefinition } from '@agent-sentinel/scenarios'

import {
  AGENT_SENTINEL_MANAGED_MARKER,
  FoundryHttpClient,
  requiredEnvironment,
} from './foundry-http.js'

type ProvisioningClient = Pick<FoundryHttpClient, 'createAgent' | 'getAgent' | 'listAgents'>

export async function provisionAgents(
  client: ProvisioningClient,
  agents: readonly AgentDefinition[] = foundryManifest.agents,
  log: (message: string) => void = console.log,
): Promise<{ created: number; unchanged: number; verified: number }> {
  const existing = await client.listAgents()
  let created = 0
  let unchanged = 0

  for (const agent of agents) {
    const hash = agent.manifestHash
    if (hash === undefined) throw new Error(`Missing manifest hash for ${agent.name}.`)
    const candidate = existing.find(
      (item) =>
        item.name === agent.name &&
        item.description?.includes(AGENT_SENTINEL_MANAGED_MARKER) === true &&
        item.description.includes(`[hash:${hash}]`),
    )
    if (candidate !== undefined) {
      const current = await client.getAgent(candidate.id)
      if (
        current?.name === agent.name &&
        current.description?.includes(AGENT_SENTINEL_MANAGED_MARKER) === true &&
        current.description.includes(`[hash:${hash}]`)
      ) {
        unchanged += 1
        log(`Unchanged ${agent.name} (${candidate.id}).`)
        continue
      }
    }

    await client.createAgent(agent.name, {
      name: agent.name,
      description: `${agent.description} ${AGENT_SENTINEL_MANAGED_MARKER} [hash:${hash}]`,
      definition: {
        kind: 'prompt',
        name: agent.name,
        model: agent.modelDeployment,
        instructions: agent.instructions,
        tools: agent.functions.map((fn) => ({
          type: 'function',
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        })),
      },
      metadata: {
        managedBy: 'agent-sentinel',
        manifestHash: hash,
        owner: agent.owner,
        environment: agent.environment,
        lifecycle: agent.lifecycle,
        approvalRequired: String(agent.approvalRequired),
        expectedRisk: agent.expectedRisk,
        expectedTrust: agent.expectedTrust,
        syntheticOnly: 'true',
      },
    })
    created += 1
    log(`Created ${agent.name}.`)
  }

  const finalAgents = await client.listAgents()
  const verified = agents.filter((definition) =>
    finalAgents.some(
      (agent) =>
        agent.name === definition.name &&
        agent.description?.includes(AGENT_SENTINEL_MANAGED_MARKER) === true &&
        agent.description.includes(`[hash:${definition.manifestHash}]`),
    ),
  ).length
  if (verified !== agents.length) {
    throw new Error(`Foundry verification failed: ${verified}/${agents.length} current agents found.`)
  }
  return { created, unchanged, verified }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const endpoint = requiredEnvironment('FOUNDRY_PROJECT_ENDPOINT')
  const client = new FoundryHttpClient(endpoint, new DefaultAzureCredential())
  const result = await provisionAgents(client)
  console.log(
    `Foundry agents: ${result.created} created, ${result.unchanged} unchanged, ${result.verified}/6 verified.`,
  )
  console.log(`Foundry retries: ${client.retryCount}.`)
}
