import { pathToFileURL } from 'node:url'
import { DefaultAzureCredential } from '@azure/identity'
import { foundryManifest } from '@agent-sentinel/scenarios'

import {
  AGENT_SENTINEL_MANAGED_MARKER,
  FoundryHttpClient,
  requiredEnvironment,
} from './foundry-http.js'

const manifestNames = new Set(foundryManifest.agents.map((agent) => agent.name))

type CleanupClient = Pick<FoundryHttpClient, 'deleteAgent' | 'listAgents'>

export async function cleanupAgents(
  client: CleanupClient,
  dryRun: boolean,
  log: (message: string) => void = console.log,
): Promise<number> {
  const managedAgents = (await client.listAgents()).filter(
    (agent) =>
      agent.name !== null &&
      agent.name !== undefined &&
      manifestNames.has(agent.name) &&
      agent.description?.includes(AGENT_SENTINEL_MANAGED_MARKER) === true,
  )

  for (const agent of managedAgents) {
    if (!dryRun) await client.deleteAgent(agent.id)
    log(`${dryRun ? 'Would delete' : 'Deleted'} ${agent.name} (${agent.id}).`)
  }
  log(
    `${dryRun ? 'Dry run found' : 'Deleted'} ${managedAgents.length} owned Agent Sentinel Foundry agent(s).`,
  )
  return managedAgents.length
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = !process.argv.slice(2).includes('--apply')
  const endpoint = requiredEnvironment('FOUNDRY_PROJECT_ENDPOINT')
  const client = new FoundryHttpClient(endpoint, new DefaultAzureCredential())
  await cleanupAgents(client, dryRun)
  console.log(`Foundry retries: ${client.retryCount}.`)
}
