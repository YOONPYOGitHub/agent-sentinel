import { DefaultAzureCredential } from '@azure/identity'
import { ServiceBusClient } from '@azure/service-bus'
import { CosmosClient } from '@azure/cosmos'

import type {
  ConnectorHealthRepository,
  ManifestIngestionRepository,
} from '@agent-sentinel/connector-sdk'
import type {
  EstateContext,
  ExposureFindingRepository,
  SnapshotRepository,
} from '@agent-sentinel/domain'
import { InMemoryDeduplicator, withIdempotency } from '@agent-sentinel/messaging'
import {
  CosmosConnectorHealthRepository,
  CosmosExposureFindingRepository,
  CosmosManifestIngestionRepository,
  CosmosSnapshotRepository,
  InMemoryConnectorHealthRepository,
  InMemoryExposureFindingRepository,
  InMemoryManifestIngestionRepository,
  InMemorySnapshotRepository,
} from '@agent-sentinel/persistence'

import { buildConnector } from './connector-factory.js'
import { validateWorkerEventEstate } from './event-boundary.js'
import { IngestionService, defaultLogger } from './ingestion-service.js'
import { initTelemetry } from './telemetry.js'

initTelemetry()

const CORRELATION_ID_HEADER = 'x-correlation-id'
const DEFAULT_INTERVAL_MS = 300_000

interface IncomingMessage {
  body: unknown
  messageId?: string | number | bigint | Buffer | null
  applicationProperties?: Record<string, unknown> | null
}

function correlationIdFrom(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    Buffer.isBuffer(value)
  ) {
    return String(value)
  }
  return 'unknown'
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function buildRepositories(
  mode: 'mock' | 'foundry',
  tenantId: string,
): {
  snapshots: SnapshotRepository
  exposures: ExposureFindingRepository
  manifestIngestions: ManifestIngestionRepository
  connectorHealth: ConnectorHealthRepository
} {
  if (mode === 'mock') {
    return {
      snapshots: new InMemorySnapshotRepository(),
      exposures: new InMemoryExposureFindingRepository(),
      manifestIngestions: new InMemoryManifestIngestionRepository(tenantId),
      connectorHealth: new InMemoryConnectorHealthRepository(),
    }
  }
  const endpoint = required('COSMOS_ENDPOINT')
  const databaseId =
    process.env['COSMOS_DATABASE']?.trim() ||
    process.env['COSMOS_DATABASE_ID']?.trim() ||
    'agent-sentinel-db'
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() })
  return {
    snapshots: new CosmosSnapshotRepository(client, databaseId),
    exposures: new CosmosExposureFindingRepository(client, databaseId),
    connectorHealth: new CosmosConnectorHealthRepository(client, databaseId),
    manifestIngestions: new CosmosManifestIngestionRepository(client, {
      tenantId,
      databaseId,
      containerId:
        process.env['COSMOS_MANIFEST_INGESTIONS_CONTAINER']?.trim() || 'manifest-ingestions',
    }),
  }
}

async function processMessage(
  message: IncomingMessage,
  estate: EstateContext,
  run: () => Promise<void>,
): Promise<void> {
  const correlationId = correlationIdFrom(
    message.applicationProperties?.[CORRELATION_ID_HEADER] ?? message.messageId,
  )
  const event = validateWorkerEventEstate(message.body, estate)
  defaultLogger.info('worker.event.received', {
    correlationId,
    eventType: event.type,
    estateId: estate.id,
  })
  if (event.type === 'snapshot.ingested') {
    await run()
  }
}

async function main(): Promise<void> {
  const connectorRaw = process.env['AGENT_SENTINEL_CONNECTOR']?.trim() || 'mock'
  if (connectorRaw !== 'mock' && connectorRaw !== 'foundry') {
    throw new Error(`AGENT_SENTINEL_CONNECTOR must be mock or foundry; received ${connectorRaw}.`)
  }
  const connectorMode: 'mock' | 'foundry' = connectorRaw
  const tenantId = process.env['AGENT_SENTINEL_TENANT_ID']?.trim() || 'tenant-demo'
  const estate: EstateContext = {
    id: process.env['AGENT_SENTINEL_ESTATE_ID']?.trim() || 'default',
    tenantId,
    environment:
      process.env['AGENT_SENTINEL_ENVIRONMENT']?.trim() ||
      process.env['FOUNDRY_ENVIRONMENT']?.trim() ||
      'validation',
  }
  const intervalMs = Number.parseInt(
    process.env['DISCOVERY_INTERVAL_MS']?.trim() || String(DEFAULT_INTERVAL_MS),
    10,
  )
  const connector = buildConnector(connectorMode, process.env)
  const { snapshots, exposures, manifestIngestions, connectorHealth } = buildRepositories(
    connectorMode,
    tenantId,
  )
  const service = new IngestionService(connector, snapshots, exposures, {
    estate,
    sourceMode: connectorMode,
    logger: defaultLogger,
    manifestIngestions,
    connectorHealthRepository: connectorHealth,
  })

  let running = false
  let healthy = true
  const runOnce = async (): Promise<void> => {
    if (running) {
      defaultLogger.warn('worker.tick.skipped', { reason: 'already-running' })
      return
    }
    running = true
    try {
      await service.run()
      healthy = true
    } catch (error) {
      healthy = false
      defaultLogger.error('worker.tick.failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
    }
  }

  await runOnce()
  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)

  const sbFqdn = process.env['SERVICE_BUS_FQDN']?.trim()
  let sbClient: ServiceBusClient | undefined
  let receiver: ReturnType<ServiceBusClient['createReceiver']> | undefined
  if (sbFqdn) {
    sbClient = new ServiceBusClient(sbFqdn, new DefaultAzureCredential())
    const deduplicator = new InMemoryDeduplicator()
    receiver = sbClient.createReceiver('snapshot-ingestion')
    receiver.subscribe({
      async processMessage(message) {
        const messageId = String(message.messageId ?? '')
        await withIdempotency(deduplicator, messageId, () =>
          processMessage(message, estate, runOnce),
        )
      },
      processError(args) {
        defaultLogger.error('worker.sb.error', {
          source: args.errorSource,
          message: args.error.message,
        })
        return Promise.resolve()
      },
    })
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(timer)
    if (receiver) await receiver.close()
    if (sbClient) await sbClient.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })

  // Expose health flag for external probes if desired.
  Object.assign(globalThis as unknown as { agentSentinelHealthy?: () => boolean }, {
    agentSentinelHealthy: () => healthy,
  })
}

main().catch((error: unknown) => {
  defaultLogger.error('worker.fatal', {
    message: error instanceof Error ? error.message : String(error),
  })
  process.exit(1)
})
