import { describe, expect, it } from 'vitest'

import { deploymentStatus } from '../src/deployment-status.js'

describe('deploymentStatus', () => {
  it('returns only validated immutable metadata', () => {
    const status = deploymentStatus(
      {
        AGENT_SENTINEL_BUILD_SHA: 'a'.repeat(40),
        AGENT_SENTINEL_WEB_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
        AGENT_SENTINEL_API_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}`,
        AGENT_SENTINEL_JOBS_IMAGE_DIGEST: `sha256:${'d'.repeat(64)}`,
        CONTAINER_APP_REVISION: 'api--revision-1',
        AUTH_MODE: 'jwt',
        AGENT_SENTINEL_WRITE_ENABLED: 'false',
        PRIVATE_TOKEN: 'must-not-appear',
      },
      '2026-09-12T00:00:00.000Z',
    )

    expect(status).toEqual({
      status: 'ok',
      service: 'agent-sentinel-api',
      observedAt: '2026-09-12T00:00:00.000Z',
      revision: 'api--revision-1',
      security: { authMode: 'jwt', writeEnabled: false },
      components: {
        web: { sha: 'a'.repeat(40), digest: `sha256:${'b'.repeat(64)}` },
        api: { sha: 'a'.repeat(40), digest: `sha256:${'c'.repeat(64)}` },
        jobs: { sha: 'a'.repeat(40), digest: `sha256:${'d'.repeat(64)}` },
      },
    })
    expect(JSON.stringify(status)).not.toContain('must-not-appear')
  })

  it('omits malformed metadata instead of reflecting it', () => {
    const status = deploymentStatus({
      AGENT_SENTINEL_BUILD_SHA: 'latest',
      AGENT_SENTINEL_API_IMAGE_DIGEST: 'registry/private/image',
      CONTAINER_APP_REVISION: 'bad revision with spaces',
    })
    expect(status.revision).toBeUndefined()
    expect(status.security).toEqual({ authMode: 'unknown', writeEnabled: null })
    expect(status.components.api).toEqual({})
  })
})
