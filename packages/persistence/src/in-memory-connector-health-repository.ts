import {
  connectorHealthMeasurementSchema,
  type ConnectorHealthMeasurement,
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

export class InMemoryConnectorHealthRepository implements ConnectorHealthRepository {
  private readonly measurements = new Map<string, ConnectorHealthMeasurement>()

  private key(estate: EstateContext, connectorId: string): string {
    return [estate.id, estate.tenantId, estate.environment, connectorId].join('\u0000')
  }

  save(estate: EstateContext, measurement: ConnectorHealthMeasurement): Promise<void> {
    return Promise.resolve().then(() => {
      connectorHealthMeasurementSchema.parse(measurement)
      assertBoundary(estate, measurement)
      const key = this.key(estate, measurement.connectorId)
      const current = this.measurements.get(key)
      if (current === undefined || current.measuredAt <= measurement.measuredAt) {
        this.measurements.set(key, structuredClone(measurement))
      }
    })
  }

  findLatest(
    estate: EstateContext,
    connectorId: string,
  ): Promise<ConnectorHealthMeasurement | null> {
    const measurement = this.measurements.get(this.key(estate, connectorId))
    if (
      measurement === undefined ||
      measurement.tenantId !== estate.tenantId ||
      measurement.environment !== estate.environment
    ) {
      return Promise.resolve(null)
    }
    return Promise.resolve(structuredClone(measurement))
  }
}
