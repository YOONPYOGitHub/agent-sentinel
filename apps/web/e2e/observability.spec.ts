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
  await expect(page.getByText('Safe validations')).toBeVisible()
  await expect(page.getByText('Latest evidence observed')).toBeVisible()
  await expect(
    page.getByText(
      /Runtime latency, reliability, token, and cost remain insufficient until measured windows meet their evidence thresholds/i,
    ),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Open connector health' }).click()
  await expect(page.getByRole('heading', { name: 'Data connectors' })).toBeVisible()
})
