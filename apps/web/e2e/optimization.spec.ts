import { expect, test } from '@playwright/test'

test('optimization ranks bounded recommendations and opens simulation', async ({ page }) => {
  await page.goto('/optimization')
  await expect(
    page.getByRole('heading', { name: 'Evidence-backed recommendations', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Recommendation scope is bounded by available evidence'),
  ).toBeVisible()
  await expect(
    page.getByText(
      /Latency, reliability, quality, adoption, and sustainability recommendations are unavailable/i,
    ),
  ).toBeVisible()
  await expect(
    page.getByText(/Token economics data is available in synthetic demonstration mode/i),
  ).toBeVisible()

  await page
    .getByRole('combobox', { name: 'Filter recommendations by priority' })
    .selectOption('critical')
  const recommendation = page.locator('.recommendation-card').first()
  await expect(recommendation.getByText('Simulation available')).toBeVisible()
  await recommendation.getByRole('link', { name: 'Preview response' }).click()
  await expect(page.getByRole('heading', { name: 'Affected attack path' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Preview response' })).toBeVisible()
})
