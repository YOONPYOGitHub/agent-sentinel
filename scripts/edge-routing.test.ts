import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

function rootFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
}

describe('public edge routing safety', () => {
  it('keeps the API internal and routes public API requests through web nginx', () => {
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const frontDoor = rootFile('infra/modules/frontdoor.bicep')
    const nginx = rootFile('apps/web/nginx.conf')

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
    expect(nginx).toContain('proxy_pass         http://api-as-260814;')
  })
})
