import type { Container, CosmosClient, SqlQuerySpec } from '@azure/cosmos'

import {
  connectorHealthMeasurementSchema,
  type ConnectorHealthMeasurement,
  type ConnectorHealthRepository,
} from '@agent-sentinel/connector-sdk'
import type { EstateContext } from '@agent-sentinel/domain'

interface ConnectorHealthDocument {
  id: string
  documentType: 'connector-health-measurement'
  estateId: string
  tenantId: string
  environment: string
  connectorId: string
  measuredAt: string
  measurement: ConnectorHealthMeasurement
}

function assertBoundary(estate: EstateContext, measurement: ConnectorHealthMeasurement): void {
  if (
    measurement.estateId !== estate.id ||
    measurement.tenantId !== estate.tenantId ||
    measurement.environment !== estate.environment
  ) {
    throw new Error('Connector health measurement boundary does not match the target estate.')
  }
}

function assertDocumentBoundary(
  estate: EstateContext,
  connectorId: string,
  document: ConnectorHealthDocument,
): void {
  if (
    document.documentType !== 'connector-health-measurement' ||
    document.estateId !== estate.id ||
    document.tenantId !== estate.tenantId ||
    document.environment !== estate.environment ||
    document.connectorId !== connectorId ||
    document.measurement.connectorId !== connectorId ||
    document.measuredAt !== document.measurement.measuredAt
  ) {
    throw new Error('Stored connector health measurement boundary is inconsistent.')
  }
  assertBoundary(estate, document.measurement)
}

function physicalId(measurement: ConnectorHealthMeasurement): string {
  return [
    'connector-health',
    measurement.estateId,
    measurement.tenantId,
    measurement.environment,
    measurement.connectorId,
    measurement.measuredAt,
  ].join(':')
}

function latestQuery(estate: EstateContext, connectorId: string): SqlQuerySpec {
  return {
    query:
      'SELECT TOP 1 * FROM c WHERE c.documentType = @documentType ' +
      'AND c.estateId = @estateId AND c.tenantId = @tenantId ' +
      'AND c.environment = @environment AND c.connectorId = @connectorId ' +
      'ORDER BY c.measuredAt DESC',
    parameters: [
      { name: '@documentType', value: 'connector-health-measurement' },
      { name: '@estateId', value: estate.id },
      { name: '@tenantId', value: estate.tenantId },
      { name: '@environment', value: estate.environment },
      { name: '@connectorId', value: connectorId },
    ],
  }
}

export class CosmosConnectorHealthRepository implements ConnectorHealthRepository {
  private readonly container: Container

  constructor(client: CosmosClient, databaseId = 'agent-sentinel-db', containerId = 'snapshots') {
    this.container = client.database(databaseId).container(containerId)
  }

  async save(estate: EstateContext, measurement: ConnectorHealthMeasurement): Promise<void> {
    connectorHealthMeasurementSchema.parse(measurement)
    assertBoundary(estate, measurement)
    await this.container.items.upsert<ConnectorHealthDocument>({
      id: physicalId(measurement),
      documentType: 'connector-health-measurement',
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: measurement.connectorId,
      measuredAt: measurement.measuredAt,
      measurement,
    })
  }

  async findLatest(
    estate: EstateContext,
    connectorId: string,
  ): Promise<ConnectorHealthMeasurement | null> {
    const { resources } = await this.container.items
      .query<ConnectorHealthDocument>(latestQuery(estate, connectorId), {
        partitionKey: estate.tenantId,
      })
      .fetchAll()
    const document = resources[0]
    if (document === undefined) return null
    connectorHealthMeasurementSchema.parse(document.measurement)
    assertDocumentBoundary(estate, connectorId, document)
    return structuredClone(document.measurement)
  }
}
