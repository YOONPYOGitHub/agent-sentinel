import { describe, expect, it } from 'vitest'

import {
  InMemoryDeduplicator,
  InMemoryEventPublisher,
  findingDetectedEventSchema,
  withIdempotency,
  type FindingDetectedEvent,
} from '../src/index.js'

const event: FindingDetectedEvent = {
  type: 'finding.detected',
  correlationId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-one',
  findingId: 'finding-1',
  severity: 'high',
  timestamp: '2024-01-01T00:00:00.000Z',
}

describe('messaging primitives', () => {
  it('validates event contracts', () => {
    expect(findingDetectedEventSchema.parse(event)).toEqual(event)
    expect(findingDetectedEventSchema.safeParse({ ...event, severity: 'urgent' }).success).toBe(
      false,
    )
  })

  it('tracks processed message identifiers', async () => {
    const deduplicator = new InMemoryDeduplicator()

    await expect(deduplicator.isDuplicate('message-1')).resolves.toBe(false)
    await deduplicator.markProcessed('message-1')
    await expect(deduplicator.isDuplicate('message-1')).resolves.toBe(true)
  })

  it('skips duplicate message processing', async () => {
    const deduplicator = new InMemoryDeduplicator()
    let executions = 0
    const handler = () => {
      executions += 1
      return Promise.resolve('processed')
    }

    await expect(withIdempotency(deduplicator, 'message-1', handler)).resolves.toBe('processed')
    await expect(withIdempotency(deduplicator, 'message-1', handler)).resolves.toBeNull()
    expect(executions).toBe(1)
  })

  it('captures published events', async () => {
    const publisher = new InMemoryEventPublisher()

    await publisher.publish(event, 'findings')

    expect(publisher.published).toEqual([{ event, destination: 'findings' }])
  })
})
