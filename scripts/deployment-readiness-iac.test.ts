import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

function balancedObject(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker)
  expect(markerIndex).toBeGreaterThanOrEqual(0)
  const start = source.indexOf('{', markerIndex)
  expect(start).toBeGreaterThan(markerIndex)

  let depth = 0
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    if (depth === 0) return source.slice(start, index + 1)
  }

  throw new Error(`Unbalanced object after ${marker}`)
}

function normalized(value: string): string {
  return value.replace(/\s+/g, '')
}

describe('surgical connector-sources deployment', () => {
  const entrypoint = rootFile('infra/connector-sources.bicep')
  const parameters = rootFile(
    'infra/environments/mngenvmcap098047-connector-sources.parameters.bicepparam',
  )
  const fullCosmosModule = rootFile('infra/modules/cosmos.bicep')

  it('references the existing account and database and creates only one container', () => {
    expect(entrypoint).toContain("targetScope = 'resourceGroup'")
    expect(entrypoint).toMatch(
      /resource cosmosAccount 'Microsoft\.DocumentDB\/databaseAccounts@[^']+' existing =/,
    )
    expect(entrypoint).toMatch(
      /resource cosmosDatabase 'Microsoft\.DocumentDB\/databaseAccounts\/sqlDatabases@[^']+' existing =/,
    )
    expect(entrypoint).toMatch(
      /resource connectorSourcesContainer 'Microsoft\.DocumentDB\/databaseAccounts\/sqlDatabases\/containers@[^']+' =/,
    )
    expect(entrypoint.match(/^resource /gm)).toHaveLength(3)
    expect(entrypoint.match(/ existing =/g)).toHaveLength(2)
    expect(entrypoint).not.toContain('module ')
    expect(entrypoint).not.toMatch(
      /Microsoft\.(Network|ManagedIdentity|Authorization|App|ContainerRegistry)/,
    )
    expect(entrypoint).not.toContain("name: 'snapshots'")
    expect(entrypoint).not.toContain("name: 'findings'")
    expect(entrypoint).not.toContain("name: 'manifest-ingestions'")
  })

  it('uses the exact repository partition and indexing policy', () => {
    expect(entrypoint).toMatch(
      /name:\s*'connector-sources'[\s\S]*?partitionKey:\s*\{[\s\S]*?paths:\s*\['\/estateId'\][\s\S]*?kind:\s*'Hash'/,
    )

    const entrypointPolicy = balancedObject(entrypoint, 'indexingPolicy:')
    const moduleContainer = fullCosmosModule.slice(
      fullCosmosModule.indexOf('resource connectorSourcesContainer'),
    )
    const modulePolicy = balancedObject(moduleContainer, 'indexingPolicy:')
    expect(normalized(entrypointPolicy)).toBe(normalized(modulePolicy))
  })

  it('pins only the approved replacement-tenant Cosmos names', () => {
    expect(parameters).toContain("using '../connector-sources.bicep'")
    expect(parameters).toContain("cosmosAccountName = 'cosmos-as-m098047'")
    expect(parameters).toContain("cosmosDatabaseName = 'agent-sentinel-db'")
    expect(parameters).not.toMatch(/subscription|tenant|client|secret|token/i)
  })
})

describe('replacement-tenant CI foundation parameters', () => {
  const foundation = rootFile('infra/ci-foundation.bicep')
  const parameters = rootFile(
    'infra/environments/mngenvmcap098047-ci-foundation.parameters.bicepparam',
  )
  const bootstrap = rootFile('scripts/bootstrap-runner.sh')

  it('derives the target VNet, build subnet, ACR, and runner identity from m098047', () => {
    expect(parameters).toContain("using '../ci-foundation.bicep'")
    expect(parameters).toContain("suffix = 'm098047'")
    expect(parameters).toContain("environment: 'replacement-validation'")
    expect(foundation).toContain("name: 'vnet-as-${suffix}'")
    expect(foundation).toContain("name: 'acr${suffix}'")
    expect(foundation).toContain("var buildSubnetId = '${existingVnet.id}/subnets/build'")
    expect(foundation).toContain("runnerIdentityName: 'id-ci-runner-${suffix}'")
    expect(bootstrap).toContain(
      'RUNNER_LABELS="${GH_RUNNER_LABELS:-self-hosted,linux,x64,agent-sentinel-private}"',
    )
    expect(bootstrap).toContain('--labels "${RUNNER_LABELS}"')
  })

  it('requires the SSH public key at invocation time and embeds no credentials', () => {
    expect(parameters).toContain(
      "adminSshPublicKey = readEnvironmentVariable('ADMIN_SSH_PUBLIC_KEY')",
    )
    expect(parameters).not.toMatch(/ssh-(?:rsa|ed25519)\s+/)
    expect(parameters).not.toMatch(/subscription|tenant|clientId|token|secret/i)
  })
})

describe('runtime instrumentation container dependency', () => {
  it.each(['api', 'jobs'])('ships the complete SDK dependency in the %s image', (component) => {
    const containerfile = rootFile(`apps/${component}/Containerfile`)
    const runtimeStart = containerfile.indexOf('FROM node:22-slim AS runtime')
    expect(runtimeStart).toBeGreaterThan(0)
    const builder = containerfile.slice(0, runtimeStart)
    const runtime = containerfile.slice(runtimeStart)
    const manifestCopy =
      'COPY packages/runtime-instrumentation/package.json packages/runtime-instrumentation/'
    expect(builder).toContain(manifestCopy)
    expect(builder.indexOf(manifestCopy)).toBeLessThan(
      builder.indexOf('RUN pnpm install --frozen-lockfile'),
    )
    const sdkBuild = 'RUN pnpm --filter @agent-sentinel/runtime-instrumentation build'
    expect(builder).toContain(sdkBuild)
    expect(builder.indexOf(sdkBuild)).toBeLessThan(
      builder.indexOf('RUN pnpm --filter @agent-sentinel/azure-monitor-otel-connector build'),
    )
    for (const artifact of ['dist', 'package.json', 'contract']) {
      const source = `/workspace/packages/runtime-instrumentation/${artifact}`
      expect(runtime).toContain(`COPY --from=builder ${source} `)
      expect(runtime.indexOf(source)).toBeLessThan(
        runtime.indexOf('RUN pnpm install --frozen-lockfile --prod'),
      )
    }
  })
})
