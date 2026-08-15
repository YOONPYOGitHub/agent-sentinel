import { Badge, Button } from '@fluentui/react-components'
import {
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ErrorCircleRegular,
} from '@fluentui/react-icons'
import { useCallback, useEffect, useState } from 'react'
import { connectorApi, type ConnectorStatus } from '../api'
import { PageHeading } from '../components/PageHeading'

export function ConnectorsPage() {
  const [status, setStatus] = useState<ConnectorStatus>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setStatus(await connectorApi.getConnectorStatus())
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Connector status could not be read.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => void load(), [load])

  return (
    <div className="page">
      <PageHeading
        section="Connectors"
        title="Connector health"
        description="Authoritative coverage, permissions, API maturity, and measured connection state."
        actions={
          <Button icon={<ArrowClockwiseRegular />} onClick={() => void load()} disabled={loading}>
            Refresh status
          </Button>
        }
      />
      {loading && status === undefined ? (
        <div className="connector-state" role="status">
          Loading connector status…
        </div>
      ) : error !== undefined ? (
        <div className="connector-state connector-state--error" role="alert">
          <ErrorCircleRegular />
          <div>
            <strong>Status unavailable</strong>
            <span>{error}</span>
          </div>
        </div>
      ) : status === undefined ? null : (
        <section className="connector-card" aria-label="Connector status">
          <div className="connector-card__header">
            <CheckmarkCircleRegular />
            <div>
              <h2>{status.connectorId}</h2>
              <p>Source: {status.source}</p>
            </div>
            <Badge color="success" appearance="tint">
              {status.mode}
            </Badge>
          </div>
          <dl className="connector-details">
            <div>
              <dt>Source</dt>
              <dd>{status.source}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{status.mode}</dd>
            </div>
            <div>
              <dt>Connector ID</dt>
              <dd>{status.connectorId}</dd>
            </div>
            {status.projectEndpoint !== undefined && (
              <div>
                <dt>Project endpoint</dt>
                <dd>{status.projectEndpoint}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </div>
  )
}
