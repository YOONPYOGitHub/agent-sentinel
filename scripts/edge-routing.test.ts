import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('public edge routing safety', () => {
  it('keeps the API internal and routes public API requests through web nginx', () => {
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const frontDoor = rootFile('infra/modules/frontdoor.bicep')
    const nginx = rootFile('apps/web/nginx.conf.template')
    const webContainerfile = rootFile('apps/web/Containerfile')

    expect(containerApps).toContain(
      "{ slug: 'api',  containerName: 'agent-sentinel-api',  ingressEnabled: true,  externalIngress: false",
    )
    expect(frontDoor).not.toContain('apiOriginHostName')
    expect(frontDoor).not.toContain("name: 'og-api'")
    expect(frontDoor).not.toContain("name: 'aca-api'")
    expect(frontDoor).not.toContain('resource apiRoute')
    expect(frontDoor).toContain("name: 'agent-sentinel'")
    expect(frontDoor).toContain("name: 'diagnostic-web'")
    expect(frontDoor).toMatch(
      /resource webRoute[\s\S]*?originGroup:\s*\{\s*id: webOriginGroup\.id\s*\}[\s\S]*?patternsToMatch:\s*\[\s*'\/\*'\s*\]/,
    )
    expect(nginx).toContain('proxy_pass         http://${API_UPSTREAM};')
    expect(webContainerfile).toContain('NGINX_ENVSUBST_FILTER=^API_UPSTREAM$')
    expect(containerApps).toContain("{ name: 'API_UPSTREAM',")
  })

  it('derives replacement-tenant names while preserving explicit existing names', () => {
    const platform = rootFile('infra/platform.bicep')
    const parameters = rootFile('infra/environments/dev.parameters.bicepparam')
    const identity = rootFile('infra/modules/identity.bicep')
    const postgres = rootFile('infra/modules/postgres.bicep')
    const ci = rootFile('infra/ci-foundation.bicep')
    const foundry = rootFile('infra/main.bicep')
    const advisoryModel = rootFile('infra/advisory-model.bicep')

    expect(platform).toContain(
      "effectiveApplicationIdentityName = empty(applicationIdentityName) ? 'id-agent-sentinel-${suffix}'",
    )
    expect(platform).toContain(
      "effectiveFoundryAccountName = empty(foundryAccountName) ? 'ais-agent-sentinel-${suffix}'",
    )
    expect(parameters).toContain("connectorIdentityName = 'id-agent-sentinel-connectors-260829'")
    expect(identity).not.toContain("name: 'id-agent-sentinel-260814'")
    expect(postgres).not.toContain("principalName: 'id-agent-sentinel-260814'")
    expect(ci).toContain("runnerIdentityName: 'id-ci-runner-${suffix}'")
    expect(foundry).toContain(
      "effectiveAccountName = empty(accountName) ? 'ais-agent-sentinel-${suffix}'",
    )
    expect(advisoryModel).toContain(
      "effectiveAccountName = empty(accountName) ? 'ais-agent-sentinel-${suffix}'",
    )
  })
})
