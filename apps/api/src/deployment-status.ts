const SHA_PATTERN = /^[0-9a-f]{40}$/i
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/i
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

export interface DeploymentComponentVersion {
  readonly sha?: string
  readonly digest?: string
}

export interface DeploymentStatus {
  readonly status: 'ok'
  readonly service: 'agent-sentinel-api'
  readonly observedAt: string
  readonly revision?: string
  readonly components: {
    readonly web: DeploymentComponentVersion
    readonly api: DeploymentComponentVersion
    readonly jobs: DeploymentComponentVersion
  }
}

function matching(
  value: string | undefined,
  pattern: RegExp,
  normalize = false,
): string | undefined {
  const candidate = value?.trim()
  if (candidate === undefined || !pattern.test(candidate)) return undefined
  return normalize ? candidate.toLowerCase() : candidate
}

function component(
  env: NodeJS.ProcessEnv,
  name: 'WEB' | 'API' | 'JOBS',
): DeploymentComponentVersion {
  const sharedSha = matching(env['AGENT_SENTINEL_BUILD_SHA'], SHA_PATTERN, true)
  const sha = matching(env[`AGENT_SENTINEL_${name}_SHA`], SHA_PATTERN, true) ?? sharedSha
  const digest = matching(env[`AGENT_SENTINEL_${name}_IMAGE_DIGEST`], DIGEST_PATTERN, true)
  return {
    ...(sha === undefined ? {} : { sha }),
    ...(digest === undefined ? {} : { digest }),
  }
}

export function deploymentStatus(
  env: NodeJS.ProcessEnv = process.env,
  observedAt = new Date().toISOString(),
): DeploymentStatus {
  const revision = matching(env['CONTAINER_APP_REVISION'], REVISION_PATTERN)
  return {
    status: 'ok',
    service: 'agent-sentinel-api',
    observedAt,
    ...(revision === undefined ? {} : { revision }),
    components: {
      web: component(env, 'WEB'),
      api: component(env, 'API'),
      jobs: component(env, 'JOBS'),
    },
  }
}
