import type { EstateContext } from '@agent-sentinel/domain'
import { domainEventSchema, type DomainEvent } from '@agent-sentinel/messaging'

export function validateWorkerEventEstate(body: unknown, estate: EstateContext): DomainEvent {
  const event = domainEventSchema.parse(body)
  if (
    event.estateId !== estate.id ||
    event.tenantId !== estate.tenantId ||
    event.environment !== estate.environment
  ) {
    throw new Error('Service Bus event boundary does not match the configured worker estate.')
  }
  return event
}
