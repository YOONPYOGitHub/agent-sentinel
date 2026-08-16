import type { ServiceBusClient } from '@azure/service-bus'

import { domainEventSchema, type DomainEvent } from './contracts.js'

export interface EventPublisher {
  publish(event: DomainEvent, queueOrTopicName: string): Promise<void>
}

export class ServiceBusEventPublisher implements EventPublisher {
  constructor(private readonly client: ServiceBusClient) {}

  async publish(event: DomainEvent, queueOrTopicName: string): Promise<void> {
    const validatedEvent = domainEventSchema.parse(event)
    const sender = this.client.createSender(queueOrTopicName)
    try {
      await sender.sendMessages({
        body: validatedEvent,
        messageId: validatedEvent.correlationId,
        correlationId: validatedEvent.correlationId,
        subject: validatedEvent.type,
        contentType: 'application/json',
        applicationProperties: {
          'x-correlation-id': validatedEvent.correlationId,
        },
      })
    } finally {
      await sender.close()
    }
  }
}

export class InMemoryEventPublisher implements EventPublisher {
  public readonly published: Array<{ event: DomainEvent; destination: string }> = []

  publish(event: DomainEvent, destination: string): Promise<void> {
    this.published.push({ event, destination })
    return Promise.resolve()
  }
}
