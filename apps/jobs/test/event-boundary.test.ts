import { describe, expect, it } from 'vitest'

import { validateWorkerEventEstate } from '../src/event-boundary.js'

const estate = {
  id: 'korea-production',
  tenantId: 'tenant-korea',
  environment: 'production',
}

const event = {
  type: 'snapshot.ingested',
  correlationId: '11111111-1111-4111-8111-111111111111',
  estateId: estate.id,
  tenantId: estate.tenantId,
  environment: estate.environment,
  snapshotId: 'snapshot-1',
  timestamp: '2026-09-04T00:00:00.000Z',
}

describe('worker event estate boundary', () => {
  it('accepts an event bound to the worker estate', () => {
    expect(validateWorkerEventEstate(event, estate)).toEqual(event)
  })

  it.each([
    ['estateId', 'other'],
    ['tenantId', 'other'],
    ['environment', 'validation'],
  ] as const)('rejects a mismatched %s before running ingestion', (field, value) => {
    expect(() => validateWorkerEventEstate({ ...event, [field]: value }, estate)).toThrow(
      'does not match the configured worker estate',
    )
  })

  it('rejects legacy events without an explicit estate and environment', () => {
    const { estateId: _estateId, environment: _environment, ...legacy } = event
    expect(() => validateWorkerEventEstate(legacy, estate)).toThrow()
  })
})
