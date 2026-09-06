import { createHash } from 'node:crypto'

import type { Container, CosmosClient, SqlQuerySpec } from '@azure/cosmos'

import {
  ConnectorHealthConflictError,
  connectorHealthMeasurementSchema,
  type ConnectorHealthMeasurement,
  type ConnectorHealthMeasurementIdentity,
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
  measurementBytes?: string
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

function identity(measurement: ConnectorHealthMeasurement): ConnectorHealthMeasurementIdentity {
  return {
    estateId: measurement.estateId,
    tenantId: measurement.tenantId,
    environment: measurement.environment,
    connectorId: measurement.connectorId,
    measuredAt: measurement.measuredAt,
  }
}

function identityBytes(identityValue: ConnectorHealthMeasurementIdentity): string {
  return JSON.stringify([
    identityValue.estateId,
    identityValue.tenantId,
    identityValue.environment,
    identityValue.connectorId,
    identityValue.measuredAt,
  ])
}

function sameIdentity(
  left: ConnectorHealthMeasurementIdentity,
  right: ConnectorHealthMeasurementIdentity,
): boolean {
  return identityBytes(left) === identityBytes(right)
}

function physicalId(measurementIdentity: ConnectorHealthMeasurementIdentity): string {
  const digest = createHash('sha256')
    .update(identityBytes(measurementIdentity), 'utf8')
    .digest('hex')
  return `connector-health:${digest}`
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  if ('code' in error && typeof error.code === 'number') return error.code
  if ('statusCode' in error && typeof error.statusCode === 'number') return error.statusCode
  return undefined
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
    const measurementIdentity = identity(measurement)
    const id = physicalId(measurementIdentity)
    const measurementBytes = JSON.stringify(measurement)
    const document: ConnectorHealthDocument = {
      id,
      documentType: 'connector-health-measurement',
      estateId: estate.id,
      tenantId: estate.tenantId,
      environment: estate.environment,
      connectorId: measurement.connectorId,
      measuredAt: measurement.measuredAt,
      measurementBytes,
      measurement,
    }
    try {
      await this.container.items.create<ConnectorHealthDocument>(document)
    } catch (error: unknown) {
      if (statusCode(error) !== 409) throw error
      const existing = await this.readDocument(id, estate.tenantId)
      if (existing === null) {
        throw new Error('Conflicting connector health measurement could not be read.')
      }
      const existingIdentity = identity(existing.measurement)
      if (!sameIdentity(existingIdentity, measurementIdentity)) {
        throw new ConnectorHealthConflictError(measurementIdentity)
      }
      connectorHealthMeasurementSchema.parse(existing.measurement)
      assertDocumentBoundary(estate, measurement.connectorId, existing)
      const existingBytes = existing.measurementBytes ?? JSON.stringify(existing.measurement)
      if (
        existing.measurementBytes !== undefined &&
        existing.measurementBytes !== JSON.stringify(existing.measurement)
      ) {
        throw new Error('Stored connector health measurement bytes are inconsistent.')
      }
      if (existingBytes !== measurementBytes) {
        throw new ConnectorHealthConflictError(measurementIdentity)
      }
    }
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
    if (
      document.measurementBytes !== undefined &&
      document.measurementBytes !== JSON.stringify(document.measurement)
    ) {
      throw new Error('Stored connector health measurement bytes are inconsistent.')
    }
    return structuredClone(document.measurement)
  }

  private async readDocument(
    id: string,
    tenantId: string,
  ): Promise<ConnectorHealthDocument | null> {
    try {
      const { resource } = await this.container.item(id, tenantId).read<ConnectorHealthDocument>()
      return resource ?? null
    } catch (error: unknown) {
      if (statusCode(error) === 404) return null
      throw error
    }
  }
}
