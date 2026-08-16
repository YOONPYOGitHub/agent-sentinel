import { afterEach, describe, expect, it } from 'vitest'

import { getTracer, initTelemetry } from '../src/telemetry.js'

const originalConnectionString = process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']

afterEach(() => {
  if (originalConnectionString === undefined) {
    delete process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']
  } else {
    process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'] = originalConnectionString
  }
})

describe('telemetry', () => {
  it('is disabled safely without an Application Insights connection string', () => {
    delete process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']

    expect(initTelemetry).not.toThrow()
    expect(getTracer('jobs-test')).toBeDefined()
  })
})
