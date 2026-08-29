import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
}

describe('Teams distribution packaging and IaC safety gates', () => {
  it.each(['api', 'jobs'])('packages the connector in the %s image', (app) => {
    const packageJson = rootFile(`apps/${app}/package.json`)
    const containerfile = rootFile(`apps/${app}/Containerfile`)
    expect(packageJson).toContain('"@agent-sentinel/teams-distribution-connector": "workspace:*"')
    expect(containerfile).toContain('connectors/teams-distribution/package.json')
    expect(containerfile).toContain('@agent-sentinel/teams-distribution-connector build')
    expect(containerfile).toContain('connectors/teams-distribution/dist')
  })

  it('keeps IaC disabled and identifiers gated empty without app-role assignment', () => {
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const identity = rootFile('infra/modules/identity.bicep')
    const parameters = rootFile('infra/environments/dev.parameters.bicepparam')
    expect(platform).toContain('param teamsDistributionConnectorEnabled bool = false')
    expect(platform).toContain("param teamsDistributionSourcesJson string = ''")
    expect(parameters).toContain('param teamsDistributionConnectorEnabled = false')
    expect(containerApps).toContain(
      "value: teamsDistributionConnectorEnabled ? teamsDistributionSourcesJson : ''",
    )
    expect(containerApps).toContain(
      "value: teamsDistributionConnectorEnabled ? teamsDistributionTenantId : ''",
    )
    expect(containerApps).toContain(
      "value: teamsDistributionConnectorEnabled ? teamsDistributionEnvironment : ''",
    )
    expect(identity.toLowerCase()).not.toContain('appcatalog.read.all')
  })

  it('smoke-imports the connector in both CI images', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')
    expect(
      workflow.match(/import\('@agent-sentinel\/teams-distribution-connector'\)/g),
    ).toHaveLength(2)
  })
})
