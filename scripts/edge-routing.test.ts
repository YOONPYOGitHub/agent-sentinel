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

    expect(containerApps).toMatch(
      /\{\s*slug:\s*'api',\s*containerName:\s*'agent-sentinel-api',\s*imageDigest:\s*apiImageDigest,\s*ingressEnabled:\s*true,\s*externalIngress:\s*false/,
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

  it('smoke-tests the active Front Door endpoint returned by deployment', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')

    expect(workflow).toContain('frontDoorHost:frontDoorEndpointHostName.value')
    expect(workflow).toContain('/api/connector/status')
    expect(workflow).toContain('"https://${FRONT_DOOR_HOST}${path}"')
    expect(workflow).not.toContain('4.230.67.93')
    expect(workflow).not.toContain('Smoke test - App Gateway')
  })

  it('pins manual releases to one validated full commit SHA without shell interpolation', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')

    expect(workflow).toContain('commitSha:')
    expect(workflow).not.toContain("description: 'Git SHA to tag images")
    expect(workflow).toContain('^[0-9a-fA-F]{40}$')
    expect(workflow).toContain('NORMALIZED_SHA="${REQUESTED_SHA,,}"')
    expect(workflow).toContain(
      "REQUESTED_SHA: ${{ github.event_name == 'workflow_dispatch' && inputs.commitSha || github.sha }}",
    )
    expect(workflow.match(/\$\{\{[^}]*inputs\.commitSha[^}]*\}\}/g)).toHaveLength(1)
    expect(workflow.match(/ref: \$\{\{ needs\.resolve\.outputs\.commitSha \}\}/g)).toHaveLength(4)
    expect(workflow).toContain('HEAD_SHA="$(git rev-parse HEAD)"')
    expect(workflow).toContain('echo "IMAGE_TAG=${EXPECTED_SHA}" >> "${GITHUB_ENV}"')
    expect(workflow).not.toContain('SHORT_TAG')
    expect(workflow).not.toContain('${TAG:0:7}')
    expect(workflow).toContain('--image "${repository}:${IMAGE_TAG}"')
    expect(workflow).toContain('^sha256:[0-9a-f]{64}$')
    expect(workflow).not.toContain('-p imageTag=')
    expect(workflow.match(/-p webImageDigest="\$\{WEB_IMAGE_DIGEST\}"/g)).toHaveLength(2)
    expect(workflow.match(/-p apiImageDigest="\$\{API_IMAGE_DIGEST\}"/g)).toHaveLength(2)
    expect(workflow.match(/-p jobsImageDigest="\$\{JOBS_IMAGE_DIGEST\}"/g)).toHaveLength(2)
  })

  it('deploys private ACR images by component digest and verifies active revisions', () => {
    const workflow = rootFile('.github/workflows/ci-build-deploy.yml')
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')

    expect(containerApps).toContain(
      "image: format('{0}/{1}@{2}', acrLoginServer, app.containerName, app.imageDigest)",
    )
    expect(containerApps).not.toContain("image: format('{0}/{1}:{2}'")
    expect(platform).toContain('webImageDigest: webImageDigest')
    expect(platform).toContain('apiImageDigest: apiImageDigest')
    expect(platform).toContain('jobsImageDigest: jobsImageDigest')
    expect(workflow).toContain('Verify active revision image digests')
    expect(workflow).toContain('az containerapp revision list')
    expect(workflow).toContain('az containerapp revision show')
    expect(workflow).toContain('${ACR_LOGIN_SERVER}/agent-sentinel-web@${WEB_IMAGE_DIGEST}')
    expect(workflow).toContain('${ACR_LOGIN_SERVER}/agent-sentinel-api@${API_IMAGE_DIGEST}')
    expect(workflow).toContain('${ACR_LOGIN_SERVER}/agent-sentinel-jobs@${JOBS_IMAGE_DIGEST}')
    expect(workflow).not.toMatch(/(?:docker\.io|mcr\.microsoft\.com)\/agent-sentinel-/)
  })

  it('keeps live connector reads distinct from the synthetic validation portfolio', () => {
    const readme = rootFile('README.md')

    expect(readme).toContain('live bounded provider reads')
    expect(readme).toContain('six purpose-built synthetic validation agents')
    expect(readme).toContain('Live provider execution over synthetic probes')
    expect(readme).not.toContain(
      'Agent 365 · Defender · Purview · Teams catalog<br/>(implemented; activation pending)',
    )
  })

  it('documents full-SHA private image builds and digest verification', () => {
    const deployment = rootFile('docs/deployment.md')
    const supplyChain = rootFile('docs/supply-chain.md')

    expect(deployment).not.toContain('git rev-parse --short')
    expect(deployment).not.toContain('--public-network-enabled true')
    expect(supplyChain).toContain('full 40-hex commit SHA')
    expect(supplyChain).toContain('canonical SHA-256 digest')
    expect(supplyChain).not.toContain('<7-char-SHA>')
    expect(supplyChain).not.toContain('show-tags')
  })

  it('keeps the Prettier ignore file normalized', () => {
    const prettierIgnore = rootFile('.prettierignore')
    const attributes = rootFile('.gitattributes')

    expect(prettierIgnore).not.toContain('\r')
    expect(prettierIgnore).toMatch(/\n$/)
    expect(prettierIgnore.split('\n').every((line) => !/[ \t]$/.test(line))).toBe(true)
    expect(attributes).toContain('/.prettierignore text eol=lf')
  })

  it('serializes Foundry model deployments on the shared account', () => {
    const foundry = rootFile('infra/modules/foundry.bicep')

    expect(foundry).toMatch(/resource advisoryModel[\s\S]*?dependsOn:\s*\[\s*embedding\s*\]/)
  })

  it('derives replacement-tenant names while preserving explicit existing names', () => {
    const platform = rootFile('infra/platform.bicep')
    const parameters = rootFile('infra/environments/dev.parameters.bicepparam')
    const replacementParameters = rootFile(
      'infra/environments/mngenvmcap098047.parameters.bicepparam',
    )
    const replacementFoundryParameters = rootFile(
      'infra/environments/mngenvmcap098047-foundry.parameters.bicepparam',
    )
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
    for (const parameterFile of [parameters, replacementParameters]) {
      expect(parameterFile).toContain(
        "param webImageDigest = readEnvironmentVariable('WEB_IMAGE_DIGEST')",
      )
      expect(parameterFile).toContain(
        "param apiImageDigest = readEnvironmentVariable('API_IMAGE_DIGEST')",
      )
      expect(parameterFile).toContain(
        "param jobsImageDigest = readEnvironmentVariable('JOBS_IMAGE_DIGEST')",
      )
      expect(parameterFile).not.toContain('param imageTag')
    }
    expect(replacementParameters).toContain("suffix = 'm098047'")
    expect(replacementParameters).toContain(
      "foundryTenantId = 'ef7d55d6-c61d-4085-9064-4e83adf15ee3'",
    )
    expect(replacementParameters).toContain('agentSentinelWriteEnabled = false')
    expect(replacementParameters).toContain("authMode = 'disabled'")
    expect(replacementParameters).toContain('entraConnectorEnabled = true')
    expect(replacementParameters).toContain('purviewConnectorEnabled = true')
    expect(replacementParameters).toContain('teamsDistributionConnectorEnabled = true')
    expect(replacementParameters).toContain('defenderCloudAppsConnectorEnabled = true')
    expect(replacementParameters).toContain('mngenvmcap098047.us2.portal.cloudappsecurity.com')
    expect(replacementParameters).toContain('azureResourceGraphConnectorEnabled = true')
    expect(replacementParameters).toContain('azureMonitorConnectorEnabled = true')
    expect(replacementParameters).not.toContain('4dfc2b10-8eb6-4454-a9ee-9f337141b596')
    expect(replacementParameters).not.toContain('applicationIdentityName')
    expect(replacementParameters).not.toContain('connectorIdentityName')
    expect(replacementParameters).not.toContain('teamsIdentityName')
    expect(replacementParameters).not.toContain('foundryAccountName')
    expect(replacementFoundryParameters).toContain("suffix = 'm098047'")
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

  it('wires the approved Agent 365 UAMI only into API and jobs deployment configuration', () => {
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const replacementParameters = rootFile(
      'infra/environments/mngenvmcap098047.parameters.bicepparam',
    )

    expect(platform).toContain('param agent365ManagedIdentityClientId string')
    expect(platform).toContain('agent365ManagedIdentityClientId: agent365ManagedIdentityClientId')
    expect(containerApps).toContain('param agent365ManagedIdentityClientId string')
    expect(containerApps).toContain("name: 'AGENT365_MANAGED_IDENTITY_CLIENT_ID'")
    expect(containerApps).toMatch(
      /env:\s*concat\(\s*env,\s*app\.slug == 'web'\s*\?\s*\[\]\s*:\s*backendRuntimeEnv\s*\)/,
    )
    expect(replacementParameters).toContain(
      "param agent365ManagedIdentityClientId = '59dbea72-1e91-403a-89cf-e02cdb8da350'",
    )
    expect(replacementParameters).not.toMatch(/agent365SourcesJson\s*=.*managedIdentityClientId/)
  })

  it('validates and projects explicit Entra RUNS_AS authority only to API and jobs', () => {
    const platform = rootFile('infra/platform.bicep')
    const containerApps = rootFile('infra/modules/container-apps.bicep')
    const replacementParameters = rootFile(
      'infra/environments/mngenvmcap098047.parameters.bicepparam',
    )

    expect(platform).toContain('param entraRunsAsBindingsJson string')
    expect(platform).toContain(
      'validatedEntraRunsAsBindingsJson = string(empty(entraRunsAsBindingsJson) ? [] : json(entraRunsAsBindingsJson))',
    )
    expect(platform).toContain('entraRunsAsBindingsJson: validatedEntraRunsAsBindingsJson')
    expect(containerApps).toContain('param entraRunsAsBindingsJson string')
    expect(containerApps).toMatch(
      /var backendRuntimeEnv = \[.*name: 'ENTRA_RUNS_AS_BINDINGS_JSON'.*value: entraRunsAsBindingsJson.*\]/s,
    )
    expect(containerApps).toMatch(
      /env:\s*concat\(\s*env,\s*app\.slug == 'web'\s*\?\s*\[\]\s*:\s*backendRuntimeEnv\s*\)/,
    )
    expect(replacementParameters).toContain('"estateId":"default"')
    expect(replacementParameters).toContain('"sourceId":"foundry:primary"')
    expect(replacementParameters).toContain('"sourceObjectId":"agent-sentinel-pjt"')
    expect(replacementParameters).toContain('"sourceId":"entra:primary"')
    expect(replacementParameters).toContain(
      '"sourceObjectId":"ef7d55d6-c61d-4085-9064-4e83adf15ee3"',
    )
  })
})
