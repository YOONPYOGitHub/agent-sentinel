import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
}

describe('Purview packaging and IaC safety gates', () => {
  it.each(['api', 'jobs'])('packages the connector in the %s image', (app) => {
    const packageJson = rootFile(`apps/${app}/package.json`)
    const containerfile = rootFile(`apps/${app}/Containerfile`)
    expect(packageJson).toContain('"@agent-sentinel/purview-connector": "workspace:*"')
    expect(containerfile).toContain('connectors/purview/package.json')
    expect(containerfile).toContain('@agent-sentinel/purview-connector build')
    expect(containerfile).toContain('connectors/purview/dist')
  })

  it('keeps IaC disabled and source identifiers gated empty without app-role assignment', () => {
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const identity = rootFile('infra/modules/identity.bicep')
    const parameters = rootFile('infra/environments/dev.parameters.bicepparam')
    expect(platform).toContain('param purviewConnectorEnabled bool = false')
    expect(platform).toContain("param purviewSourcesJson string = ''")
    expect(parameters).toContain('param purviewConnectorEnabled = false')
    expect(containerApps).toContain(
      "value: purviewConnectorEnabled ? effectivePurviewSourcesJson : ''",
    )
    expect(containerApps).toContain('managedIdentityClientId: connectorUamiClientId')
    expect(containerApps).toContain("value: purviewConnectorEnabled ? purviewTenantId : ''")
    expect(containerApps).toContain("value: purviewConnectorEnabled ? purviewEnvironment : ''")
    expect(identity.toLowerCase()).not.toContain('sensitivitylabel.read')
    expect(identity.toLowerCase()).not.toContain('3b8e7aad-f6e3-4299-83f8-6fc6a5777f0b')
  })

  it('smoke-imports the connector in both CI images', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')
    expect(workflow.match(/import\('@agent-sentinel\/purview-connector'\)/g)).toHaveLength(2)
  })
})
