import { DefaultAzureCredential } from '@azure/identity'
import { useAzureMonitor } from '@azure/monitor-opentelemetry'
import { trace } from '@opentelemetry/api'

export function initTelemetry(): void {
  const connectionString = process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']
  if (!connectionString) return

  useAzureMonitor({
    azureMonitorExporterOptions: {
      connectionString,
      credential: new DefaultAzureCredential(),
    },
  })
}

export function getTracer(name: string) {
  return trace.getTracer(name, '0.1.0')
}
