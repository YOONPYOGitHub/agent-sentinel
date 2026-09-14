import { z } from 'zod'

export const AZURE_PROVIDER_RESOURCE_ID_MAX_LENGTH = 2_048

const azureResourceGroupNameSchema = z
  .string()
  .min(1)
  .max(90)
  .regex(/^[A-Za-z0-9_.()-]+$/)
  .refine((value) => !value.endsWith('.'), {
    message: 'Azure resource group names cannot end with a period.',
  })

const azureApplicationInsightsComponentNameSchema = z
  .string()
  .min(1)
  .max(260)
  .refine((value) => !/[%&\\?/#\p{Cc}]/u.test(value), {
    message:
      'Application Insights component names cannot contain %, &, \\, ?, /, #, or control characters.',
  })
  .refine((value) => !value.endsWith(' ') && !value.endsWith('.'), {
    message: 'Application Insights component names cannot end with a space or period.',
  })

export const azureApplicationInsightsResourceIdSchema = z
  .string()
  .min(1)
  .max(AZURE_PROVIDER_RESOURCE_ID_MAX_LENGTH)
  .refine((value) => value === value.trim(), {
    message: 'Application Insights resource IDs cannot contain surrounding whitespace.',
  })
  .superRefine((value, context) => {
    const match =
      /^\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Insights\/components\/([^/]+)$/iu.exec(
        value,
      )
    if (match === null) {
      context.addIssue({
        code: 'custom',
        message: 'Expected an exact Application Insights ARM resource ID.',
      })
      return
    }
    const resourceGroup = match[2]
    const component = match[3]
    if (
      resourceGroup === undefined ||
      !azureResourceGroupNameSchema.safeParse(resourceGroup).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['resourceGroup'],
        message: 'Invalid Azure resource group name segment.',
      })
    }
    if (
      component === undefined ||
      !azureApplicationInsightsComponentNameSchema.safeParse(component).success
    ) {
      context.addIssue({
        code: 'custom',
        path: ['component'],
        message: 'Invalid Application Insights component name segment.',
      })
    }
  })
  .transform((value) => value.toLowerCase())

export type AzureApplicationInsightsResourceId = z.infer<
  typeof azureApplicationInsightsResourceIdSchema
>
