import { buildAuthLiveValidationConfig, runAuthLiveValidation } from './auth-live-validation.js'

try {
  const config = buildAuthLiveValidationConfig()
  const result = await runAuthLiveValidation(config)
  console.log(
    `Authentication validation passed: anonymous=${String(result.anonymousStatus)}, insufficient-role=${String(result.insufficientRoleStatus)}, roles=${result.rolesValidated.join(',')}${result.deploymentStatusValidated === true ? ', deployment-status=validated' : ''}${result.redirectConfigurationValidated === true ? ', redirect-config=validated' : ''}${result.writeStatus === undefined ? '' : `, anonymous-write=${String(result.anonymousWriteStatus)}, authorized-write=${String(result.writeStatus)}`}.`,
  )
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : 'Authentication validation failed.')
  process.exitCode = 1
}
