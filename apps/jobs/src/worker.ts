import { DefaultAzureCredential } from '@azure/identity'
import { ServiceBusClient } from '@azure/service-bus'

import { InMemoryDeduplicator, domainEventSchema, withIdempotency } from '@agent-sentinel/messaging'

import { initTelemetry } from './telemetry.js'

initTelemetry()

const SB_FQDN = process.env['SERVICE_BUS_FQDN'] ?? ''
const CORRELATION_ID_HEADER = 'x-correlation-id'

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

function processMessage(message: IncomingMessage): Promise<void> {
  const correlationId = correlationIdFrom(
    message.applicationProperties?.[CORRELATION_ID_HEADER] ?? message.messageId,
  )
  const event = domainEventSchema.parse(message.body)
  console.log(
    JSON.stringify({
      level: 'info',
      correlationId,
      eventType: event.type,
      msg: 'processing message',
    }),
  )
  return Promise.resolve()
}

function main(): Promise<void> {
  if (!SB_FQDN) {
    throw new Error('SERVICE_BUS_FQDN is required')
  }
  const credential = new DefaultAzureCredential()
  const sbClient = new ServiceBusClient(SB_FQDN, credential)
  const deduplicator = new InMemoryDeduplicator()
  const receiver = sbClient.createReceiver('findings-validation')

  receiver.subscribe({
    async processMessage(message) {
      const messageId = String(message.messageId ?? '')
      await withIdempotency(deduplicator, messageId, () => processMessage(message))
    },
    processError(args) {
      console.error(
        JSON.stringify({ level: 'error', source: args.errorSource, msg: args.error.message }),
      )
      return Promise.resolve()
    },
  })

  async function shutdown(): Promise<void> {
    await receiver.close()
    await sbClient.close()
    process.exit(0)
  }

  process.on('SIGTERM', () => {
    void shutdown()
  })
  return Promise.resolve()
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'fatal',
      msg: error instanceof Error ? error.message : String(error),
    }),
  )
  process.exit(1)
})
