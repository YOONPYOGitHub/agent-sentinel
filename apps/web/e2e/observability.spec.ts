import { expect, test } from '@playwright/test'

test('observability reports only available evidence operations', async ({ page }) => {
  await page.goto('/observability')
  await expect(page.getByRole('heading', { name: 'Evidence operations' })).toBeVisible()
  await expect(page.getByText('Evidence observability, not runtime APM')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Evidence health by source system' }),
  ).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Validation and evidence timeline' }),
  ).toBeVisible()
  await expect(page.getByText('No validation run recorded')).toBeVisible()
  await expect(
    page.getByText(
      /Runtime latency, reliability, token, and cost telemetry are not yet connected/i,
    ),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open connector health' }).click()
  await expect(page.getByRole('heading', { name: 'Connector health' })).toBeVisible()
})
