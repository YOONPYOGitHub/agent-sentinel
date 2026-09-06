import {
  ConnectorHealthConflictError,
  connectorHealthMeasurementSchema,
  type ConnectorHealthMeasurement,
  type ConnectorHealthMeasurementIdentity,
  type ConnectorHealthRepository,
} from '@agent-sentinel/connector-sdk'
import type { EstateContext } from '@agent-sentinel/domain'

function assertBoundary(estate: EstateContext, measurement: ConnectorHealthMeasurement): void {
  if (
    measurement.estateId !== estate.id ||
    measurement.tenantId !== estate.tenantId ||
    measurement.environment !== estate.environment
  ) {
    throw new Error('Connector health measurement boundary does not match the target estate.')
  }
}

function identity(measurement: ConnectorHealthMeasurement): ConnectorHealthMeasurementIdentity {
  return {
    estateId: measurement.estateId,
    tenantId: measurement.tenantId,
    environment: measurement.environment,
    connectorId: measurement.connectorId,
    measuredAt: measurement.measuredAt,
  }
}

function identityKey(identityValue: ConnectorHealthMeasurementIdentity): string {
  return JSON.stringify([
    identityValue.estateId,
    identityValue.tenantId,
    identityValue.environment,
    identityValue.connectorId,
    identityValue.measuredAt,
  ])
}

function scopeKey(estate: EstateContext, connectorId: string): string {
  return JSON.stringify([estate.id, estate.tenantId, estate.environment, connectorId])
}

interface StoredMeasurement {
  readonly bytes: string
  readonly measurement: ConnectorHealthMeasurement
}

export class InMemoryConnectorHealthRepository implements ConnectorHealthRepository {
  private readonly measurements = new Map<string, StoredMeasurement>()
  private readonly latestByScope = new Map<string, string>()

  save(estate: EstateContext, measurement: ConnectorHealthMeasurement): Promise<void> {
    return Promise.resolve().then(() => {
      connectorHealthMeasurementSchema.parse(measurement)
      assertBoundary(estate, measurement)
      const measurementIdentity = identity(measurement)
      const key = identityKey(measurementIdentity)
      const bytes = JSON.stringify(measurement)
      const existing = this.measurements.get(key)
      if (existing !== undefined) {
        if (existing.bytes !== bytes) {
          throw new ConnectorHealthConflictError(measurementIdentity)
        }
        return
      }

      this.measurements.set(key, {
        bytes,
        measurement: structuredClone(measurement),
      })
      const scope = scopeKey(estate, measurement.connectorId)
      const latestKey = this.latestByScope.get(scope)
      const latest = latestKey === undefined ? undefined : this.measurements.get(latestKey)
      if (latest === undefined || latest.measurement.measuredAt < measurement.measuredAt) {
        this.latestByScope.set(scope, key)
      }
    })
  }

  findLatest(
    estate: EstateContext,
    connectorId: string,
  ): Promise<ConnectorHealthMeasurement | null> {
    const latestKey = this.latestByScope.get(scopeKey(estate, connectorId))
    const stored = latestKey === undefined ? undefined : this.measurements.get(latestKey)
    const measurement = stored?.measurement
    if (
      measurement === undefined ||
      measurement.estateId !== estate.id ||
      measurement.tenantId !== estate.tenantId ||
      measurement.environment !== estate.environment ||
      measurement.connectorId !== connectorId
    ) {
      return Promise.resolve(null)
    }
    return Promise.resolve(structuredClone(measurement))
  }
}
