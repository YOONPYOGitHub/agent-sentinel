import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const workflow = readFileSync(
  new URL('../.github/workflows/ci-build-deploy.yml', import.meta.url),
  'utf8',
)

describe('private deployment workflow configuration', () => {
  it('uses validated repository variables instead of historical deployment values', () => {
    for (const variable of [
      'vars.AZURE_RESOURCE_GROUP',
      'vars.AZURE_SUBSCRIPTION_ID',
      'vars.ACR_NAME',
      'vars.RUNNER_UAMI_CLIENT_ID',
      'vars.PRIVATE_RUNNER_LABEL',
    ]) {
      expect(workflow).toContain(variable)
    }

    expect(workflow).not.toContain('RG: rg-agent-sentinel')
    expect(workflow).not.toContain('ACR_NAME: acr260814')
    expect(workflow).not.toContain('feb1bf96-738d-4b5c-8b75-4b617bbe9f93')
    expect(workflow).not.toContain('-p infra/environments/dev.parameters.bicepparam')
    expect(workflow).not.toContain("az account list --query '[0].id'")
    expect(
      workflow.match(
        /runs-on: \[self-hosted, linux, x64, '\$\{\{ vars\.PRIVATE_RUNNER_LABEL \}\}'\]/g,
      ),
    ).toHaveLength(5)
  })

  it('defaults to no target and no deployment and requires environment approval', () => {
    expect(workflow).toMatch(
      /targetEnvironment:[\s\S]*?default: 'none'[\s\S]*?options:[\s\S]*?- 'none'[\s\S]*?- 'replacement-validation'/,
    )
    expect(workflow).toMatch(
      /parameterFile:[\s\S]*?default: 'none'[\s\S]*?- 'infra\/environments\/mngenvmcap098047\.parameters\.bicepparam'/,
    )
    expect(workflow).toMatch(/deployPlatform:[\s\S]*?default: 'false'/)
    expect(workflow).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.deployPlatform == 'true' && inputs.targetEnvironment != 'none'",
    )
    expect(workflow).toContain('environment: ${{ inputs.targetEnvironment }}')
    expect(workflow).toContain('Configure required reviewers before enabling deployment')
  })

  it('allowlists the replacement parameter file and rejects traversal or mismatched ACR', () => {
    expect(workflow).toContain(
      'replacement-validation:infra/environments/mngenvmcap098047.parameters.bicepparam)',
    )
    expect(workflow).toContain('if [ "${ACR_NAME}" != \'acrm098047\' ]')
    expect(workflow).toContain('unapproved target environment or parameter file')
    expect(workflow).toContain('"${PLATFORM_PARAMETER_FILE}" == *\'..\'*')
    expect(workflow).toContain('parameter file path traversal is forbidden')
    expect(workflow).toContain("'^[a-z0-9]{5,50}$'")
    expect(workflow).toContain("'^[A-Za-z0-9._-]{1,63}$'")
  })

  it('preserves immutable SHA, digest, what-if, and protected deployment controls', () => {
    expect(workflow).toContain('^[0-9a-fA-F]{40}$')
    expect(workflow).toContain('HEAD_SHA="$(git rev-parse HEAD)"')
    expect(workflow).toContain('--image "${repository}:${IMAGE_TAG}"')
    expect(workflow).toContain('^sha256:[0-9a-f]{64}$')
    expect(workflow).toContain('az deployment group what-if')
    expect(workflow).toContain('--result-format FullResourcePayloads')
    expect(workflow).toContain('az deployment group create')
    expect(workflow).toContain('--rollback-on-error')
    expect(workflow).toContain('-p "${PLATFORM_PARAMETER_FILE}"')
    expect(workflow.match(/ref: \$\{\{ needs\.resolve\.outputs\.commitSha \}\}/g)).toHaveLength(4)
  })
})
