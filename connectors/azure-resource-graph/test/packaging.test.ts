import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
}

describe('Azure Resource Graph packaging and IaC safety gates', () => {
  it.each(['api', 'jobs'])('packages the connector in the %s image', (app) => {
    const packageJson = rootFile(`apps/${app}/package.json`)
    const containerfile = rootFile(`apps/${app}/Containerfile`)
    expect(packageJson).toContain('"@agent-sentinel/azure-resource-graph-connector": "workspace:*"')
    expect(containerfile).toContain('connectors/azure-resource-graph/package.json')
    expect(containerfile).toContain('@agent-sentinel/azure-resource-graph-connector build')
    expect(containerfile).toContain('connectors/azure-resource-graph/dist')
  })

  it('keeps IaC disabled and does not add a broad Reader assignment', () => {
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const identity = rootFile('infra/modules/identity.bicep')
    const parameters = rootFile('infra/environments/dev.parameters.bicepparam')

    expect(platform).toContain('param azureResourceGraphConnectorEnabled bool = false')
    expect(parameters).toContain('param azureResourceGraphConnectorEnabled = false')
    expect(containerApps).toContain(
      "value: azureResourceGraphConnectorEnabled ? effectiveAzureResourceGraphSourcesJson : ''",
    )
    expect(containerApps).toContain('managedIdentityClientId: uamiClientId')
    expect(identity).not.toContain(
      "subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'acdd72a7-3385-48ef-bd42-f606fba81ae7')",
    )
  })

  it('smoke-imports the connector in both CI images', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')
    expect(
      workflow.match(/import\('@agent-sentinel\/azure-resource-graph-connector'\)/g),
    ).toHaveLength(2)
  })
})
